import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { readFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  closeIssue,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { Logger } from "../lib/logger";
import { buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TriageVerdict =
  | { verdict: "autofix" }
  | { verdict: "needs-split" }
  | { verdict: "waiting"; reason: string }
  | { verdict: "close"; reason: string }
  | { verdict: "unknown" };

export function parseTriageOutput(output: string): TriageVerdict {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, "");
    if (line === "FLOGVIT-CODER:TRIAGE:AUTOFIX") return { verdict: "autofix" };
    if (line === "FLOGVIT-CODER:TRIAGE:NEEDS-SPLIT") return { verdict: "needs-split" };
    if (line === "FLOGVIT-CODER:TRIAGE:NEEDS-PLAN") return { verdict: "needs-split" }; // legacy → route through split-issue
    if (line.startsWith("FLOGVIT-CODER:TRIAGE:WAITING:")) {
      return { verdict: "waiting", reason: line.replace("FLOGVIT-CODER:TRIAGE:WAITING:", "").trim() };
    }
    if (line.startsWith("FLOGVIT-CODER:TRIAGE:CLOSE:")) {
      return { verdict: "close", reason: line.replace("FLOGVIT-CODER:TRIAGE:CLOSE:", "").trim() };
    }
  }
  return { verdict: "unknown" };
}

export async function triageIssue(
  issueNum: number,
  config: Config,
  cwd: string,
  failureContext?: string
): Promise<{ verdict: "autofix" | "needs-split" | "waiting" | "close" }> {
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const repoContext = await gatherRepoContext(cwd);
  const logger = new Logger({ logDir, repoName: basename(cwd), command: "triage", verbose: false });
  const repoName = basename(cwd);

  try {
  const existingState = await loadState(stateDir, repoName, issueNum);
  const triageCount = (existingState?.triageCount ?? 0) + 1;

  // Hard limit: if already triaged twice, escalate to human
  if (triageCount > 2) {
    await removeLabel(issueNum, LABELS.needsTriage, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(
      issueNum,
      formatIssueComment("waiting", "Trenger manuell gjennomgang — har kjørt triage for mange ganger uten å komme videre."),
      cwd
    );
    await saveState(stateDir, repoName, issueNum, {
      ...existingState!,
      triageCount,
    });
    return { verdict: "waiting" };
  }

  const issue = await getIssue(issueNum, cwd);

  // Read existing plan if one has been generated
  let existingPlan = "";
  if (existingState?.planFile) {
    try {
      existingPlan = await readFile(resolve(cwd, existingState.planFile), "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  const template = await loadTemplate("triage", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    existing_plan: existingPlan ? `## Existing Plan\n\n${existingPlan}` : "",
    failure_context: failureContext ? `## Failure Context\n\n${failureContext}` : "",
    triage_count: String(triageCount),
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "triage");
  const tool = getTool(toolName);

  const toolConfig = config.tools[toolName] ?? {};
  const result = await tool.run({
    prompt,
    cwd,
    jobName: `triage-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    maxTurns: (toolConfig["max-turns"] as number) ?? 5,
    allowedTools: [],
  });

  logger.detail(`Triage output for #${issueNum}:\n${result.output}`);

  const parsed = parseTriageOutput(result.output);

  // Update state with new triageCount
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "triage",
      branch: null,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    triageCount,
  });

  // Apply label transitions
  await removeLabel(issueNum, LABELS.needsTriage, cwd);

  if (parsed.verdict === "autofix") {
    await addLabel(issueNum, LABELS.autofix, cwd);
    return { verdict: "autofix" };
  }

  if (parsed.verdict === "needs-split") {
    await addLabel(issueNum, LABELS.needsSplit, cwd);
    return { verdict: "needs-split" };
  }

  if (parsed.verdict === "close") {
    await closeIssue(issueNum, parsed.reason, cwd);
    return { verdict: "close" };
  }

  // waiting or unknown → set waiting
  const reason =
    parsed.verdict === "waiting"
      ? parsed.reason
      : "Triage-agent ga ikke en klar anbefaling. Vennligst avklar hva som skal gjøres.";

  await addLabel(issueNum, LABELS.waiting, cwd);
  await commentOnIssue(issueNum, formatIssueComment("waiting", reason), cwd);
  return { verdict: "waiting" };
  } catch (err) {
    logger.error(`triage crashed: ${String(err).slice(0, 200)}`);
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-pilot triage <issue-number>");
    process.exit(1);
  }

  const failureIndex = args.indexOf("--failure-context");
  const failureContext = failureIndex !== -1 ? args[failureIndex + 1] : undefined;
  await triageIssue(issueNum, config, cwd, failureContext);
}
