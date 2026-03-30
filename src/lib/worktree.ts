import { $ } from "bun";
import { join } from "path";
import { mkdir, rm } from "fs/promises";

export function worktreesBaseDir(homeDir: string, repoName: string): string {
  return join(homeDir, ".flogvit-coder", "worktrees", repoName);
}

export function worktreePath(homeDir: string, repoName: string, jobName: string): string {
  return join(worktreesBaseDir(homeDir, repoName), jobName);
}

export async function createWorktree(path: string, branch: string, cwd: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const branchExists = await $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(cwd).nothrow();
  if (branchExists.exitCode === 0) {
    await $`git worktree add ${path} ${branch}`.cwd(cwd);
  } else {
    await $`git worktree add ${path} -b ${branch}`.cwd(cwd);
  }
}

export async function createWorktreeFromRemote(path: string, branch: string, cwd: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await $`git fetch origin ${branch}`.cwd(cwd);
  await $`git worktree add ${path} origin/${branch}`.cwd(cwd);
}

export async function removeWorktree(path: string, cwd: string): Promise<void> {
  await $`git worktree remove ${path} --force`.cwd(cwd).nothrow();
  await rm(path, { recursive: true, force: true });
  await $`git worktree prune`.cwd(cwd).nothrow();
}
