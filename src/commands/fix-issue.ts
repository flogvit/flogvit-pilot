import { $ } from "bun";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  createPullRequest,
  mergePullRequest,
  formatIssueComment,
  parseBranchName,
  LABELS,
  type Issue,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { saveState, clearState } from "../lib/state";
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
  verbose: boolean = false
): Promise<{ success: boolean; prUrl?: string }> {
  const homeDir = process.env.HOME ?? "~";
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoContext = await gatherRepoContext(cwd);
  const logger = new Logger({ logDir, repoName: repoContext.repoName, command: "fix-issue", verbose });

  // Fetch issue
  const issue = await getIssue(issueNum, cwd);
  await addLabel(issueNum, LABELS.inProgress, cwd);

  // Clean up label if process is interrupted
  const cleanup = async () => {
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
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

  // Create branch
  const branch = parseBranchName("fix", issueNum);
  await $`git checkout -b ${branch}`.cwd(cwd);

  // Run AI tool
  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for issue #${issueNum}`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `fix-issue-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  const parsed = parseToolOutput(result.output);

  // Check if there are actual changes
  const diffResult = await $`git diff --stat`.cwd(cwd).text();
  const hasChanges = diffResult.trim().length > 0;

  if (parsed.status === "stuck" || (!hasChanges && parsed.status !== "done")) {
    // Agent is stuck or made no changes
    const question = parsed.message || "Could not determine how to fix this issue. Please provide more details.";

    await saveState(stateDir, repoContext.repoName, issueNum, {
      issueNumber: issueNum,
      command: "fix-issue",
      branch: hasChanges ? branch : null,
      agentSummary: result.summary,
      question,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    });

    await commentOnIssue(
      issueNum,
      formatIssueComment("waiting", question),
      cwd
    );
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);

    // Go back to default branch if no changes
    if (!hasChanges) {
      await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);
      await $`git branch -D ${branch}`.cwd(cwd).nothrow();
    }

    logger.summary(`Issue #${issueNum}: stuck — asked question on issue`);
    return { success: false };
  }

  if (!hasChanges) {
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);
    await $`git branch -D ${branch}`.cwd(cwd).nothrow();
    logger.summary(`Issue #${issueNum}: no changes made`);
    return { success: false };
  }

  // Commit, push, create PR
  // Exclude .claude/worktrees — Claude Code may create worktrees during the run
  await $`git add -A`.cwd(cwd);
  await $`git restore --staged .claude/worktrees`.cwd(cwd).nothrow();
  await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(cwd);
  await $`git push -u origin ${branch}`.cwd(cwd);

  const prUrl = await createPullRequest(
    {
      title: `Fix #${issueNum}: ${issue.title}`,
      body: `## Summary\n\nAutomatically fixes #${issueNum}.\n\n${parsed.message || result.summary}\n\n---\n🤖 Generated by flogvit-coder`,
      base: repoContext.defaultBranch,
    },
    cwd
  );

  // Run tests before merging
  if (repoContext.testCommand) {
    logger.detail(`Running tests: ${repoContext.testCommand}`);
    const [cmd, ...cmdArgs] = repoContext.testCommand.split(" ");
    const testProc = Bun.spawn([cmd, ...cmdArgs], { cwd, stdout: "pipe", stderr: "pipe" });
    const testOut = await new Response(testProc.stdout).text();
    const testErr = await new Response(testProc.stderr).text();
    const testExit = await testProc.exited;

    if (testExit !== 0) {
      await commentOnIssue(
        issueNum,
        formatIssueComment("waiting", `Tests failed — not merging.\n\n\`\`\`\n${(testOut + testErr).slice(0, 3000)}\n\`\`\``),
        cwd
      );
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      await removeLabel(issueNum, LABELS.inProgress, cwd);
      await addLabel(issueNum, LABELS.failed, cwd);
      logger.summary(`Issue #${issueNum}: tests failed — PR created but not merged: ${prUrl}`);
      return { success: false, prUrl };
    }
    logger.detail("Tests passed.");
  }

  await mergePullRequest(prUrl, cwd);

  await commentOnIssue(
    issueNum,
    formatIssueComment("done", `Tests passed. Merged PR: ${prUrl}`),
    cwd
  );
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removeLabel(issueNum, LABELS.inProgress, cwd);
  await clearState(stateDir, repoContext.repoName, issueNum);

  // Go back to default branch and pull merged changes
  await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);
  await $`git pull`.cwd(cwd);

  logger.summary(`Issue #${issueNum}: fixed and merged — ${prUrl}`);
  return { success: true, prUrl };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-coder fix-issue <issue-number>");
    process.exit(1);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  await fixIssue(issueNum, config, cwd, verbose);
}
