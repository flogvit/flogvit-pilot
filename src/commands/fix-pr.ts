import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays, resolveCommandMaxTurns } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getPR,
  getIssue,
  addPRLabel,
  removePRLabel,
  getPRDiff,
  formatIssueComment,
  commentOnPR,
  commentOnIssue,
  addLabel,
  LABELS,
} from "../lib/github";
import { createWorktreeFromRemote, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { Logger } from "../lib/logger";
import { parseToolOutput, buildIssueCommentsSection } from "./fix-issue";
import { stageRelevantFiles } from "../lib/stage-files";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parsePRIssueNumber(prBody: string): number | null {
  const match = prBody.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export async function fixPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose: boolean = false,
  retryModel?: string,
  failureContext?: string
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const repoContext = await gatherRepoContext(cwd);
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "fix-pr", verbose });

  try {
  const pr = await getPR(prNumber, cwd);
  const issueNum = parsePRIssueNumber(pr.body);
  if (!issueNum) {
    logger.summary(`PR #${prNumber}: could not find linked issue number in body`);
    return { success: false };
  }

  const existingState = await loadState(stateDir, repoName, issueNum);
  const prFixAttempts = (existingState?.prFixAttempts ?? 0) + 1;

  const issue = await getIssue(issueNum, cwd);
  const diff = await getPRDiff(prNumber, cwd);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const wtPath = worktreePath(homeDir, repoName, `fix-pr-${prNumber}`);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("fix-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_num: String(issue.number),
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    pr_number: String(prNumber),
    pr_diff: diff.slice(0, 8000),
    failure_context: failureContext ?? "No specific failure context provided.",
    language: repoContext.language,
    repo_name: repoContext.repoName,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    file_structure: repoContext.fileStructure,
  });

  await createWorktreeFromRemote(wtPath, pr.headBranch, cwd);

  // If there are merge conflicts, try rebasing against base branch before running agent
  const rebaseResult = await $`git rebase origin/${pr.baseBranch}`.cwd(wtPath).nothrow().text();
  if (rebaseResult.includes("CONFLICT")) {
    await $`git rebase --abort`.cwd(wtPath).nothrow();
    // Agent will handle the rebase with full context from the template
  }

  const toolName = resolveToolForCommand(config, "fix-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};
  const model = retryModel ?? (toolConfig.model as string | undefined);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;
  const fallbackCommand = ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined;

  const result = await tool.run({
    prompt,
    cwd: wtPath,
    jobName: `fix-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    fallbackCommand,
    verbose,
    model,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: resolveCommandMaxTurns(config, "fix-pr", toolName),
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
    rateLimitDelaysMs: resolveRateLimitDelays(config),
  });

  logger.detail(result.output);
  if (!result.success) {
    logger.detail(`Tool failed: ${result.summary}`);
  }

  const parsed = parseToolOutput(result.output);
  const diffResult = await $`git status --porcelain`.cwd(wtPath).nothrow().text();
  const hasUncommitted = diffResult.trim().length > 0;
  const commitsAhead = await $`git log origin/${pr.headBranch}..HEAD --oneline`.cwd(wtPath).nothrow().text();
  const hasChanges = hasUncommitted || commitsAhead.trim().length > 0;

  if (parsed.status === "stuck") {
    await removeWorktree(wtPath, cwd).catch(() => {});
    await saveState(stateDir, repoName, issueNum, {
      ...(existingState ?? {
        issueNumber: issueNum,
        command: "fix-pr",
        branch: pr.headBranch,
        agentSummary: "",
        question: null,
        issueData: { title: issue.title, body: issue.body },
        createdAt: new Date().toISOString(),
      }),
      prFixAttempts,
    });
    await removePRLabel(prNumber, LABELS.inProgress, cwd);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    logger.summary(`PR #${prNumber}: fix-pr stuck (attempt ${prFixAttempts})`);
    return { success: false };
  }

  if (!hasChanges) {
    // Agent says done but made no changes — still advance to avoid infinite loop
    await removeWorktree(wtPath, cwd).catch(() => {});
    await removePRLabel(prNumber, LABELS.inProgress, cwd);
    await removePRLabel(prNumber, LABELS.changesRequested, cwd);
    await removePRLabel(prNumber, LABELS.failed, cwd);
    await addPRLabel(prNumber, LABELS.needsVerify, cwd);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    logger.summary(`PR #${prNumber}: no new changes — re-entering pipeline at needs-verify`);
    return { success: true };
  }

  // Commit uncommitted changes (agent may have already committed)
  if (hasUncommitted) {
    await stageRelevantFiles(wtPath, { title: `PR #${prNumber}: ${issue.title}` }, config);
    const commitResult = await $`git commit -m ${"fix-pr: address review feedback"}`.cwd(wtPath).nothrow();
    if (commitResult.exitCode !== 0) {
      logger.detail(`git commit failed: ${commitResult.stderr}`);
    }
  }

  // Push explicitly to named branch — worktree is detached HEAD
  const pushResult = await $`git push origin HEAD:${pr.headBranch} --force`.cwd(wtPath).nothrow();
  if (pushResult.exitCode !== 0) {
    logger.detail(`git push failed: ${pushResult.stderr}`);
    await removeWorktree(wtPath, cwd).catch(() => {});
    await removePRLabel(prNumber, LABELS.inProgress, cwd);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    logger.summary(`PR #${prNumber}: git push failed`);
    return { success: false };
  }

  await removeWorktree(wtPath, cwd);

  // Remove failure labels, add needs-verify to restart pipeline
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.changesRequested, cwd);
  await removePRLabel(prNumber, LABELS.failed, cwd);
  await addPRLabel(prNumber, LABELS.needsVerify, cwd);

  // Keep prFixAttempts accumulating — do NOT reset on success.
  // This ensures the cap in watch.ts is a lifetime limit across all fix+review cycles.
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "fix-pr",
      branch: pr.headBranch,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    prFixAttempts,
  });

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  logger.summary(`PR #${prNumber}: fixed and pushed — pipeline restarted`);
  return { success: true };
  } catch (err) {
    logger.error(`fix-pr crashed: ${String(err).slice(0, 200)}`);
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-pilot fix-pr <pr-number> [--model <model>] [--failure-context <text>]");
    process.exit(1);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  const modelIndex = args.indexOf("--model");
  const model = modelIndex !== -1 ? args[modelIndex + 1] : undefined;
  const failureIndex = args.indexOf("--failure-context");
  const failureContext = failureIndex !== -1 ? args[failureIndex + 1] : undefined;

  await fixPR(prNumber, config, cwd, verbose, model, failureContext);
}
