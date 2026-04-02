import { $ } from "bun";
import { resolve, basename } from "path";
import { homedir } from "os";
import { unlink } from "fs/promises";
import type { Config } from "../lib/config";
import { listPRsWithLabel, mergePullRequest, getPR, addPRLabel, removePRLabel, commentOnPR, formatIssueComment, LABELS } from "../lib/github";
import { loadState, clearState } from "../lib/state";
import { parsePRIssueNumber } from "./fix-pr";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prs = await listPRsWithLabel(LABELS.approved, cwd);

  if (prs.length === 0) {
    console.log("No approved PRs to merge.");
    return;
  }

  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const repoName = basename(cwd);
  const repoSlug = await getRepoSlug(cwd);

  for (const pr of prs) {
    console.log(`Merging PR #${pr.number}: ${pr.title}`);
    const prUrl = `https://github.com/${repoSlug}/pull/${pr.number}`;

    // Get full PR to find linked issue number
    const fullPR = await getPR(pr.number, cwd);
    const issueNum = parsePRIssueNumber(fullPR.body);

    // Check for merge conflicts — route back to fix-pr instead of crashing
    const mergeState = await $`gh pr view ${pr.number} --json mergeable --jq .mergeable`.cwd(cwd).nothrow().text();
    if (mergeState.trim() === "CONFLICTING") {
      console.log(`PR #${pr.number} has merge conflicts — routing to fix-pr`);
      await removePRLabel(pr.number, LABELS.approved, cwd).catch(() => {});
      await addPRLabel(pr.number, LABELS.changesRequested, cwd).catch(() => {});
      await commentOnPR(pr.number, formatIssueComment("merge conflicts", "This PR has merge conflicts with the base branch and needs to be rebased."), cwd);
      continue;
    }

    await mergePullRequest(prUrl, cwd);
    console.log(`Merged PR #${pr.number}`);

    // Clean up plan file and state for linked issue
    if (issueNum) {
      const state = await loadState(stateDir, repoName, issueNum);
      if (state?.planFile) {
        await unlink(resolve(cwd, state.planFile)).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        });
        console.log(`Deleted plan file: ${state.planFile}`);
      }
      await clearState(stateDir, repoName, issueNum);
    }
  }

  await $`git pull`.cwd(cwd).nothrow();
  console.log("Pulled main. Done.");
}

async function getRepoSlug(cwd: string): Promise<string> {
  const result = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(cwd).text();
  return result.trim();
}
