import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getPRDiff,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { Logger } from "../lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function reviewPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "review-pr", verbose });

  const diff = await getPRDiff(prNumber, cwd);
  const repoContext = await gatherRepoContext(cwd);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("review-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    pr_diff: diff,
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "review-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for PR #${prNumber} review`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `review-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsReview, cwd);

  const lines = result.output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, "");
    if (line.startsWith("FLOGVIT-CODER:REVIEW:APPROVE:")) {
      const reason = line.replace("FLOGVIT-CODER:REVIEW:APPROVE:", "").trim();
      await removePRLabel(prNumber, LABELS.changesRequested, cwd);
      await removePRLabel(prNumber, LABELS.failed, cwd);
      await addPRLabel(prNumber, LABELS.needsAudit, cwd);
      logger.summary(`PR #${prNumber}: review approved — ${reason}`);
      return { success: true };
    }
    if (line.startsWith("FLOGVIT-CODER:REVIEW:CHANGES-REQUESTED:")) {
      const reason = line.replace("FLOGVIT-CODER:REVIEW:CHANGES-REQUESTED:", "").trim();
      await addPRLabel(prNumber, LABELS.changesRequested, cwd);
      await commentOnPR(
        prNumber,
        formatIssueComment("review: changes requested", reason),
        cwd
      );
      logger.summary(`PR #${prNumber}: changes requested — ${reason}`);
      return { success: false };
    }
  }

  // Couldn't parse a verdict — treat as inconclusive, re-add needsReview
  logger.summary(`PR #${prNumber}: review produced no clear verdict`);
  await addPRLabel(prNumber, LABELS.needsReview, cwd);
  return { success: false };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-pilot review-pr <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await reviewPR(prNumber, config, cwd, verbose);
}
