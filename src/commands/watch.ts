import { resolve, basename } from "path";
import type { Config } from "../lib/config";
import { listIssuesWithLabel, getIssue, removeLabel, LABELS } from "../lib/github";
import { loadState } from "../lib/state";
import { fixIssue } from "./fix-issue";

interface IssueWithComments {
  number: number;
  comments: { author: string; body: string; createdAt: string }[];
}

export function findAnsweredIssues(
  issues: IssueWithComments[],
  botIdentifier: string
): number[] {
  const answered: number[] = [];

  for (const issue of issues) {
    if (issue.comments.length === 0) continue;
    const lastComment = issue.comments[issue.comments.length - 1];
    if (lastComment.author !== botIdentifier) {
      answered.push(issue.number);
    }
  }

  return answered;
}

async function watchRepo(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? "~";
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  // 1. Check for new autofix issues
  const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
  const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
  const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

  for (const issue of autofixIssues) {
    if (inProgressNums.has(issue.number)) continue;

    // Check if we already have state (i.e., we're waiting)
    const existingState = await loadState(stateDir, repoName, issue.number);
    if (existingState) continue;

    console.log(`Found new autofix issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }

  // 2. Check for answered waiting issues
  const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
  for (const waitingIssue of waitingIssues) {
    const fullIssue = await getIssue(waitingIssue.number, cwd);
    const comments = fullIssue.comments;
    if (comments.length === 0) continue;

    const lastComment = comments[comments.length - 1];
    // If last comment is NOT from the bot, someone answered
    if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
      console.log(`Issue #${waitingIssue.number} has been answered, resuming...`);
      await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
      await fixIssue(waitingIssue.number, config, cwd);
    }
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const reposFlag = args.find((a) => a.startsWith("--repos"));
  const reposValue = reposFlag ? args[args.indexOf(reposFlag) + 1] : undefined;

  if (reposValue) {
    const repos = reposValue.split(",").map((r) => r.trim());
    for (const repo of repos) {
      const resolvedPath = resolve(repo);
      console.log(`Checking ${resolvedPath}...`);
      await watchRepo(config, resolvedPath);
    }
  } else {
    await watchRepo(config, cwd);
  }
}
