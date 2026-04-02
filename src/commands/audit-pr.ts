import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays, resolveCommandMaxTurns } from "../lib/config";
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

export async function auditPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "audit-pr", verbose });

  try {
  const diff = await getPRDiff(prNumber, cwd);
  const repoContext = await gatherRepoContext(cwd);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("audit-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    pr_diff: diff,
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "audit-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for PR #${prNumber} security audit`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;
  const fallbackCommand = ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined;

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `audit-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    fallbackCommand,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: resolveCommandMaxTurns(config, "audit-pr", toolName),
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
    rateLimitDelaysMs: resolveRateLimitDelays(config),
  });

  logger.detail(result.output);
  if (!result.success) {
    logger.summary(`Audit PR #${prNumber} failed: ${result.summary}`);
  }

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsAudit, cwd);

  const lines = result.output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, "");
    if (line.startsWith("FLOGVIT-PILOT:AUDIT:APPROVED:")) {
      const reason = line.replace("FLOGVIT-PILOT:AUDIT:APPROVED:", "").trim();
      await removePRLabel(prNumber, LABELS.changesRequested, cwd);
      await removePRLabel(prNumber, LABELS.failed, cwd);
      await addPRLabel(prNumber, LABELS.approved, cwd);
      logger.summary(`PR #${prNumber}: audit approved — ${reason}`);
      return { success: true };
    }
    if (line.startsWith("FLOGVIT-PILOT:AUDIT:SECURITY-ISSUE:")) {
      const description = line.replace("FLOGVIT-PILOT:AUDIT:SECURITY-ISSUE:", "").trim();
      await addPRLabel(prNumber, LABELS.securityIssue, cwd);
      await commentOnPR(
        prNumber,
        formatIssueComment("security audit: issue found", description),
        cwd
      );
      logger.summary(`PR #${prNumber}: security issue — ${description}`);
      return { success: false };
    }
  }

  // Couldn't parse a verdict — treat as inconclusive, restore label
  logger.summary(`PR #${prNumber}: audit produced no clear verdict`);
  await addPRLabel(prNumber, LABELS.needsAudit, cwd);
  return { success: false };
  } catch (err) {
    logger.error(`audit-pr crashed: ${String(err).slice(0, 200)}`);
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-pilot audit-pr <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await auditPR(prNumber, config, cwd, verbose);
}
