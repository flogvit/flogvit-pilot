import { $ } from "bun";
import { join } from "path";
import { mkdir, rm, writeFile, access } from "fs/promises";

export function worktreesBaseDir(homeDir: string, repoName: string): string {
  return join(homeDir, ".flogvit-pilot", "worktrees", repoName);
}

export function worktreePath(homeDir: string, repoName: string, jobName: string): string {
  return join(worktreesBaseDir(homeDir, repoName), jobName);
}

export async function createWorktree(path: string, branch: string, cwd: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  // Clean up stale worktree at this path if it exists
  await $`git worktree remove ${path} --force`.cwd(cwd).nothrow();
  await rm(path, { recursive: true, force: true });
  await $`git worktree prune`.cwd(cwd).nothrow();
  const branchExists = await $`git show-ref --verify --quiet refs/heads/${branch}`.cwd(cwd).nothrow();
  if (branchExists.exitCode === 0) {
    await $`git worktree add ${path} ${branch}`.cwd(cwd);
  } else {
    await $`git worktree add ${path} -b ${branch}`.cwd(cwd);
  }

  // If this is a Rust project, point cargo to a shared target dir to avoid
  // rebuilding all dependencies (3-5 GB) in every worktree
  const isRust = await access(join(cwd, "Cargo.toml")).then(() => true).catch(() => false);
  if (isRust) {
    const sharedTarget = join(cwd, "target");
    const cargoConfigDir = join(path, ".cargo");
    await mkdir(cargoConfigDir, { recursive: true });
    await writeFile(
      join(cargoConfigDir, "config.toml"),
      `[build]\ntarget-dir = ${JSON.stringify(sharedTarget)}\n`
    );
    // Prevent this machine-specific file from being committed
    await writeFile(join(cargoConfigDir, ".gitignore"), "config.toml\n");
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
