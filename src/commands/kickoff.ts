import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays, resolveCommandMaxTurns } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  createIssue,
  createMilestone,
  findMilestone,
  addLabel,
  commentOnIssue,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { Logger } from "../lib/logger";
import { loadTemplate, renderTemplate } from "../lib/template";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface KickoffIssue {
  title: string;
  body: string;
  labels: string[];
  dependsOn: number[];
}

interface KickoffMilestone {
  title: string;
  description: string;
  issues: KickoffIssue[];
}

interface KickoffPlan {
  summary: string;
  milestones: KickoffMilestone[];
}

export function parseKickoffOutput(output: string): KickoffPlan | null {
  const match = output.match(/FLOGVIT-PILOT:KICKOFF:BEGIN\s*([\s\S]*?)\s*FLOGVIT-PILOT:KICKOFF:END/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.milestones || !Array.isArray(parsed.milestones)) return null;
    return parsed as KickoffPlan;
  } catch {
    return null;
  }
}

export async function kickoff(
  description: string,
  config: Config,
  cwd: string,
  auto: boolean
): Promise<{ success: boolean; parentIssue?: number }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs");
  const repoName = basename(cwd);
  const repoContext = await gatherRepoContext(cwd);
  const logger = new Logger({ logDir, repoName, command: "kickoff", verbose: false });

  try {
    const template = await loadTemplate("kickoff", {
      builtinDir: __dirname,
      repoDir: cwd,
    });

    const prompt = renderTemplate(template, {
      description,
      repo_name: repoContext.repoName,
      language: repoContext.language,
      claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
      file_structure: repoContext.fileStructure,
    });

    const toolName = resolveToolForCommand(config, "kickoff");
    const tool = getTool(toolName);

    const ollamaConfig = config.tools.ollama;
    const ollamaModel = ollamaConfig?.model as string | undefined;
    const fallbackCommand = ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined;

    console.log("Analysing project and generating plan...");

    const result = await tool.run({
      prompt,
      cwd,
      jobName: "kickoff",
      fallbackApiKey: config.defaults.fallback_api_key,
      fallbackCommand,
      maxTurns: resolveCommandMaxTurns(config, "kickoff", toolName) ?? 30,
      allowedTools: ["Read", "Glob", "Grep"],
      rateLimitDelaysMs: resolveRateLimitDelays(config),
    });

    logger.detail(result.output);
    if (!result.success) {
      logger.summary(`Kickoff failed: ${result.summary}`);
      console.error(`Kickoff failed: ${result.summary}`);
      return { success: false };
    }

    const plan = parseKickoffOutput(result.output);
    if (!plan) {
      logger.summary("Kickoff failed: could not parse plan output");
      console.error("Could not parse plan from AI output. Check logs.");
      return { success: false };
    }

    console.log(`\nPlan: ${plan.milestones.length} milestones, ${plan.milestones.reduce((n, m) => n + m.issues.length, 0)} issues\n`);

    // Create parent tracking issue
    const milestoneSummary = plan.milestones
      .map((m, i) => `### ${m.title}\n${m.description}\n\n${m.issues.map((iss) => `- [ ] ${iss.title}`).join("\n")}`)
      .join("\n\n");

    const parentBody = `## Project Kickoff\n\n${plan.summary}\n\n---\n\n${milestoneSummary}`;
    const parentLabels = auto ? [LABELS.ignore] : [LABELS.waiting];
    const parentNum = await createIssue(
      `Kickoff: ${description.slice(0, 60)}${description.length > 60 ? "..." : ""}`,
      parentBody,
      parentLabels,
      cwd
    );
    console.log(`Created parent issue #${parentNum}`);

    // Create milestones and issues
    for (const milestone of plan.milestones) {
      let msNum = await findMilestone(milestone.title, cwd);
      if (!msNum) {
        msNum = await createMilestone(milestone.title, milestone.description, cwd);
      }
      console.log(`\nMilestone: ${milestone.title} (#${msNum})`);

      const indexToIssueNum = new Map<number, number>();

      for (let i = 0; i < milestone.issues.length; i++) {
        const issue = milestone.issues[i];

        // Resolve dependencies within this milestone
        const depNums = issue.dependsOn
          .map((idx) => indexToIssueNum.get(idx))
          .filter((n): n is number => n !== undefined);

        const depLine = depNums.length > 0
          ? `Depends-On: ${depNums.map((n) => `#${n}`).join(", ")}\n\n`
          : "";

        const body = `${depLine}${issue.body}\n\n_Part of #${parentNum}_`;
        const labels = auto
          ? [...new Set([...issue.labels, LABELS.autofix])]
          : [...new Set([...issue.labels, LABELS.needsTriage])];

        const issueNum = await createIssue(issue.title, body, labels, cwd, msNum);
        indexToIssueNum.set(i, issueNum);
        console.log(`  #${issueNum}: ${issue.title}`);
      }
    }

    // Update parent with created issue numbers
    const mode = auto ? "auto" : "manual";
    await commentOnIssue(
      parentNum,
      formatIssueComment(
        "kickoff complete",
        `Plan created with ${plan.milestones.length} milestones and ${plan.milestones.reduce((n, m) => n + m.issues.length, 0)} issues.\n\nMode: **${mode}** — ${auto ? "issues have `autofix` label and will be picked up by `watch` automatically." : "issues have `needs-triage` label. Review and add `autofix` when ready."}`
      ),
      cwd
    );

    logger.summary(`Kickoff complete: ${plan.milestones.length} milestones, ${plan.milestones.reduce((n, m) => n + m.issues.length, 0)} issues created`);
    console.log(`\nDone. Parent issue: #${parentNum} (${mode} mode)`);
    return { success: true, parentIssue: parentNum };
  } catch (err) {
    logger.error(`kickoff crashed: ${String(err).slice(0, 200)}`);
    throw err;
  } finally {
    await logger.flush();
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const auto = args.includes("--auto");
  const filtered = args.filter((a) => a !== "--auto");
  const description = filtered.join(" ").trim();

  if (!description) {
    console.error('Usage: flogvit-pilot kickoff "Project description..." [--auto]');
    console.error("");
    console.error("  --auto    Set autofix labels and let watch handle everything");
    console.error("            Without --auto, issues get needs-triage for manual review");
    process.exit(1);
  }

  await kickoff(description, config, cwd, auto);
}
