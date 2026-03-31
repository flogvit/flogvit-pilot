import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { writeFile, unlink } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import {
  getIssue,
  getPR,
  addLabel,
  removeLabel,
  addPRLabel,
  removePRLabel,
  commentOnIssue,
  createPullRequest,
  extractPRNumber,
  formatIssueComment,
  parseBranchName,
  getPRDiff,
  findPRByBranch,
  LABELS,
  type PR,
} from "../lib/github";
import { parsePRIssueNumber } from "./fix-pr";
import { createWorktree, createWorktreeFromRemote, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, clearState } from "../lib/state";
import { buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function run(args: string[], _config: Config, cwd: string): Promise<void> {
  const num = parseInt(args[0], 10);
  if (isNaN(num)) {
    console.error("Usage: flogvit-pilot work <issue-or-pr-number>");
    process.exit(1);
  }

  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const repoContext = await gatherRepoContext(cwd);
  const repoName = basename(cwd);

  // Try to resolve as PR first, then as issue
  const directPR = await getPR(num, cwd).catch(() => null);

  if (directPR) {
    // Given number is a PR — extract the linked issue from the PR body
    const issueNum = parsePRIssueNumber(directPR.body);
    if (!issueNum) {
      console.error(`PR #${num} has no linked issue in its body (expected "fixes #N").`);
      process.exit(1);
    }
    const issue = await getIssue(issueNum, cwd);
    await workOnPR(directPR, issueNum, issue, directPR.headBranch, repoName, homeDir, stateDir, repoContext, cwd);
    return;
  }

  // Given number is an issue — check if a PR already exists for it
  const issueNum = num;
  const issue = await getIssue(issueNum, cwd);
  const branch = parseBranchName("fix", issueNum);
  const existingPR = await findPRByBranch(branch, cwd);

  if (existingPR) {
    await workOnPR(existingPR, issueNum, issue, branch, repoName, homeDir, stateDir, repoContext, cwd);
  } else {
    await workOnNewIssue(issueNum, issue, branch, repoName, homeDir, stateDir, repoContext, cwd);
  }
}

async function buildTaskContent(
  issueNum: number,
  issue: Awaited<ReturnType<typeof getIssue>>,
  repoContext: Awaited<ReturnType<typeof import("../lib/context").gatherRepoContext>>,
  cwd: string,
  pr?: PR
): Promise<string> {
  const template = await loadTemplate("fix-issue", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  let taskContent = renderTemplate(template, {
    issue_num: String(issue.number),
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    language: repoContext.language,
    repo_name: repoContext.repoName,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    file_structure: repoContext.fileStructure,
  });

  if (pr) {
    const diff = await getPRDiff(pr.number, cwd).catch(() => "");
    taskContent += `\n\n---\n\n## Existing PR #${pr.number}: ${pr.title}\n\n`;
    taskContent += `This is an existing pull request. Your changes will be pushed to the existing branch.\n\n`;
    if (diff) {
      taskContent += `### Current diff (first 6000 chars)\n\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\`\n`;
    }
  }

  return taskContent;
}

async function workOnPR(
  pr: PR,
  issueNum: number,
  issue: Awaited<ReturnType<typeof getIssue>>,
  branch: string,
  repoName: string,
  homeDir: string,
  stateDir: string,
  repoContext: Awaited<ReturnType<typeof import("../lib/context").gatherRepoContext>>,
  cwd: string
): Promise<void> {
  const wtPath = worktreePath(homeDir, repoName, `work-${issueNum}`);

  console.log(`\n🔧 Working on PR #${pr.number} for issue #${issueNum}: ${issue.title}`);
  console.log(`   Branch:   ${branch}`);
  console.log(`   Worktree: ${wtPath}`);

  const cleanup = async () => {
    await removePRLabel(pr.number, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  await createWorktreeFromRemote(wtPath, branch, cwd);
  await addPRLabel(pr.number, LABELS.inProgress, cwd);

  const taskContent = await buildTaskContent(issueNum, issue, repoContext, cwd, pr);
  const taskFile = resolve(wtPath, "TASK.md");
  await writeFile(taskFile, taskContent);

  console.log(`\nStarting Claude Code... (close the session when done)\n`);

  const proc = Bun.spawn(
    ["claude", "Read TASK.md and continue working on the PR described there."],
    { cwd: wtPath, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );

  const exitCode = await proc.exited;
  await unlink(taskFile).catch(() => {});

  if (exitCode !== 0) {
    console.log("\nClaude exited early. Cleaning up...");
    await removePRLabel(pr.number, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    return;
  }

  const diffResult = await $`git status --porcelain`.cwd(wtPath).nothrow().text();
  const hasUncommitted = diffResult.trim().length > 0;
  const commitsAhead = await $`git log origin/${branch}..HEAD --oneline`.cwd(wtPath).nothrow().text();
  const hasChanges = hasUncommitted || commitsAhead.trim().length > 0;

  if (!hasChanges) {
    console.log("\nNo new changes. Cleaning up worktree.");
    await removePRLabel(pr.number, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    return;
  }

  if (hasUncommitted) {
    await $`git add -A`.cwd(wtPath).nothrow();
    await $`git restore --staged .claude/worktrees`.cwd(wtPath).nothrow();
    const commitResult = await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(wtPath).nothrow();
    if (commitResult.exitCode !== 0) {
      console.error("git commit failed:", commitResult.stderr);
    }
  }

  console.log(`\nPushing to ${branch}...`);
  const pushResult = await $`git push origin ${branch} --force`.cwd(wtPath).nothrow();
  if (pushResult.exitCode !== 0) {
    console.error("git push failed:", pushResult.stderr);
  } else {
    console.log(`\n✅ Pushed to PR #${pr.number}: https://github.com/.../${pr.number}`);
  }

  await removePRLabel(pr.number, LABELS.inProgress, cwd).catch(() => {});
  await removeWorktree(wtPath, cwd).catch(() => {});
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
}

async function workOnNewIssue(
  issueNum: number,
  issue: Awaited<ReturnType<typeof getIssue>>,
  branch: string,
  repoName: string,
  homeDir: string,
  stateDir: string,
  repoContext: Awaited<ReturnType<typeof import("../lib/context").gatherRepoContext>>,
  cwd: string
): Promise<void> {
  const wtPath = worktreePath(homeDir, repoName, `work-${issueNum}`);

  console.log(`\n🔧 Working on issue #${issueNum}: ${issue.title}`);
  console.log(`   Branch:   ${branch}`);
  console.log(`   Worktree: ${wtPath}`);

  const cleanup = async () => {
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  await createWorktree(wtPath, branch, cwd);
  await addLabel(issueNum, LABELS.inProgress, cwd);

  const taskContent = await buildTaskContent(issueNum, issue, repoContext, cwd);
  const taskFile = resolve(wtPath, "TASK.md");
  await writeFile(taskFile, taskContent);

  console.log(`\nStarting Claude Code... (close the session when done)\n`);

  const proc = Bun.spawn(
    ["claude", "Read TASK.md and help fix the issue described there."],
    { cwd: wtPath, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
  );

  const exitCode = await proc.exited;
  await unlink(taskFile).catch(() => {});

  if (exitCode !== 0) {
    console.log("\nClaude exited early. Cleaning up...");
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    return;
  }

  const diffResult = await $`git status --porcelain`.cwd(wtPath).nothrow().text();
  const hasUncommitted = diffResult.trim().length > 0;
  const commitsAhead = await $`git log ${repoContext.defaultBranch}..HEAD --oneline`.cwd(wtPath).nothrow().text();
  const hasChanges = hasUncommitted || commitsAhead.trim().length > 0;

  if (!hasChanges) {
    console.log("\nNo changes made. Cleaning up worktree.");
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    return;
  }

  if (hasUncommitted) {
    await $`git add -A`.cwd(wtPath).nothrow();
    await $`git restore --staged .claude/worktrees`.cwd(wtPath).nothrow();
    const commitResult = await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(wtPath).nothrow();
    if (commitResult.exitCode !== 0) {
      console.error("git commit failed:", commitResult.stderr);
    }
  }

  console.log(`\nPushing branch ${branch}...`);
  const pushResult = await $`git push -u origin ${branch} --force`.cwd(wtPath).nothrow();
  if (pushResult.exitCode !== 0) {
    console.error("git push failed:", pushResult.stderr);
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(issueNum, formatIssueComment("waiting", `git push feilet: ${pushResult.stderr.slice(0, 300)}`), cwd);
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    return;
  }

  let prUrl: string;
  try {
    prUrl = await createPullRequest(
      {
        title: `Fix #${issueNum}: ${issue.title}`,
        body: `## Summary\n\nAutomatically fixes #${issueNum}.\n\n---\n🤖 Generated by flogvit-pilot (interactive)`,
        base: repoContext.defaultBranch,
        head: branch,
      },
      cwd
    );
  } catch {
    const existing = await $`gh pr view ${branch} --json url --jq .url`.cwd(cwd).nothrow().text();
    if (!existing.trim()) {
      console.error("Failed to create PR. Branch has been pushed — create it manually.");
      await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
      await removeWorktree(wtPath, cwd).catch(() => {});
      process.off("SIGINT", cleanup);
      process.off("SIGTERM", cleanup);
      return;
    }
    prUrl = existing.trim();
  }

  const prNumber = extractPRNumber(prUrl);
  await addPRLabel(prNumber, LABELS.needsVerify, cwd).catch(() => {});

  const finalState = await loadState(stateDir, repoName, issueNum);
  if (finalState?.planFile) {
    await unlink(resolve(cwd, finalState.planFile)).catch(() => {});
  }
  await clearState(stateDir, repoName, issueNum).catch(() => {});

  await removeWorktree(wtPath, cwd).catch(() => {});
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});

  console.log(`\n✅ PR created: ${prUrl}`);
}
