import { $ } from "bun";

export const LABELS = {
  autofix: "autofix",
  autoImplement: "auto-implement",
  autoReview: "auto-review",
  waiting: "flogvit-coder:waiting",
  inProgress: "flogvit-coder:in-progress",
  failed: "flogvit-coder:failed",
} as const;

const LABEL_DEFINITIONS = [
  { name: LABELS.autofix, description: "flogvit-coder: auto-fix this issue", color: "0e8a16" },
  { name: LABELS.autoImplement, description: "flogvit-coder: auto-implement this feature", color: "1d76db" },
  { name: LABELS.autoReview, description: "flogvit-coder: auto-review this PR", color: "5319e7" },
  { name: LABELS.waiting, description: "flogvit-coder: waiting for human input", color: "fbca04" },
  { name: LABELS.inProgress, description: "flogvit-coder: currently working", color: "0075ca" },
  { name: LABELS.failed, description: "flogvit-coder: failed, needs manual help", color: "d73a4a" },
];

export function formatIssueComment(
  status: string,
  message: string
): string {
  return `🤖 **flogvit-coder** — ${status}\n\n${message}`;
}

export function parseBranchName(
  type: "fix" | "impl" | "refactor",
  identifier: number | string
): string {
  if (typeof identifier === "number") {
    return `flogvit-coder/${type}-${identifier}`;
  }
  const sanitized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s-]+/g, "-");
  return `flogvit-coder/${type}-${sanitized}`;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: { body: string; author: string; createdAt: string }[];
}

export async function getIssue(issueNum: number, cwd: string): Promise<Issue> {
  const result = await $`gh issue view ${issueNum} --json number,title,body,labels,comments`.cwd(cwd).text();
  const data = JSON.parse(result);
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    labels: data.labels?.map((l: { name: string }) => l.name) ?? [],
    comments: data.comments?.map((c: { body: string; author: { login: string }; createdAt: string }) => ({
      body: c.body,
      author: c.author.login,
      createdAt: c.createdAt,
    })) ?? [],
  };
}

export async function listIssuesWithLabel(
  label: string,
  cwd: string
): Promise<{ number: number; title: string }[]> {
  const result = await $`gh issue list --label ${label} --state open --limit 50 --json number,title`.cwd(cwd).text();
  return JSON.parse(result);
}

export async function addLabel(
  issueNum: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh issue edit ${issueNum} --add-label ${label}`.cwd(cwd);
}

export async function removeLabel(
  issueNum: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh issue edit ${issueNum} --remove-label ${label}`.cwd(cwd).nothrow();
}

export async function commentOnIssue(
  issueNum: number,
  body: string,
  cwd: string
): Promise<void> {
  await $`gh issue comment ${issueNum} --body ${body}`.cwd(cwd);
}

export async function createPullRequest(
  opts: { title: string; body: string; base?: string },
  cwd: string
): Promise<string> {
  const base = opts.base ?? "main";
  const result = await $`gh pr create --title ${opts.title} --body ${opts.body} --base ${base}`.cwd(cwd).text();
  return result.trim();
}

export async function ensureLabels(cwd: string): Promise<void> {
  for (const label of LABEL_DEFINITIONS) {
    await $`gh label create ${label.name} --description ${label.description} --color ${label.color}`.cwd(cwd).nothrow();
  }
}
