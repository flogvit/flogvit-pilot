import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";
import { readdir, readFile, stat, realpath } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import { getIssue } from "../lib/github";

// ---------------------------------------------------------------------------
// Source root resolution
// ---------------------------------------------------------------------------

export async function findSourceRoot(): Promise<string | null> {
  const which = await $`which flogvit-pilot`.nothrow().text();
  const bin = which.trim();
  if (!bin) return null;

  let resolved: string;
  try {
    resolved = await realpath(bin);
  } catch {
    return null;
  }

  let dir = dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const hasPkg = await readFile(resolve(dir, "package.json"), "utf-8").then(() => true).catch(() => false);
    if (hasPkg) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log scanning — only new errors, concise excerpts
// ---------------------------------------------------------------------------

export interface LogError {
  repo: string;
  file: string;
  filePath: string;
  excerpt: string; // only the new content since last scan, capped at 600 chars
}

/**
 * Pre-seed logOffsets with the current end-of-file positions for all existing log files.
 * Call this on startup so the first scan only picks up content written after the watch begins.
 */
export async function initLogOffsets(offsets: Map<string, number>, repoName?: string): Promise<void> {
  const homeDir = process.env.HOME ?? homedir();
  const logBase = resolve(homeDir, ".flogvit-pilot", "logs");

  const repos = repoName ? [repoName] : await readdir(logBase).catch(() => [] as string[]);
  for (const repo of repos) {
    if (repo === "active") continue;
    const repoDir = resolve(logBase, repo);
    const files = await readdir(repoDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith(".log") || file.endsWith("-agent.log")) continue;
      const filePath = resolve(repoDir, file);
      const content = await readFile(filePath, "utf-8").catch(() => "");
      offsets.set(filePath, content.length);
    }
  }
}

/**
 * Scan for error logs, returning only content that is new since last call.
 *
 * @param since  - mtime threshold for files not yet in seenOffsets (first-time discovery)
 * @param seenOffsets - mutable map of filePath → char offset already processed; updated in place
 */
