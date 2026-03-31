import { resolve, basename } from "path";
import type { Config } from "../lib/config";
import { parsePlan, importPlanFile } from "../lib/plan";
import { readFile } from "fs/promises";

export async function run(args: string[], _config: Config, cwd: string): Promise<void> {
  const planArg = args.find((a) => !a.startsWith("--"));
  if (!planArg) {
    console.error("Usage: flogvit-pilot import-plan <plan-file> [--autofix] [--dry-run]");
    process.exit(1);
  }

  const autofix = args.includes("--autofix");
  const dryRun = args.includes("--dry-run");

  const planPath = resolve(cwd, planArg);
  const markdown = await readFile(planPath, "utf-8");
  const { title, tasks } = parsePlan(markdown);

  // Detect parent issue from filename (e.g. issue-1-...)
  const parentMatch = basename(planArg).match(/^issue-(\d+)-/);
  const parentIssue = parentMatch ? parseInt(parentMatch[1], 10) : undefined;

  console.log(`Plan: ${title}`);
  console.log(`Tasks: ${tasks.length}`);
  if (parentIssue) console.log(`Parent issue: #${parentIssue}`);
  console.log();

  if (tasks.length === 0) {
    console.error("No tasks found in plan (expected \"### Task N: ...\" sections)");
    process.exit(1);
  }

  if (dryRun) {
    for (const task of tasks) {
      console.log(`  [dry-run] Would create issue: "${task.title}"`);
    }
    return;
  }

  const result = await importPlanFile({ planPath, parentIssue, cwd, autofix });
  if (!result) {
    console.error("No tasks found after parsing.");
    process.exit(1);
  }

  console.log(`Created milestone #${result.milestoneNumber}: "${title}"`);
  for (const num of result.issueNumbers) {
    console.log(`  Created issue #${num}`);
  }
  console.log(`\nDone — ${result.issueNumbers.length} issues under milestone "${title}"`);
}
