import { $ } from "bun";
import type { Config } from "../lib/config";
import { listPRsWithLabel, mergePullRequest, LABELS } from "../lib/github";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prs = await listPRsWithLabel(LABELS.approved, cwd);

  if (prs.length === 0) {
    console.log("No approved PRs to merge.");
    return;
  }

  const repoSlug = await getRepoSlug(cwd);

  for (const pr of prs) {
    console.log(`Merging PR #${pr.number}: ${pr.title}`);
    const prUrl = `https://github.com/${repoSlug}/pull/${pr.number}`;
    await mergePullRequest(prUrl, cwd);
    console.log(`Merged PR #${pr.number}`);
  }

  await $`git pull`.cwd(cwd);
  console.log("Pulled main. Done.");
}

async function getRepoSlug(cwd: string): Promise<string> {
  const result = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(cwd).text();
  return result.trim();
}
