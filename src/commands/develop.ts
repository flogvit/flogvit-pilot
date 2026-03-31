import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { homedir } from "os";
import { readdir, readFile, stat, realpath, writeFile, unlink, access } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";

// ---------------------------------------------------------------------------
// Source root resolution
// ---------------------------------------------------------------------------

async function findSourceRoot(): Promise<string | null> {
  // Follow the symlink for `flogvit-pilot` back to the actual source file
  const which = await $`which flogvit-pilot`.nothrow().text();
  const bin = which.trim();
  if (!bin) return null;

  let resolved: string;
  try {
    resolved = await realpath(bin);
  } catch {
    return null;
  }

  // Walk up from the resolved path until we find package.json
  let dir = dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const hasPkg = await access(resolve(dir, "package.json")).then(() => true).catch(() => false);
    if (hasPkg) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Log scanning
// ---------------------------------------------------------------------------

interface LogEntry {
  repo: string;
  file: string;
  content: string;
  hasError: boolean;
}

async function scanLogs(hours: number): Promise<LogEntry[]> {
  const homeDir = process.env.HOME ?? homedir();
  const logBase = resolve(homeDir, ".flogvit-pilot", "logs");
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const entries: LogEntry[] = [];

  const repos = await readdir(logBase).catch(() => [] as string[]);
  for (const repo of repos) {
    if (repo === "active") continue;
    const repoDir = resolve(logBase, repo);
    const files = (await readdir(repoDir).catch(() => [] as string[])).sort().reverse();

    for (const file of files) {
      if (file.endsWith("-agent.log")) continue; // agent output too large, skip
      if (!file.endsWith(".log")) continue;

      const filePath = resolve(repoDir, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || fileStat.mtimeMs < cutoff) continue;

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

      entries.push({ repo, file, content, hasError });
    }
  }

  return entries;
}

function buildLogSummary(entries: LogEntry[]): string {
  if (entries.length === 0) return "No recent logs found.";

  const errorEntries = entries.filter((e) => e.hasError);
  const okEntries = entries.filter((e) => !e.hasError);

  const lines: string[] = [];

  if (errorEntries.length > 0) {
    lines.push(`## Logs with errors/failures (${errorEntries.length} files)\n`);
    for (const e of errorEntries.slice(0, 20)) {
      lines.push(`### ${e.repo}/${e.file}`);
      lines.push("```");
      lines.push(e.content.trim().slice(0, 1500));
      lines.push("```\n");
    }
  }

  if (okEntries.length > 0) {
    lines.push(`## Successful runs (${okEntries.length} files — summaries only)\n`);
    for (const e of okEntries.slice(0, 10)) {
      const lastLine = e.content.trim().split("\n").pop() ?? "";
      lines.push(`- ${e.repo}/${e.file}: ${lastLine}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(sourceRoot: string, logSummary: string): string {
  return `# flogvit-pilot self-improvement task

You are looking at the source code of \`flogvit-pilot\` — the tool that is currently running.
Source root: \`${sourceRoot}\`

Your job is to read the recent logs, identify any bugs or recurring failures, and fix them in the source code.

## Guidelines

- Only fix real issues seen in the logs — do not refactor unrelated code
- Run \`bun tsc --noEmit\` in the source root to verify TypeScript compiles after changes
- Do not add hardcoded test data or debug logging
- Key source files: \`src/commands/fix-issue.ts\`, \`src/commands/fix-pr.ts\`, \`src/commands/watch.ts\`, \`src/lib/github.ts\`, \`src/lib/worktree.ts\`

## Recent logs

${logSummary}

---

When done, output exactly:
FLOGVIT-CODER:DONE:<one-line summary of what was fixed>

If you cannot identify a clear fix, output:
FLOGVIT-CODER:STUCK:<reason>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const autoMode = args.includes("--auto");
  const hoursArg = args.find((a) => a.startsWith("--hours="));
  const hours = hoursArg ? parseInt(hoursArg.split("=")[1], 10) : 24;

  // 1. Find own source root
  const sourceRoot = await findSourceRoot();
  if (!sourceRoot) {
    console.error(
      "Cannot find flogvit-pilot source root.\n" +
      "This command only works when installed via `bun link` from the source directory.\n" +
      "It will not work with brew, bunx, or global npm installs."
    );
    process.exit(1);
  }
  console.log(`Source root: ${sourceRoot}`);

  // 2. Scan logs
  console.log(`Scanning logs from the last ${hours} hours...`);
  const logEntries = await scanLogs(hours);
  const errorCount = logEntries.filter((e) => e.hasError).length;
  console.log(`Found ${logEntries.length} log files (${errorCount} with errors/failures)`);

  if (logEntries.length === 0) {
    console.log("No recent logs found. Nothing to analyze.");
    return;
  }

  const logSummary = buildLogSummary(logEntries);
  const prompt = buildPrompt(sourceRoot, logSummary);

  const gitStatus = await $`git status --porcelain`.cwd(sourceRoot).nothrow().text();
  if (gitStatus.trim()) {
    console.warn("Warning: source repo has uncommitted changes — develop will work on top of them.");
  }

  // 4. Write TASK.md
  const taskFile = resolve(sourceRoot, "TASK.md");
  await writeFile(taskFile, prompt);

  // 5. Run Claude
  if (autoMode) {
    console.log("Running in autonomous mode...\n");

    const toolName = resolveToolForCommand(config, "fix-issue");
    const tool = getTool(toolName);
    const toolConfig = config.tools[toolName] ?? {};

    const result = await tool.run({
      prompt,
      cwd: sourceRoot,
      jobName: "develop",
      fallbackApiKey: config.defaults.fallback_api_key,
      maxTurns: (toolConfig["max-turns"] as number) ?? 30,
    });

    await unlink(taskFile).catch(() => {});

    if (!result.success) {
      console.error("develop: agent did not complete successfully — no changes applied");
      return;
    }
  } else {
    console.log("Starting Claude Code... (close the session when done)\n");

    const proc = Bun.spawn(
      ["claude", "Read TASK.md for context about bugs to fix in this codebase."],
      { cwd: sourceRoot, stdin: "inherit", stdout: "inherit", stderr: "inherit" }
    );

    await proc.exited;
    await unlink(taskFile).catch(() => {});
  }

  // 6. Type-check — hard gate before touching anything
  console.log("develop: checking TypeScript...");
  const tscResult = await $`bun tsc --noEmit`.cwd(sourceRoot).nothrow();
  if (tscResult.exitCode !== 0) {
    console.error("develop: TypeScript errors — changes discarded\n" + tscResult.stderr.slice(0, 800));
    await $`git checkout -- .`.cwd(sourceRoot).nothrow();
    return;
  }

  // 7. Check for changes
  const changed = await $`git status --porcelain`.cwd(sourceRoot).nothrow().text();
  if (!changed.trim()) {
    console.log("develop: no changes made");
    return;
  }

  // 8. Commit
  //    --auto: commit directly on current branch — active immediately (bun link)
  //    interactive: create a branch so changes can be reviewed/discarded
  if (autoMode) {
    await $`git add -A`.cwd(sourceRoot);
    await $`git commit -m ${"develop: auto-fix from log analysis"}`.cwd(sourceRoot);
    console.log("develop: fix committed — active immediately");
  } else {
    const branchSuffix = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
    const branch = `develop/fix-${branchSuffix}`;
    await $`git checkout -b ${branch}`.cwd(sourceRoot).nothrow();
    await $`git add -A`.cwd(sourceRoot);
    await $`git commit -m ${"develop: fix from log analysis"}`.cwd(sourceRoot);

    // Merge back to main and return to it
    await $`git checkout main`.cwd(sourceRoot).nothrow();
    const mergeResult = await $`git merge --no-ff ${branch} -m ${"develop: merge fix from log analysis"}`.cwd(sourceRoot).nothrow();
    if (mergeResult.exitCode !== 0) {
      console.error("develop: merge failed — changes are on branch", branch);
      return;
    }
    await $`git branch -d ${branch}`.cwd(sourceRoot).nothrow();
    console.log(`\n✅ Fix merged to main — active immediately`);
  }
}
