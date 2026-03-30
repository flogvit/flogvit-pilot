import type { Config } from "../lib/config";
import { listIssuesWithLabel, LABELS } from "../lib/github";
import { fixIssue } from "./fix-issue";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issues = await listIssuesWithLabel(LABELS.autofix, cwd);

  if (issues.length === 0) {
    console.log("No issues labeled 'autofix' found.");
    return;
  }

  console.log(`Found ${issues.length} autofix issue(s).`);

  for (const issue of issues) {
    console.log(`\nFixing issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }
}
