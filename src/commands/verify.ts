import { resolve, basename } from "path";
import { homedir } from "os";
import type { Config } from "../lib/config";
import {
  getPR,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { createWorktreeFromRemote, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { Logger } from "../lib/logger";

export async function verifyPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "verify", verbose });

  const pr = await getPR(prNumber, cwd);
  const wtPath = worktreePath(homeDir, repoName, `verify-${prNumber}`);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  await createWorktreeFromRemote(wtPath, pr.headBranch, cwd);

  const repoContext = await gatherRepoContext(wtPath);

  if (!repoContext.testCommand) {
    logger.summary(`PR #${prNumber}: no test command found, skipping verify`);
    await removePRLabel(prNumber, LABELS.needsVerify, cwd);
    await removePRLabel(prNumber, LABELS.changesRequested, cwd);
    await removePRLabel(prNumber, LABELS.failed, cwd);
    await addPRLabel(prNumber, LABELS.needsReview, cwd);
    await removeWorktree(wtPath, cwd);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    await removePRLabel(prNumber, LABELS.inProgress, cwd);
    return { success: true };
  }

  logger.detail(`Running: ${repoContext.testCommand}`);
  const [cmd, ...args] = repoContext.testCommand.split(" ");
  const proc = Bun.spawn([cmd, ...args], { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
  const testOut = await new Response(proc.stdout).text();
  const testErr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  await removeWorktree(wtPath, cwd);
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsVerify, cwd);

  if (exitCode !== 0) {
    const output = `${testOut}\n${testErr}`.trim().slice(0, 3000);
    await commentOnPR(
      prNumber,
      formatIssueComment("verify failed", `\`\`\`\n${output}\n\`\`\``),
      cwd
    );
    await addPRLabel(prNumber, LABELS.failed, cwd);
    logger.summary(`PR #${prNumber}: tests failed`);
    return { success: false };
  }

  await removePRLabel(prNumber, LABELS.changesRequested, cwd);
  await removePRLabel(prNumber, LABELS.failed, cwd);
  await addPRLabel(prNumber, LABELS.needsReview, cwd);
  logger.summary(`PR #${prNumber}: tests passed`);
  return { success: true };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-coder verify <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await verifyPR(prNumber, config, cwd, verbose);
}
