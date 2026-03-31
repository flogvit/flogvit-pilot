import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";
import { readdir, readFile, stat, realpath } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
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
  excerpt: string; // last 600 chars max — enough context, not too much
}

export async function scanNewErrorLogs(since: number): Promise<LogError[]> {
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
      if (!fileStat || fileStat.mtimeMs <= since) continue;

      const content = await readFile(filePath, "utf-8").catch(() => "");
      if (!content.trim()) continue;

      const lower = content.toLowerCase();
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
          excerpt: content.trim().slice(-600), // tail of log — where errors usually appear
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
    .map((e) => `**${e.repo}/${e.file}**\n\`\`\`\n${e.excerpt}\n\`\`\``)
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

When done: FLOGVIT-CODER:DONE:<one line summary or "nothing to do">
If stuck: FLOGVIT-CODER:STUCK:<reason>`;

  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  const result = await tool.run({
    prompt,
    cwd: sourceRoot ?? targetCwd,
    jobName: "supervisor",
    fallbackApiKey: config.defaults.fallback_api_key,
    maxTurns: 15, // supervisor should be decisive, not exhaustive
    model: "claude-haiku-4-5", // start cheap — supervisor tasks are usually simple
  });

  // If self-improve and source changed — verify and commit
  if (selfImprove && sourceRoot) {
    const changed = await $`git status --porcelain`.cwd(sourceRoot).nothrow().text();
    if (changed.trim()) {
      const tsc = await $`bun tsc --noEmit`.cwd(sourceRoot).nothrow();
      if (tsc.exitCode !== 0) {
        console.error("[supervisor] TypeScript errors — reverting");
        await $`git checkout -- .`.cwd(sourceRoot).nothrow();
      } else {
        await $`git add -u`.cwd(sourceRoot).nothrow();
        await $`git commit -m ${"supervisor: auto-fix from log analysis"}`.cwd(sourceRoot).nothrow();
      }
    }
  }

  const lastLine = result.output.trim().split("\n").pop() ?? "";
  const summary = lastLine.replace(/^FLOGVIT-CODER:DONE:/, "").replace(/^FLOGVIT-CODER:STUCK:/, "STUCK: ");
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
  const errors = await scanNewErrorLogs(since);
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
