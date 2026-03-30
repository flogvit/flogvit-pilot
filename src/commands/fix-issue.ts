import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile, unlink } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  createPullRequest,
  addPRLabel,
  extractPRNumber,
  formatIssueComment,
  parseBranchName,
  LABELS,
  type Issue,
} from "../lib/github";
import { createWorktree, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { saveState, loadState, clearState } from "../lib/state";
import { Logger } from "../lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ToolOutputResult {
  status: "done" | "stuck" | "unknown";
  message: string;
}

export function parseToolOutput(output: string): ToolOutputResult {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("FLOGVIT-CODER:DONE:")) {
      return { status: "done", message: line.replace("FLOGVIT-CODER:DONE:", "") };
    }
    if (line.startsWith("FLOGVIT-CODER:STUCK:")) {
      return { status: "stuck", message: line.replace("FLOGVIT-CODER:STUCK:", "") };
    }
  }
  return { status: "unknown", message: "" };
}

export function buildIssueCommentsSection(
  comments: { body: string; author: string; createdAt: string }[]
): string {
  if (comments.length === 0) return "";

  const lines = comments.map(
    (c) => `**${c.author}** (${c.createdAt}):\n${c.body}`
  );
  return `## Comments\n\n${lines.join("\n\n---\n\n")}`;
}

export async function fixIssue(
  issueNum: number,
  config: Config,
  cwd: string,
  verbose: boolean = false,
  retryModel?: string
): Promise<{ success: boolean; prUrl?: string }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoContext = await gatherRepoContext(cwd);
  const logger = new Logger({ logDir, repoName: repoContext.repoName, command: "fix-issue", verbose });

  // Load existing state to track attempt count across retries
  const existingFixState = await loadState(stateDir, repoContext.repoName, issueNum);
  const fixAttempts = (existingFixState?.fixAttempts ?? 0) + 1;

  // Fetch issue
  const issue = await getIssue(issueNum, cwd);
  await addLabel(issueNum, LABELS.inProgress, cwd);

  const repoName = basename(cwd);
  const branch = parseBranchName("fix", issueNum);
  const wtPath = worktreePath(homeDir, repoName, `fix-${issueNum}`);

  // Clean up label and worktree if process is interrupted
  const cleanup = async () => {
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // Build prompt
  const template = await loadTemplate("fix-issue", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_num: String(issue.number),
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    language: repoContext.language,
    repo_name: repoContext.repoName,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    file_structure: repoContext.fileStructure,
  });

  // Create worktree on a new branch
  await createWorktree(wtPath, branch, cwd);

  // Run AI tool
  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};
  const model = retryModel ?? (toolConfig.model as string | undefined);

  logger.detail(`Running ${toolName} for issue #${issueNum}`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  let result: Awaited<ReturnType<typeof tool.run>>;
  try {
    result = await tool.run({
      prompt,
      cwd: wtPath,
      jobName: `fix-issue-${issueNum}`,
      fallbackApiKey: config.defaults.fallback_api_key,
      verbose,
      model,
      onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
      maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
      allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
    });
  } catch (err) {
    // Tool crashed (e.g. max turns, network error) — clean up and mark as stuck
    await removeWorktree(wtPath, cwd).catch(() => {});
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    await saveState(stateDir, repoContext.repoName, issueNum, {
      issueNumber: issueNum,
      command: "fix-issue",
      branch: null,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
      fixAttempts,
    });
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(issueNum, formatIssueComment("waiting", `Agent krasjet (${String(err).slice(0, 120)}). Prøver igjen automatisk.`), cwd);
    logger.summary(`Issue #${issueNum}: tool crashed — ${String(err).slice(0, 120)}`);
    return { success: false };
  }

  logger.detail(result.output);
  await logger.flush();

  const parsed = parseToolOutput(result.output);

  // Check if there are actual changes — either uncommitted or already committed (agent committed manually)
  const diffResult = await $`git status --porcelain`.cwd(wtPath).text();
  const hasUncommitted = diffResult.trim().length > 0;
  const commitsAhead = await $`git log ${repoContext.defaultBranch}..HEAD --oneline`.cwd(wtPath).nothrow().text();
  const hasChanges = hasUncommitted || commitsAhead.trim().length > 0;

  if (parsed.status === "stuck" || (!hasChanges && parsed.status !== "done")) {
    // Agent is stuck or made no changes
    const question = parsed.message || "Could not determine how to fix this issue. Please provide more details.";

    await removeWorktree(wtPath, cwd).catch(() => {});

    await saveState(stateDir, repoContext.repoName, issueNum, {
      issueNumber: issueNum,
      command: "fix-issue",
      branch: hasChanges ? branch : null,
      agentSummary: result.summary,
      question,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
      fixAttempts,
    });

    await commentOnIssue(
      issueNum,
      formatIssueComment("waiting", question),
      cwd
    );
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);

    logger.summary(`Issue #${issueNum}: stuck — asked question on issue`);
    return { success: false };
  }

  if (!hasChanges) {
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await removeWorktree(wtPath, cwd);
    // Delete plan file if exists
    const noChangesState = await loadState(stateDir, repoContext.repoName, issueNum);
    if (noChangesState?.planFile) {
      await unlink(resolve(cwd, noChangesState.planFile)).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
    }
    logger.summary(`Issue #${issueNum}: no changes made`);
    return { success: false };
  }

  // Commit (if uncommitted changes remain) then push
  if (hasUncommitted) {
    await $`git add -A`.cwd(wtPath);
    await $`git restore --staged .claude/worktrees`.cwd(wtPath).nothrow();
    await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(wtPath);
  }
  await $`git push -u origin ${branch}`.cwd(wtPath);

  const prUrl = await createPullRequest(
    {
      title: `Fix #${issueNum}: ${issue.title}`,
      body: `## Summary\n\nAutomatically fixes #${issueNum}.\n\n${parsed.message || result.summary}\n\n---\n🤖 Generated by flogvit-coder`,
      base: repoContext.defaultBranch,
    },
    cwd
  );

  const prNumber = extractPRNumber(prUrl);
  await addPRLabel(prNumber, LABELS.needsVerify, cwd);

  await removeWorktree(wtPath, cwd);
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removeLabel(issueNum, LABELS.inProgress, cwd);

  // Delete plan file before clearing state
  const finalState = await loadState(stateDir, repoContext.repoName, issueNum);
  if (finalState?.planFile) {
    await unlink(resolve(cwd, finalState.planFile)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
  await clearState(stateDir, repoContext.repoName, issueNum);

  logger.summary(`Issue #${issueNum}: PR created — ${prUrl}`);
  return { success: true, prUrl };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-coder fix-issue <issue-number>");
    process.exit(1);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  const retryModelIndex = args.indexOf("--retry-model");
  const retryModel = retryModelIndex !== -1 ? args[retryModelIndex + 1] : undefined;
  await fixIssue(issueNum, config, cwd, verbose, retryModel);
}
