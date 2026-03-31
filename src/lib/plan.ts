import { readFile } from "fs/promises";
import { basename } from "path";
import { createIssue, createMilestone, findMilestone, addLabel, LABELS } from "./github";

export interface PlanTask {
  title: string;
  body: string;
}

export interface ParsedPlan {
  title: string;
  description: string;
  tasks: PlanTask[];
}

export function parsePlan(markdown: string): ParsedPlan {
  const lines = markdown.split("\n");

  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : "Untitled Plan";

  const firstTaskIdx = lines.findIndex((l) => /^###\s+Task\s+\d+/i.test(l));
  const description = firstTaskIdx > 0
    ? lines.slice(1, firstTaskIdx).filter((l) => !l.startsWith("#")).join("\n").trim()
    : "";

  const tasks: PlanTask[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^###\s+Task\s+\d+/i.test(lines[i])) {
      const taskTitle = lines[i].replace(/^###\s+Task\s+\d+[:\s]+/i, "").trim();
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !/^###/.test(lines[j])) {
        bodyLines.push(lines[j]);
        j++;
      }
      tasks.push({ title: taskTitle, body: bodyLines.join("\n").trim() });
    }
  }

  return { title, description, tasks };
}

/**
 * Import a plan file as GitHub issues under a milestone.
 * Returns the list of created issue numbers, or null if the plan has no tasks.
 */
export async function importPlanFile(opts: {
  planPath: string;
  parentIssue?: number;
  cwd: string;
  autofix?: boolean;
}): Promise<{ milestoneNumber: number; issueNumbers: number[] } | null> {
  const { planPath, parentIssue, cwd, autofix } = opts;
  const markdown = await readFile(planPath, "utf-8");
  const { title, description, tasks } = parsePlan(markdown);

  if (tasks.length === 0) return null;

  let milestoneNumber = await findMilestone(title, cwd);
  if (milestoneNumber === null) {
    milestoneNumber = await createMilestone(title, description.slice(0, 256), cwd);
  }

  const label = autofix ? LABELS.autofix : null;
  const issueNumbers: number[] = [];

  for (const task of tasks) {
    let body = task.body;
    if (parentIssue) {
      body = `Part of #${parentIssue}\n\n${body}`;
    }
    body += `\n\n---\n*From plan: ${basename(planPath)}*`;

    const labels: string[] = label ? [label] : [];
    const issueNumber = await createIssue(task.title, body, labels, cwd, milestoneNumber);
    if (!label) {
      await addLabel(issueNumber, LABELS.needsTriage, cwd);
    }
    issueNumbers.push(issueNumber);
  }

  return { milestoneNumber, issueNumbers };
}