export async function scanNewErrorLogs(
  since: number,
  seenOffsets: Map<string, number>,
  repoName?: string
): Promise<LogError[]> {
  const homeDir = process.env.HOME ?? homedir();
  const logBase = resolve(homeDir, ".flogvit-pilot", "logs");
  const errors: LogError[] = [];

  const repos = repoName ? [repoName] : await readdir(logBase).catch(() => [] as string[]);
  for (const repo of repos) {
    if (repo === "active") continue;
    const repoDir = resolve(logBase, repo);
    const files = await readdir(repoDir).catch(() => [] as string[]);

    for (const file of files) {
      if (file.endsWith("-agent.log")) continue; // skip verbose agent output
      if (!file.endsWith(".log")) continue;

      const filePath = resolve(repoDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      const alreadySeen = seenOffsets.has(filePath);

      // For new files: only pick up if modified after `since`
      if (!alreadySeen && fileStat.mtimeMs <= since) continue;

      const content = await readFile(filePath, "utf-8").catch(() => "");
      const offset = seenOffsets.get(filePath) ?? 0;
      const newContent = content.slice(offset);

      // Always advance the offset so we don't re-read old content
      seenOffsets.set(filePath, content.length);

      if (!newContent.trim()) continue;

      const lower = newContent.toLowerCase();
      const hasError =
        lower.includes("shellerror") ||
        lower.includes("error:") ||
        lower.includes("stuck") ||
        lower.includes("failed") ||
        lower.includes("attempt 2") ||
        lower.includes("attempt 3");

      if (hasError) {
        errors.push({
          repo,
          file,
          filePath,
          excerpt: newContent.trim().slice(-600),
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Error tracking — aggregate errors per issue/PR across scans
// ---------------------------------------------------------------------------

export interface IssueErrorTracker {
  /** issue or PR number */
  number: number;
  kind: "issue" | "pr";
  command: string; // e.g. "fix-issue", "review-pr"
  errorCount: number;
  firstSeenAt: number; // timestamp ms
  lastSeenAt: number;
  /** Most recent unique excerpts (deduped, max 5) */
  recentExcerpts: string[];
}

/**
 * Extract issue/PR number and command from a log file's content.
 * Log files start with lines like "Running claude for issue #36" or "Running claude for PR #41 review".
 */
function parseLogContext(content: string, fileName: string): { number: number; kind: "issue" | "pr"; command: string } | null {
  // Try content first (more reliable)
  const issueMatch = content.match(/(?:Running claude for|Issue #|issue #)(\d+)/i);
  if (issueMatch) {
    const command = fileName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "").replace(/\.log$/, "");
    return { number: Number(issueMatch[1]), kind: "issue", command };
  }
  const prMatch = content.match(/(?:Running claude for PR #|PR #)(\d+)/i);
  if (prMatch) {
    const command = fileName.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "").replace(/\.log$/, "");
    return { number: Number(prMatch[1]), kind: "pr", command };
  }
  return null;
}

/**
 * Merge new errors into the persistent tracker map.
 * Returns list of issue trackers that have accumulated enough errors to warrant attention.
 */
export function updateErrorTrackers(
  trackers: Map<string, IssueErrorTracker>,
  errors: LogError[],
): void {
  for (const error of errors) {
    const ctx = parseLogContext(error.excerpt, error.file);
    if (!ctx) continue;

    const key = `${ctx.kind}-${ctx.number}-${ctx.command}`;
    const existing = trackers.get(key);
    const now = Date.now();

    // Dedupe excerpt by first 100 chars
    const excerptKey = error.excerpt.slice(0, 100);

    if (existing) {
      existing.errorCount++;
      existing.lastSeenAt = now;
      if (!existing.recentExcerpts.some((e) => e.slice(0, 100) === excerptKey)) {
        existing.recentExcerpts.push(error.excerpt);
        if (existing.recentExcerpts.length > 5) existing.recentExcerpts.shift();
      }
    } else {
      trackers.set(key, {
        number: ctx.number,
        kind: ctx.kind,
        command: ctx.command,
        errorCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
        recentExcerpts: [error.excerpt],
      });
    }
  }
}

/** Remove trackers that haven't seen errors in the given duration */
export function pruneStaleTrackers(trackers: Map<string, IssueErrorTracker>, maxAgeMs: number): void {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, tracker] of trackers) {
    if (tracker.lastSeenAt < cutoff) trackers.delete(key);
  }
}

/** Get trackers that need attention: repeated errors (3+) or errors spanning 10+ minutes */
export function getActionableTrackers(trackers: Map<string, IssueErrorTracker>): IssueErrorTracker[] {
  const actionable: IssueErrorTracker[] = [];
  for (const tracker of trackers.values()) {
    const spanMinutes = (tracker.lastSeenAt - tracker.firstSeenAt) / 60_000;
    if (tracker.errorCount >= 3 || spanMinutes >= 10) {
      actionable.push(tracker);
    }
  }
  return actionable.sort((a, b) => b.errorCount - a.errorCount);
}

// ---------------------------------------------------------------------------
// Supervisor — two-tier: haiku triages, opus fixes
// ---------------------------------------------------------------------------

export async function runSupervisor(opts: {
  targetCwd: string;
  errors: LogError[];
  config: Config;
  selfImprove: boolean;
  sourceRoot?: string;
  errorTrackers: Map<string, IssueErrorTracker>;
}): Promise<{ success: boolean; summary: string }> {
  const { targetCwd, errors, config, selfImprove, sourceRoot, errorTrackers } = opts;

  // Step 1: Merge new errors into trackers
  updateErrorTrackers(errorTrackers, errors);
  pruneStaleTrackers(errorTrackers, 60 * 60_000); // drop trackers older than 1h

  // Step 2: Check if any trackers are actionable
  const actionable = getActionableTrackers(errorTrackers);
  if (actionable.length === 0) {
    return { success: true, summary: "nothing actionable yet" };
  }

  // Step 3: Haiku triage — decide which issues need intervention
  const triageSummary = actionable.slice(0, 10).map((t) => {
    const spanMin = Math.round((t.lastSeenAt - t.firstSeenAt) / 60_000);
    return `- **${t.kind} #${t.number}** (${t.command}): ${t.errorCount} errors over ${spanMin}m\n  Latest: \`${t.recentExcerpts.at(-1)?.slice(0, 200) ?? "?"}\``;
  }).join("\n");

  const triagePrompt = `# flogvit-pilot supervisor — triage

You are triaging errors for the flogvit-pilot pipeline on \`${basename(targetCwd)}\`.

## Repeated error patterns

${triageSummary}

## Your task

For each item, decide: does this need human-level intervention (label changes, commenting, unsticking a loop)?

Signs of a stuck loop:
- Same error repeating many times (10+) over a long period (30m+)
- "PR already exists" repeating = fix-issue dispatched for an already-handled issue
- Same review verdict flip-flopping = review-pr giving inconsistent results

Respond with a JSON array of issue/PR numbers that need intervention. Only include items where the pipeline is genuinely stuck and won't recover on its own. Empty array if nothing needs action.

Format: FLOGVIT-PILOT:ACTION:["issue:36","pr:41"] or FLOGVIT-PILOT:ACTION:[]`;

  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);

  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;

  let triageResult: { output: string; success: boolean };
  try {
    triageResult = await tool.run({
      prompt: triagePrompt,
      cwd: targetCwd,
      jobName: "supervisor-triage",
      fallbackApiKey: config.defaults.fallback_api_key,
      fallbackCommand: ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined,
      maxTurns: 3,
      model: "claude-haiku-4-5",
      rateLimitDelaysMs: resolveRateLimitDelays(config),
    });
  } catch (err) {
    return { success: false, summary: `triage STUCK: ${String(err).slice(0, 80)}` };
  }

  // Parse haiku's response for action items
  const actionMatch = triageResult.output.match(/FLOGVIT-PILOT:ACTION:\[([^\]]*)\]/);
  if (!actionMatch) {
    return { success: true, summary: "triage: no clear verdict" };
  }

  const actionItems = actionMatch[1]
    .split(",")
    .map((s) => s.trim().replace(/"/g, ""))
    .filter(Boolean)
    .map((s) => {
      const [kind, numStr] = s.split(":");
      return { kind: kind as "issue" | "pr", number: Number(numStr) };
    })
    .filter((item) => !isNaN(item.number));

  if (actionItems.length === 0) {
    return { success: true, summary: "triage: nothing needs action" };
  }

  // Step 4: Opus fix — for each flagged item, fetch full context and let opus resolve it
  const summaries: string[] = [];
  for (const item of actionItems.slice(0, 3)) { // cap at 3 items per run
    const tracker = actionable.find((t) => t.kind === item.kind && t.number === item.number);
    if (!tracker) continue;

    // Fetch full issue/PR context with comments
    let contextSection: string;
    try {
      if (item.kind === "issue") {
        const issue = await getIssue(item.number, targetCwd);
        const commentsSection = issue.comments?.length
          ? issue.comments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n---\n\n")
          : "No comments.";
        contextSection = `## Issue #${issue.number}: ${issue.title}\n\nLabels: ${issue.labels.join(", ")}\n\n### Body\n${issue.body}\n\n### Comments\n${commentsSection}`;
      } else {
        const prData = await $`gh pr view ${item.number} --json number,title,body,labels,comments,headRefName,state`.cwd(targetCwd).text();
        const pr = JSON.parse(prData);
        const labels = pr.labels?.map((l: { name: string }) => l.name).join(", ") ?? "";
        const commentsSection = pr.comments?.length
          ? pr.comments.map((c: { author: { login: string }; body: string; createdAt: string }) =>
              `**${c.author.login}** (${c.createdAt}):\n${c.body}`).join("\n\n---\n\n")
          : "No comments.";
        contextSection = `## PR #${pr.number}: ${pr.title}\n\nLabels: ${labels}\nBranch: ${pr.headRefName}\nState: ${pr.state}\n\n### Body\n${pr.body ?? ""}\n\n### Comments\n${commentsSection}`;
      }
    } catch {
      contextSection = `## ${item.kind} #${item.number}\n\n(Could not fetch details)`;
    }

    const errorDetails = tracker.recentExcerpts
      .map((e, i) => `### Error ${i + 1}\n\`\`\`\n${e}\n\`\`\``)
      .join("\n\n");

    const selfImproveSection = selfImprove && sourceRoot ? `
## Self-improvement
You may also fix bugs in flogvit-pilot source at \`${sourceRoot}\`.
After any code change, run \`bun tsc --noEmit\` in that directory to verify.
Only fix real bugs visible in the errors above — do not refactor unrelated code.
` : "";

    const fixPrompt = `# flogvit-pilot supervisor — fix stuck ${item.kind}

You are the supervisor for the flogvit-pilot pipeline on \`${basename(targetCwd)}\`.

The pipeline is stuck on ${item.kind} #${item.number}. The same error has occurred **${tracker.errorCount} times** over **${Math.round((tracker.lastSeenAt - tracker.firstSeenAt) / 60_000)} minutes**.

${contextSection}

## Error log excerpts (${tracker.command})

${errorDetails}

## What you can do

**GitHub actions on \`${basename(targetCwd)}\` (run gh commands in \`${targetCwd}\`):**
- Update labels: \`gh issue edit #N --add-label X --remove-label Y --repo owner/repo\` or \`gh pr edit #N --add-label X --remove-label Y --repo owner/repo\`
- Comment: \`gh issue comment #N --body "..." --repo owner/repo\` or \`gh pr comment #N --body "..." --repo owner/repo\`
- Check state: \`gh issue view #N --json labels,state --repo owner/repo\`, \`gh pr view #N --json labels,state --repo owner/repo\`
- Close stuck PRs: \`gh pr close #N --repo owner/repo\`

**Common fixes for stuck loops:**
- Issue keeps getting fix-issue dispatched after PR exists → remove the \`autofix\` label from the issue
- PR review flip-flopping between approve/changes-requested → add \`ignore\` label to pause, or force-approve with \`needs-audit\` label
- fix-pr keeps failing → add \`waiting\` label to escalate to human
${selfImproveSection}
## Instructions

1. Diagnose WHY the pipeline is stuck (read the errors and context carefully)
2. Take the minimal action to unstick it (usually a label change)
3. If you're not sure, add \`waiting\` label to escalate to human rather than guessing

When done: FLOGVIT-PILOT:DONE:<one line summary>
If stuck: FLOGVIT-PILOT:STUCK:<reason>`;

    // Snapshot modified files before agent runs
    const preRunDirty = selfImprove && sourceRoot
      ? new Set((await $`git status --porcelain`.cwd(sourceRoot).nothrow().text()).trim().split("\n").map((l) => l.slice(3)).filter(Boolean))
      : new Set<string>();

    let fixResult: { output: string; success: boolean };
    try {
      fixResult = await tool.run({
        prompt: fixPrompt,
        cwd: sourceRoot ?? targetCwd,
        jobName: `supervisor-fix-${item.kind}-${item.number}`,
        fallbackApiKey: config.defaults.fallback_api_key,
        fallbackCommand: ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined,
        maxTurns: 15,
        model: "claude-sonnet-4-5",
        rateLimitDelaysMs: resolveRateLimitDelays(config),
      });
    } catch (err) {
      summaries.push(`${item.kind} #${item.number}: STUCK ${String(err).slice(0, 60)}`);
      continue;
    }

    // Handle self-improve commits
    if (selfImprove && sourceRoot) {
      const postRun = await $`git status --porcelain`.cwd(sourceRoot).nothrow().text();
      const postRunFiles = postRun.trim().split("\n").map((l) => l.slice(3)).filter(Boolean);
      const agentFiles = postRunFiles.filter((f) => !preRunDirty.has(f));

      if (agentFiles.length > 0) {
        const tsc = await $`bun tsc --noEmit`.cwd(sourceRoot).nothrow();
        if (tsc.exitCode !== 0) {
          for (const file of agentFiles) {
            await $`git checkout -- ${file}`.cwd(sourceRoot).nothrow();
          }
        } else {
          for (const file of agentFiles) {
            await $`git add ${file}`.cwd(sourceRoot).nothrow();
          }
          const staged = await $`git diff --cached --name-only`.cwd(sourceRoot).nothrow().text();
          if (staged.trim()) {
            await $`git commit -m ${`supervisor: fix stuck ${item.kind} #${item.number}`}`.cwd(sourceRoot).nothrow();
          }
        }
      }
    }

    // Clear tracker after opus has acted on it, so it doesn't immediately re-trigger
    const trackerKey = `${item.kind}-${item.number}-${tracker.command}`;
    errorTrackers.delete(trackerKey);

    const lastLine = fixResult.output.trim().split("\n").pop() ?? "";
    const fixSummary = lastLine.replace(/^FLOGVIT-PILOT:DONE:/, "").replace(/^FLOGVIT-PILOT:STUCK:/, "STUCK: ");
    summaries.push(`${item.kind} #${item.number}: ${fixSummary}`);
  }

  return { success: true, summary: summaries.join(" | ") };
}

// ---------------------------------------------------------------------------
// Auto-resolve — act as human decision-maker for waiting issues
// ---------------------------------------------------------------------------

export async function autoResolveWaiting(opts: {
  issueNum: number;
  cwd: string;
  config: Config;
}): Promise<{ success: boolean; summary: string }> {
  const { issueNum, cwd, config } = opts;

  const issue = await getIssue(issueNum, cwd);

  const commentsSection = issue.comments?.length
    ? issue.comments.map((c) => `**${c.author}** (${c.createdAt}):\n${c.body}`).join("\n\n---\n\n")
    : "No comments.";

  // Gather repo context for the prompt
  const repoName = basename(cwd);
  const repoFiles = await $`git ls-tree -r --name-only HEAD`.cwd(cwd).nothrow().text();
  const fileList = repoFiles.trim().split("\n").slice(0, 100).join("\n");

  const prompt = `# Auto-pilot decision for issue #${issueNum}

You are acting as the project owner / tech lead for the \`${repoName}\` repository.
An automated pipeline has hit a point where it needs a human decision. Your job is to review the full context and make a well-informed, pragmatic choice.

## Issue #${issueNum}: ${issue.title}

Labels: ${issue.labels.join(", ")}

### Description
${issue.body}

### Conversation
${commentsSection}

## Repository structure (first 100 files)
\`\`\`
${fileList}
\`\`\`

## Your task

1. **Read the full conversation** — understand what the bot asked and why it's stuck
2. **Explore the codebase** if needed to make an informed decision (use Bash to read files, check git log, etc.)
3. **Make a decision** — choose the best approach based on:
   - What's technically sound
   - What's simplest to implement correctly
   - What aligns with the existing codebase patterns
4. **Post your decision as a comment** on the issue using the gh CLI

Your comment should:
- Be clear and actionable — the bot will re-triage based on your answer
- Include specific technical direction (e.g., "use approach B: store paths instead of indices")
- Be concise but complete enough that a coding agent can act on it
- NOT use the "🤖 **flogvit-pilot**" or "🤖 **flogvit-coder**" prefix (those are reserved for bot comments)

Use this format for the comment:
\`\`\`
gh issue comment ${issueNum} --body "**Auto-pilot decision:**

<your decision here>" --repo <owner/repo>
\`\`\`

Get the owner/repo from: \`gh repo view --json nameWithOwner --jq .nameWithOwner\` in \`${cwd}\`.

When done: FLOGVIT-PILOT:DONE:<one line summary of what you decided>
If you genuinely can't make a decision: FLOGVIT-PILOT:STUCK:<reason>`;

  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;

  let result: { output: string; success: boolean };
  try {
    result = await tool.run({
      prompt,
      cwd,
      jobName: `auto-resolve-${issueNum}`,
      fallbackApiKey: config.defaults.fallback_api_key,
      fallbackCommand: ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined,
      maxTurns: 15,
      model: "claude-opus-4-5",
      rateLimitDelaysMs: resolveRateLimitDelays(config),
    });
  } catch (err) {
    return { success: false, summary: `STUCK: ${String(err).slice(0, 80)}` };
  }

  const lastLine = result.output.trim().split("\n").pop() ?? "";
  const summary = lastLine.replace(/^FLOGVIT-PILOT:DONE:/, "").replace(/^FLOGVIT-PILOT:STUCK:/, "STUCK: ");
  return { success: result.success, summary };
}

// ---------------------------------------------------------------------------
// CLI entry point (manual use: flogvit-pilot develop)
// ---------------------------------------------------------------------------

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 24;
  const selfImprove = args.includes("--self-improve");

  const sourceRoot = await findSourceRoot();
  if (!sourceRoot) {
    console.error("Cannot find flogvit-pilot source root. Requires bun link install.");
    process.exit(1);
  }

  const since = Date.now() - hours * 60 * 60 * 1000;
  const errors = await scanNewErrorLogs(since, new Map());
  console.log(`Found ${errors.length} error logs in the last ${hours}h`);

  if (errors.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const errorTrackers = new Map<string, IssueErrorTracker>();
  const { summary } = await runSupervisor({
    targetCwd: cwd,
    errors,
    config,
    selfImprove,
    sourceRoot,
    errorTrackers,
  });
  console.log(`Supervisor: ${summary}`);
}
