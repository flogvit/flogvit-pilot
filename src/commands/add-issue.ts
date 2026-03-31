import type { Config } from "../lib/config";
import { createIssue, addLabel, LABELS } from "../lib/github";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const titleIndex = args.findIndex((a) => !a.startsWith("--"));
  if (titleIndex === -1) {
    console.error("Usage: flogvit-pilot add-issue <title> [body] [--autofix] [--label <label>]");
    process.exit(1);
  }

  const title = args[titleIndex];
  const body = args[titleIndex + 1] && !args[titleIndex + 1].startsWith("--")
    ? args[titleIndex + 1]
    : "";

  const autofix = args.includes("--autofix");

  const labelIndex = args.indexOf("--label");
  const extraLabel = labelIndex !== -1 ? args[labelIndex + 1] : undefined;

  const labels: string[] = [];
  if (autofix) labels.push(LABELS.autofix);
  if (extraLabel) labels.push(extraLabel);

  const issueNumber = await createIssue(title, body, labels, cwd);
  console.log(`Created issue #${issueNumber}: ${title}`);
  if (labels.length > 0) {
    console.log(`Labels: ${labels.join(", ")}`);
  }

  // If no label given, add needs-triage so watch picks it up
  if (labels.length === 0) {
    await addLabel(issueNumber, LABELS.needsTriage, cwd);
    console.log(`Added label: ${LABELS.needsTriage}`);
  }
}
