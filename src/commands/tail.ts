import { resolve, basename } from "path";
import { homedir } from "os";
import { readFile, readdir } from "fs/promises";
import type { Config } from "../lib/config";

export async function run(args: string[], _config: Config, cwd: string): Promise<void> {
  const homeDir = process.env.HOME ?? homedir();
  const repoName = basename(cwd);
  const logDir = resolve(homeDir, ".flogvit-pilot", "logs", repoName);

  // If no argument: list all active jobs
  if (args.length === 0) {
    const activeDir = resolve(logDir, "active");
    const markers = await readdir(activeDir).catch(() => []);
    if (markers.length === 0) {
      console.log("No active jobs.");
      return;
    }
    console.log("Active jobs:");
    for (const marker of markers.sort()) {
      const logFile = await readFile(resolve(activeDir, marker), "utf-8").catch(() => "");
      console.log(`  ${marker.padEnd(24)} → ${logFile.trim()}`);
    }
    return;
  }

  const jobArg = args[0];
  // Accept either "fix-18" or just "18"
  const issueNum = parseInt(jobArg, 10);
  const jobName = isNaN(issueNum) ? jobArg : `fix-${issueNum}`;

  const activeDir = resolve(logDir, "active");
  const markerPath = resolve(activeDir, jobName);

  let logFile: string | null = null;

  // Try active marker first
  try {
    logFile = (await readFile(markerPath, "utf-8")).trim();
    console.log(`Tailing active job '${jobName}'... (Ctrl+C to stop)\n`);
  } catch {
    // Fall back: find most recent agent log matching the job type
    const allFiles = await readdir(logDir).catch(() => [] as string[]);
    const prefix = isNaN(issueNum) ? jobName : "fix-issue";
    const matching = allFiles
      .filter((f) => f.includes(prefix) && f.endsWith("-agent.log"))
      .sort()
      .reverse();

    if (matching.length === 0) {
      console.error(`No log found for '${jobName}'. Is the job running?`);
      console.error(`Run 'flogvit-pilot tail' (no args) to list active jobs.`);
      process.exit(1);
    }

    logFile = resolve(logDir, matching[0]);
    console.log(`No active job found for '${jobName}'. Showing most recent log: ${matching[0]}\n`);
  }

  // Spawn tail -f -n +1 to stream from the beginning and follow
  const proc = Bun.spawn(["tail", "-f", "-n", "+1", logFile], {
    stdout: "inherit",
    stderr: "inherit",
  });

  // Let tail run until user hits Ctrl+C
  process.once("SIGINT", () => {
    proc.kill();
    process.exit(0);
  });

  await proc.exited;
}
