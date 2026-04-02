import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";
import { readdir, readFile, stat, realpath } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand, resolveRateLimitDelays } from "../lib/config";
import { getTool } from "../lib/tool-runner";

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
export async function initLogOffsets(offsets: Map<string, number>): Promise<void> {
  const homeDir = process.env.HOME ?? homedir();
  const logBase = resolve(homeDir, ".flogvit-pilot", "logs");

  const repos = await readdir(logBase).catch(() => [] as string[]);
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
  seenOffsets: Map<string, number>
): Promise<LogError[]> {
  const homeDir = process.env.HOME ?? homedir();
  const logBase = resolve(homeDir, ".flogvit-pilot", "logs");
  const errors: LogError[] = [];

  const repos = await readdir(logBase).catch(() => [] as string[]);
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
// Supervisor — monitors logs, acts on GitHub, optionally fixes source
// ---------------------------------------------------------------------------

export async function runSupervisor(opts: {
  targetCwd: string;
  errors: LogError[];
  config: Config;
  selfImprove: boolean;
  sourceRoot?: string;
}): Promise<{ success: boolean; summary: string }> {
  const { targetCwd, errors, config, selfImprove, sourceRoot } = opts;

  const errorSection = errors
    .slice(0, 10) // cap at 10 error logs
    .map((e) => `**${e.repo}/${e.file}** (\`${e.filePath}\`)\n\`\`\`\n${e.excerpt}\n\`\`\``)
    .join("\n\n");

  const selfImproveSection = selfImprove && sourceRoot ? `
## Self-improvement
You may also fix bugs in flogvit-pilot source at \`${sourceRoot}\`.
After any code change, run \`bun tsc --noEmit\` in that directory to verify.
Only fix real bugs visible in the logs above — do not refactor unrelated code.
` : "";

  const prompt = `# flogvit-pilot supervisor

You are the supervisor for the flogvit-pilot pipeline running on \`${basename(targetCwd)}\`.

Your job: look at the recent errors and take whatever action is needed.

## What you can do

**GitHub actions on \`${basename(targetCwd)}\` (run gh commands with \`--cwd ${targetCwd}\` or \`cd ${targetCwd} &&\`):**
- Update labels: \`gh issue edit #N --add-label X --remove-label Y\`
- Comment: \`gh issue comment #N --body "..."\` or \`gh pr comment #N --body "..."\`
- Check current state: \`gh issue list\`, \`gh pr list\`
${selfImproveSection}
## Recent errors (${errors.length} new since last check)

${errorSection || "No errors — nothing to do."}

---

When done: FLOGVIT-PILOT:DONE:<one line summary or "nothing to do">
If stuck: FLOGVIT-PILOT:STUCK:<reason>`;

  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  // Check if ollama fallback is configured
  const ollamaConfig = config.tools.ollama;
  const ollamaModel = ollamaConfig?.model as string | undefined;

  // Snapshot modified files before agent runs, so we can distinguish agent changes from user changes
  const preRunDirty = selfImprove && sourceRoot
    ? new Set((await $`git status --porcelain`.cwd(sourceRoot).nothrow().text()).trim().split("\n").map((l) => l.slice(3)).filter(Boolean))
    : new Set<string>();

  let result: { output: string; success: boolean };
  try {
    result = await tool.run({
      prompt,
      cwd: sourceRoot ?? targetCwd,
      jobName: "supervisor",
      fallbackApiKey: config.defaults.fallback_api_key,
      fallbackCommand: ollamaConfig ? `ollama launch claude --model ${ollamaModel}` : undefined,
      maxTurns: 15,
      model: "claude-haiku-4-5",
      rateLimitDelaysMs: resolveRateLimitDelays(config),
    });
  } catch (err) {
    const msg = String(err);
    // Max-turns / timeout is a soft failure — log it and move on
    return { success: false, summary: `STUCK: ${msg.slice(0, 80)}` };
  }

  // If self-improve and source changed — verify and commit only files the agent modified
  let selfImproveSuffix = "";
  if (selfImprove && sourceRoot) {
    const postRun = await $`git status --porcelain`.cwd(sourceRoot).nothrow().text();
    const postRunFiles = postRun.trim().split("\n").map((l) => l.slice(3)).filter(Boolean);

    // Only consider files that are NEW in the diff (not already dirty before the agent ran)
    const agentFiles = postRunFiles.filter((f) => !preRunDirty.has(f));

    if (agentFiles.length > 0) {
      const tsc = await $`bun tsc --noEmit`.cwd(sourceRoot).nothrow();
      if (tsc.exitCode !== 0) {
        for (const file of agentFiles) {
          await $`git checkout -- ${file}`.cwd(sourceRoot).nothrow();
        }
        selfImproveSuffix = " [self-improve: reverted — tsc errors]";
      } else {
        for (const file of agentFiles) {
          await $`git add ${file}`.cwd(sourceRoot).nothrow();
        }
        const staged = await $`git diff --cached --name-only`.cwd(sourceRoot).nothrow().text();
        if (staged.trim()) {
          const files = staged.trim().split("\n").join(", ");
          await $`git commit -m ${"supervisor: auto-fix from log analysis"}`.cwd(sourceRoot).nothrow();
          selfImproveSuffix = ` [self-improve: committed ${files}]`;
        }
      }
    }
  }

  const lastLine = result.output.trim().split("\n").pop() ?? "";
  const summary = lastLine.replace(/^FLOGVIT-PILOT:DONE:/, "").replace(/^FLOGVIT-PILOT:STUCK:/, "STUCK: ");
  return { success: result.success, summary: summary + selfImproveSuffix };
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

  const { summary } = await runSupervisor({
    targetCwd: cwd,
    errors,
    config,
    selfImprove,
    sourceRoot,
  });
  console.log(`Supervisor: ${summary}`);
}
