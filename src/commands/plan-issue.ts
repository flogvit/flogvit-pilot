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
  formatIssueComment,
  createIssue,
  LABELS,
} from "../lib/github";
import { Logger } from "../lib/logger";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { buildIssueCommentsSection } from "./fix-issue";
import { importPlanFile } from "../lib/plan";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type PlanVerdict =
  | { verdict: "ready" }
  | { verdict: "needs-human"; reason: string }
  | { verdict: "unknown" };

export function parsePlanOutput(output: string): PlanVerdict {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim().replace(/^`+|`+$/g, "");
    if (line === "FLOGVIT-CODER:PLAN:READY") return { verdict: "ready" };
    if (line.startsWith("FLOGVIT-CODER:PLAN:NEEDS-HUMAN:")) {
      return {
        verdict: "needs-human",
        reason: line.replace("FLOGVIT-CODER:PLAN:NEEDS-HUMAN:", "").trim(),
      };
    }
  }
  return { verdict: "unknown" };
}

export interface SubIssue {
  title: string;
  body: string;
  labels: string[];
  dependsOn: number[];
}

export function parseSubIssues(output: string): SubIssue[] | null {
  const match = output.match(/FLOGVIT-CODER:ISSUES:BEGIN\s*([\s\S]*?)\s*FLOGVIT-CODER:ISSUES:END/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map((item) => ({
      title: String(item.title ?? ""),
      body: String(item.body ?? ""),
      labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn.map(Number) : [],
    }));
  } catch {
    return null;
  }
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "")
    .replace(/^-+/, "");
  return slug || "untitled";
}

export async function planIssue(
  issueNum: number,
  config: Config,
  cwd: string
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");
  const repoName = basename(cwd);
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const logger = new Logger({ logDir, repoName, command: "plan-issue", verbose: false });
  const repoContext = await gatherRepoContext(cwd);

  try {
  const existingState = await loadState(stateDir, repoName, issueNum);

  // Guard: if plan already generated, set waiting directly
  if (existingState?.planGenerated) {
    await removeLabel(issueNum, LABELS.needsPlan, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(
      issueNum,
      formatIssueComment(
        "waiting",
        "En plan er allerede generert. Vennligst gjennomgå planen og gi tilbakemelding som kommentar, eller sett `autofix`-labelen for å starte implementasjonen."
      ),
      cwd
    );
    return { success: false };
  }

  const issue = await getIssue(issueNum, cwd);

  // Build plan file path from issue title slug
  const slug = slugify(issue.title);
  const planFile = `docs/superpowers/plans/issue-${issueNum}-${slug}.md`;

  const template = await loadTemplate("plan-issue", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    repo_name: repoContext.repoName,
    language: repoContext.language,
    file_structure: repoContext.fileStructure,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    plan_file: planFile,
  });

  const toolName = resolveToolForCommand(config, "plan-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};
  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;
  const fallbackCommand = ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined;

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `plan-issue-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    fallbackCommand,
    allowedTools: ["Read", "Glob", "Grep", "Write"],
    maxTurns: resolveCommandMaxTurns(config, "plan-issue", toolName) ?? 20,
    rateLimitDelaysMs: resolveRateLimitDelays(config),
  });

  if (!result.success) {
    logger.summary(`Plan issue #${issueNum} failed: ${result.summary}`);
  }

  const parsed = parsePlanOutput(result.output);

  // Update state
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "plan-issue",
      branch: null,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    planGenerated: true,
    planFile,
  });

  // Remove needs-plan label
  await removeLabel(issueNum, LABELS.needsPlan, cwd);

  if (parsed.verdict === "ready") {
    const subIssues = parseSubIssues(result.output);

    if (subIssues && subIssues.length > 0) {
      // Create sub-issues in order, resolving dependsOn indices to actual issue numbers
      const indexToNumber = new Map<number, number>();
      for (let i = 0; i < subIssues.length; i++) {
        const sub = subIssues[i];
        const depNums = sub.dependsOn
          .map((idx) => indexToNumber.get(idx))
          .filter((n): n is number => n !== undefined);
        const body =
          depNums.length > 0
            ? `Depends-on: ${depNums.map((n) => `#${n}`).join(", ")}\n\n${sub.body}`
            : sub.body;
        const labels = [...new Set([...sub.labels, LABELS.autofix])];
        const createdNum = await createIssue(sub.title, body, labels, cwd);
        indexToNumber.set(i, createdNum);
        logger.summary(`Created sub-issue #${createdNum}: ${sub.title}`);
      }

      const subList = [...indexToNumber.values()].map((n) => `- #${n}`).join("\n");
      await addLabel(issueNum, LABELS.waiting, cwd);
      await commentOnIssue(
        issueNum,
        formatIssueComment(
          "plan klar — sub-issues opprettet",
          `Implementasjonsplan er generert og lagret i \`${planFile}\`.\n\n${indexToNumber.size} sub-issues er opprettet og vil kjøres i riktig rekkefølge:\n\n${subList}`
        ),
        cwd
      );
    } else {
      // No JSON sub-issues — try to import tasks from the plan file itself
      const imported = await importPlanFile({
        planPath: resolve(cwd, planFile),
        parentIssue: issueNum,
        cwd,
        autofix: true,
      });

      if (imported) {
        const subList = imported.issueNumbers.map((n) => `- #${n}`).join("\n");
        await addLabel(issueNum, LABELS.waiting, cwd);
        await commentOnIssue(
          issueNum,
          formatIssueComment(
            "plan klar — tasks opprettet",
            `Implementasjonsplan er generert og lagret i \`${planFile}\`.\n\n${imported.issueNumbers.length} task-issues er opprettet under milestone og kjøres automatisk:\n\n${subList}`
          ),
          cwd
        );
      } else {
        // Plan has no tasks — just fix it directly
        await addLabel(issueNum, LABELS.autofix, cwd);
        await commentOnIssue(
          issueNum,
          formatIssueComment(
            "plan klar",
            `Implementasjonsplan er generert og klar til utførelse.\n\nSe planen: \`${planFile}\`\n\nJeg starter implementasjonen automatisk.`
          ),
          cwd
        );
      }
    }
    return { success: true };
  }

  // needs-human or unknown → post plan as comment and wait
  const reason =
    parsed.verdict === "needs-human"
      ? parsed.reason
      : "Plan generert, men trenger din gjennomgang.";

  await addLabel(issueNum, LABELS.waiting, cwd);
  await commentOnIssue(
    issueNum,
    formatIssueComment(
      "plan klar — trenger gjennomgang",
      `Implementasjonsplan er generert og lagret i \`${planFile}\`.\n\n**Åpent spørsmål:** ${reason}\n\nGjennomgå planen og legg til en kommentar med instruksjoner. Sett \`autofix\`-labelen for å starte implementasjonen når du er klar.`
    ),
    cwd
  );
  return { success: false };
  } catch (err) {
    logger.error(`plan-issue crashed: ${String(err).slice(0, 200)}`);
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-pilot plan-issue <issue-number>");
    process.exit(1);
  }
  await planIssue(issueNum, config, cwd);
}
