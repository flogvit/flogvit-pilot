import { $ } from "bun";

export const LABELS = {
  autofix: "autofix",
  autoImplement: "auto-implement",
  autoReview: "auto-review",
  waiting: "flogvit-coder:waiting",
  inProgress: "flogvit-coder:in-progress",
  failed: "flogvit-coder:failed",
  needsVerify: "flogvit-coder:needs-verify",
  needsReview: "flogvit-coder:needs-review",
  needsAudit: "flogvit-coder:needs-audit",
  approved: "flogvit-coder:approved",
  securityIssue: "flogvit-coder:security-issue",
  changesRequested: "flogvit-coder:changes-requested",
  needsTriage: "flogvit-coder:needs-triage",
  needsPlan: "flogvit-coder:needs-plan",
  ignore: "flogvit-coder:ignore",
} as const;

const LABEL_DEFINITIONS = [
  { name: LABELS.autofix, description: "flogvit-coder: auto-fix this issue", color: "0e8a16" },
  { name: LABELS.autoImplement, description: "flogvit-coder: auto-implement this feature", color: "1d76db" },
  { name: LABELS.autoReview, description: "flogvit-coder: auto-review this PR", color: "5319e7" },
  { name: LABELS.waiting, description: "flogvit-coder: waiting for human input", color: "fbca04" },
  { name: LABELS.inProgress, description: "flogvit-coder: currently working", color: "0075ca" },
  { name: LABELS.failed, description: "flogvit-coder: failed, needs manual help", color: "d73a4a" },
  { name: LABELS.needsVerify, description: "flogvit-coder: run verification (tests)", color: "e4e669" },
  { name: LABELS.needsReview, description: "flogvit-coder: run AI code review", color: "0075ca" },
  { name: LABELS.needsAudit, description: "flogvit-coder: run security audit", color: "5319e7" },
  { name: LABELS.approved, description: "flogvit-coder: approved for merge", color: "0e8a16" },
  { name: LABELS.securityIssue, description: "flogvit-coder: security issue found", color: "d73a4a" },
  { name: LABELS.changesRequested, description: "flogvit-coder: review requested changes", color: "fbca04" },
  { name: LABELS.needsTriage, description: "flogvit-coder: needs triage evaluation", color: "bfd4f2" },
  { name: LABELS.needsPlan, description: "flogvit-coder: needs implementation plan", color: "d4c5f9" },
  { name: LABELS.ignore, description: "flogvit-coder: ignore this issue/PR entirely", color: "eeeeee" },
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

export async function listOpenIssues(cwd: string): Promise<{ number: number; title: string; labels: string[] }[]> {
  const result = await $`gh issue list --state open --limit 100 --json number,title,labels`.cwd(cwd).text();
  const data = JSON.parse(result);
  return data.map((i: { number: number; title: string; labels: { name: string }[] }) => ({
    number: i.number,
    title: i.title,
    labels: i.labels.map((l) => l.name),
  }));
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

export interface PR {
  number: number;
  title: string;
  headBranch: string;
  labels: string[];
  body: string;
}

export async function listPRsWithLabel(label: string, cwd: string): Promise<PR[]> {
  const result = await $`gh pr list --label ${label} --state open --limit 50 --json number,title,headRefName,labels,body`.cwd(cwd).text();
  const data = JSON.parse(result);
  return data.map((pr: { number: number; title: string; headRefName: string; labels: { name: string }[]; body: string }) => ({
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    labels: pr.labels.map((l) => l.name),
    body: pr.body ?? "",
  }));
}

export async function getPR(prNumber: number, cwd: string): Promise<PR> {
  const result = await $`gh pr view ${prNumber} --json number,title,headRefName,labels,body`.cwd(cwd).text();
  const data = JSON.parse(result);
  return {
    number: data.number,
    title: data.title,
    headBranch: data.headRefName,
    labels: data.labels?.map((l: { name: string }) => l.name) ?? [],
    body: data.body ?? "",
  };
}

export async function addPRLabel(prNumber: number, label: string, cwd: string): Promise<void> {
  await $`gh pr edit ${prNumber} --add-label ${label}`.cwd(cwd);
}

export async function removePRLabel(prNumber: number, label: string, cwd: string): Promise<void> {
  await $`gh pr edit ${prNumber} --remove-label ${label}`.cwd(cwd).nothrow();
}

export async function commentOnPR(prNumber: number, body: string, cwd: string): Promise<void> {
  await $`gh pr comment ${prNumber} --body ${body}`.cwd(cwd);
}

export async function getPRDiff(prNumber: number, cwd: string): Promise<string> {
  return await $`gh pr diff ${prNumber}`.cwd(cwd).text();
}

export function extractPRNumber(prUrl: string): number {
  const match = prUrl.match(/\/pull\/(\d+)\/?$/);
  if (!match) return NaN;
  return parseInt(match[1], 10);
}

export async function createPullRequest(
  opts: { title: string; body: string; base?: string },
  cwd: string
): Promise<string> {
  const base = opts.base ?? "main";
  const result = await $`gh pr create --title ${opts.title} --body ${opts.body} --base ${base}`.cwd(cwd).text();
  return result.trim();
}

export async function mergePullRequest(prUrl: string, cwd: string): Promise<void> {
  await $`gh pr merge ${prUrl} --squash --delete-branch`.cwd(cwd);
}

export async function ensureLabels(cwd: string): Promise<void> {
  for (const label of LABEL_DEFINITIONS) {
    await $`gh label create ${label.name} --description ${label.description} --color ${label.color}`.cwd(cwd).nothrow();
  }
}
