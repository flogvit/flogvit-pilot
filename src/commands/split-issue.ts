import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays, resolveCommandMaxTurns } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  createIssue,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { loadState, saveState } from "../lib/state";
import { gatherRepoContext } from "../lib/context";
import { Logger } from "../lib/logger";
import { loadTemplate, renderTemplate } from "../lib/template";
import { buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type SplitVerdict =
  | { verdict: "pass" }
  | { verdict: "split"; issues: { title: string; body: string }[] }
  | { verdict: "waiting"; reason: string }
  | { verdict: "unknown" };

export function parseSplitOutput(output: string): SplitVerdict {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, "");
    if (line === "FLOGVIT-PILOT:SPLIT:PASS") return { verdict: "pass" };
    if (line.startsWith("FLOGVIT-PILOT:SPLIT:WAITING:")) {
      return { verdict: "waiting", reason: line.replace("FLOGVIT-PILOT:SPLIT:WAITING:", "").trim() };
    }
  }

  const match = output.match(/FLOGVIT-PILOT:SPLIT:BEGIN\s*([\s\S]*?)\s*FLOGVIT-PILOT:SPLIT:END/);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          verdict: "split",
          issues: parsed.map((item) => ({
            title: String(item.title ?? ""),
            body: String(item.body ?? ""),
          })),
        };
      }
    } catch {
      // fall through
    }
  }

  return { verdict: "unknown" };
}

export async function splitIssue(
  issueNum: number,
  config: Config,
  cwd: string
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const repoName = basename(cwd);
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const logger = new Logger({ logDir, repoName, command: "split-issue", verbose: false });
  const repoContext = await gatherRepoContext(cwd);

  try {
    const issue = await getIssue(issueNum, cwd);

    const template = await loadTemplate("split-issue", {
      builtinDir: __dirname,
      repoDir: cwd,
    });

    const prompt = renderTemplate(template, {
      issue_num: String(issue.number),
      issue_title: issue.title,
      issue_body: issue.body,
      issue_comments: buildIssueCommentsSection(issue.comments),
      repo_name: repoContext.repoName,
      language: repoContext.language,
      claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
      file_structure: repoContext.fileStructure,
    });

    const toolName = resolveToolForCommand(config, "split-issue");
    const tool = getTool(toolName);

    const ollamaConfig = config.tools.ollama;
    const ollamaModel = ollamaConfig?.model as string | undefined;
    const fallbackCommand = ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined;

    const result = await tool.run({
      prompt,
      cwd,
      jobName: `split-issue-${issueNum}`,
      fallbackApiKey: config.defaults.fallback_api_key,
      fallbackCommand,
      maxTurns: resolveCommandMaxTurns(config, "split-issue", toolName) ?? 10,
      allowedTools: ["Read", "Glob", "Grep"],
      rateLimitDelaysMs: resolveRateLimitDelays(config),
    });

    logger.detail(`Split output for #${issueNum}:\n${result.output}`);

    const parsed = parseSplitOutput(result.output);

    await removeLabel(issueNum, LABELS.needsSplit, cwd);

    if (parsed.verdict === "pass") {
      await addLabel(issueNum, LABELS.needsPlan, cwd);
      logger.summary(`Issue #${issueNum}: pass-through → needs-plan`);
      return { success: true };
    }

    if (parsed.verdict === "split") {
      const subIssueNums: number[] = [];
      for (const sub of parsed.issues) {
        const depLine = subIssueNums.length > 0
          ? `\nDepends-On: ${subIssueNums.map((n) => `#${n}`).join(", ")}`
          : "";
        const body = `${sub.body}\n\n_Split from #${issueNum}_${depLine}`;
        const num = await createIssue(sub.title, body, [LABELS.needsPlan], cwd);
        subIssueNums.push(num);
      }

      await commentOnIssue(
        issueNum,
        formatIssueComment(
          "split",
          `Split into ${subIssueNums.length} sub-issues: ${subIssueNums.map((n) => `#${n}`).join(", ")}`
        ),
        cwd
      );
      logger.summary(`Issue #${issueNum}: split into ${subIssueNums.length} sub-issues`);
      return { success: true };
    }

    if (parsed.verdict === "waiting") {
      await addLabel(issueNum, LABELS.waiting, cwd);
      await commentOnIssue(
        issueNum,
        formatIssueComment("waiting", `Trenger avklaring før splitting:\n\n${parsed.reason}`),
        cwd
      );
      logger.summary(`Issue #${issueNum}: escalated — ${parsed.reason}`);
      return { success: true };
    }

    // Unknown → fall back to plan
    await addLabel(issueNum, LABELS.needsPlan, cwd);
    logger.summary(`Issue #${issueNum}: could not parse split output, falling back to plan`);
    return { success: false };
  } catch (err) {
    logger.error(`split-issue crashed: ${String(err).slice(0, 200)}`);
    await removeLabel(issueNum, LABELS.needsSplit, cwd).catch(() => {});
    await addLabel(issueNum, LABELS.needsPlan, cwd).catch(() => {});
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-pilot split-issue <issue-number>");
    process.exit(1);
  }
  await splitIssue(issueNum, config, cwd);
}
