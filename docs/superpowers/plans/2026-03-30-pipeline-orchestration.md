# Pipeline Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a label-driven pipeline where watch orchestrates fix→verify→review→audit→merge stages autonomously, each running in isolated git worktrees.

**Architecture:** Each pipeline stage is a separate command. GitHub PR labels act as the state machine (needs-verify → needs-review → needs-audit → approved → merged). watch dispatches stages and in --live mode shows a live terminal UI. Each job runs in its own worktree under ~/.flogvit-coder/worktrees/ enabling parallelism.

**Tech Stack:** Bun, TypeScript, gh CLI for GitHub, git worktree for isolation.

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/lib/github.ts` | Add PR label functions and new pipeline labels |
| `src/lib/worktree.ts` | Create/remove git worktrees in ~/.flogvit-coder/worktrees/ |
| `src/lib/pipeline.ts` | Pipeline stage types and STAGE_LABELS mapping |
| `src/commands/fix-issue.ts` | Refactor: use worktree, stop at PR with needs-verify label |
| `src/commands/verify.ts` | Run tests in worktree, advance label to needs-review |
| `src/commands/verify.md` | (no AI prompt needed — runs test command directly) |
| `src/commands/review-pr.ts` | AI reviews PR diff, advances label to needs-audit |
| `src/commands/review-pr.md` | AI prompt for code review |
| `src/commands/audit-pr.ts` | AI audits PR diff for security, advances label to approved |
| `src/commands/audit-pr.md` | AI prompt for security audit |
| `src/commands/merge.ts` | Merge all approved PRs |
| `src/commands/watch.ts` | Rewrite: cron mode dispatches pipeline stages; --live shows TUI |
| `tests/lib/github.test.ts` | Add tests for new PR functions |
| `tests/lib/worktree.test.ts` | Tests for pure worktree path functions |
| `tests/lib/pipeline.test.ts` | Tests for pipeline types and STAGE_LABELS |

---

## Task 1: PR labels + github.ts PR functions

**Files:**
- Modify: `src/lib/github.ts`
- Modify: `tests/lib/github.test.ts`

- [ ] **Step 1: Write failing tests for the new functions in tests/lib/github.test.ts**

Add these tests to the existing `tests/lib/github.test.ts` file (below the existing LABELS describe block):

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  formatIssueComment,
  parseBranchName,
  LABELS,
  extractPRNumber,
} from "../../src/lib/github";

// ... existing tests ...

describe("LABELS pipeline additions", () => {
  test("has needsVerify label", () => {
    expect(LABELS.needsVerify).toBe("flogvit-coder:needs-verify");
  });

  test("has needsReview label", () => {
    expect(LABELS.needsReview).toBe("flogvit-coder:needs-review");
  });

  test("has needsAudit label", () => {
    expect(LABELS.needsAudit).toBe("flogvit-coder:needs-audit");
  });

  test("has approved label", () => {
    expect(LABELS.approved).toBe("flogvit-coder:approved");
  });

  test("has securityIssue label", () => {
    expect(LABELS.securityIssue).toBe("flogvit-coder:security-issue");
  });

  test("has changesRequested label", () => {
    expect(LABELS.changesRequested).toBe("flogvit-coder:changes-requested");
  });
});

describe("extractPRNumber", () => {
  test("extracts PR number from full GitHub URL", () => {
    expect(extractPRNumber("https://github.com/org/repo/pull/26")).toBe(26);
  });

  test("extracts PR number from URL with trailing slash", () => {
    expect(extractPRNumber("https://github.com/org/repo/pull/100/")).toBe(100);
  });

  test("returns NaN for invalid URL", () => {
    expect(extractPRNumber("not-a-url")).toBeNaN();
  });

  test("works with single-digit PR numbers", () => {
    expect(extractPRNumber("https://github.com/my-org/my-repo/pull/1")).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests — they must fail**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/github.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Implement changes in src/lib/github.ts**

Extend `LABELS` with the six new pipeline entries:

```typescript
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
} as const;
```

Extend `LABEL_DEFINITIONS` with the six new entries (appended to existing array):

```typescript
  { name: LABELS.needsVerify, description: "flogvit-coder: run verification (tests)", color: "e4e669" },
  { name: LABELS.needsReview, description: "flogvit-coder: run AI code review", color: "0075ca" },
  { name: LABELS.needsAudit, description: "flogvit-coder: run security audit", color: "5319e7" },
  { name: LABELS.approved, description: "flogvit-coder: approved for merge", color: "0e8a16" },
  { name: LABELS.securityIssue, description: "flogvit-coder: security issue found", color: "d73a4a" },
  { name: LABELS.changesRequested, description: "flogvit-coder: review requested changes", color: "fbca04" },
```

Add the `PR` interface and new functions after the existing `Issue` interface and functions:

```typescript
export interface PR {
  number: number;
  title: string;
  headBranch: string;
  labels: string[];
  body: string;
}

export async function listPRsWithLabel(
  label: string,
  cwd: string
): Promise<PR[]> {
  const result = await $`gh pr list --label ${label} --state open --limit 50 --json number,title,headRefName,labels`.cwd(cwd).text();
  const data = JSON.parse(result);
  return data.map((pr: { number: number; title: string; headRefName: string; labels: { name: string }[] }) => ({
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    labels: pr.labels.map((l) => l.name),
    body: "",
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

export async function addPRLabel(
  prNumber: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh pr edit ${prNumber} --add-label ${label}`.cwd(cwd);
}

export async function removePRLabel(
  prNumber: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh pr edit ${prNumber} --remove-label ${label}`.cwd(cwd).nothrow();
}

export async function commentOnPR(
  prNumber: number,
  body: string,
  cwd: string
): Promise<void> {
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
```

- [ ] **Step 4: Run tests — they must pass**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/github.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/lib/github.ts tests/lib/github.test.ts && git commit -m "feat: add PR label functions and pipeline labels to github.ts"
```

---

## Task 2: Worktree module

**Files:**
- Create: `src/lib/worktree.ts`
- Create: `tests/lib/worktree.test.ts`

- [ ] **Step 1: Write tests for pure functions in tests/lib/worktree.test.ts**

```typescript
import { describe, test, expect } from "bun:test";
import { worktreesBaseDir, worktreePath } from "../../src/lib/worktree";

describe("worktreesBaseDir", () => {
  test("builds base dir under ~/.flogvit-coder/worktrees/repoName", () => {
    const result = worktreesBaseDir("/home/user", "my-repo");
    expect(result).toBe("/home/user/.flogvit-coder/worktrees/my-repo");
  });

  test("handles different home directories", () => {
    const result = worktreesBaseDir("/Users/alice", "flogvit");
    expect(result).toBe("/Users/alice/.flogvit-coder/worktrees/flogvit");
  });
});

describe("worktreePath", () => {
  test("builds worktree path for a job", () => {
    const result = worktreePath("/home/user", "my-repo", "fix-42");
    expect(result).toBe("/home/user/.flogvit-coder/worktrees/my-repo/fix-42");
  });

  test("builds worktree path for verify job", () => {
    const result = worktreePath("/home/user", "my-repo", "verify-26");
    expect(result).toBe("/home/user/.flogvit-coder/worktrees/my-repo/verify-26");
  });

  test("builds worktree path for review job", () => {
    const result = worktreePath("/Users/vhanssen", "flogvit-coder", "review-pr-7");
    expect(result).toBe("/Users/vhanssen/.flogvit-coder/worktrees/flogvit-coder/review-pr-7");
  });
});
```

- [ ] **Step 2: Run tests — they must fail**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/worktree.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Create src/lib/worktree.ts**

```typescript
import { $ } from "bun";
import { join } from "path";
import { mkdir, rm } from "fs/promises";

export function worktreesBaseDir(homeDir: string, repoName: string): string {
  return join(homeDir, ".flogvit-coder", "worktrees", repoName);
}

export function worktreePath(homeDir: string, repoName: string, jobName: string): string {
  return join(worktreesBaseDir(homeDir, repoName), jobName);
}

export async function createWorktree(path: string, branch: string, cwd: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await $`git worktree add ${path} -b ${branch}`.cwd(cwd);
}

export async function createWorktreeFromRemote(path: string, branch: string, cwd: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await $`git fetch origin ${branch}`.cwd(cwd);
  await $`git worktree add ${path} origin/${branch}`.cwd(cwd);
}

export async function removeWorktree(path: string, cwd: string): Promise<void> {
  await $`git worktree remove ${path} --force`.cwd(cwd).nothrow();
  await rm(path, { recursive: true, force: true });
  await $`git worktree prune`.cwd(cwd).nothrow();
}
```

- [ ] **Step 4: Run tests — they must pass**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/worktree.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/lib/worktree.ts tests/lib/worktree.test.ts && git commit -m "feat: add worktree module"
```

---

## Task 3: Pipeline types

**Files:**
- Create: `src/lib/pipeline.ts`
- Create: `tests/lib/pipeline.test.ts`

- [ ] **Step 1: Write tests in tests/lib/pipeline.test.ts**

```typescript
import { describe, test, expect } from "bun:test";
import { STAGE_LABELS, PIPELINE_STAGES, type PipelineStage } from "../../src/lib/pipeline";
import { LABELS } from "../../src/lib/github";

describe("STAGE_LABELS", () => {
  test("verify maps to needsVerify label", () => {
    expect(STAGE_LABELS.verify).toBe(LABELS.needsVerify);
  });

  test("review maps to needsReview label", () => {
    expect(STAGE_LABELS.review).toBe(LABELS.needsReview);
  });

  test("audit maps to needsAudit label", () => {
    expect(STAGE_LABELS.audit).toBe(LABELS.needsAudit);
  });

  test("merge maps to approved label", () => {
    expect(STAGE_LABELS.merge).toBe(LABELS.approved);
  });
});

describe("PIPELINE_STAGES", () => {
  test("contains all four stages in order", () => {
    expect(PIPELINE_STAGES).toEqual(["verify", "review", "audit", "merge"]);
  });

  test("has exactly four stages", () => {
    expect(PIPELINE_STAGES).toHaveLength(4);
  });
});

describe("PipelineJob type", () => {
  test("can construct a valid PipelineJob", () => {
    const job: import("../../src/lib/pipeline").PipelineJob = {
      prNumber: 42,
      prTitle: "Fix: update login flow",
      headBranch: "flogvit-coder/fix-42",
      stage: "verify",
    };
    expect(job.prNumber).toBe(42);
    expect(job.stage).toBe("verify");
  });
});
```

- [ ] **Step 2: Run tests — they must fail**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/pipeline.test.ts 2>&1 | tail -20
```

- [ ] **Step 3: Create src/lib/pipeline.ts**

```typescript
import { LABELS } from "./github";

export type PipelineStage = "verify" | "review" | "audit" | "merge";

export interface PipelineJob {
  prNumber: number;
  prTitle: string;
  headBranch: string;
  stage: PipelineStage;
}

export const STAGE_LABELS: Record<PipelineStage, string> = {
  verify: LABELS.needsVerify,
  review: LABELS.needsReview,
  audit: LABELS.needsAudit,
  merge: LABELS.approved,
};

export const PIPELINE_STAGES: PipelineStage[] = ["verify", "review", "audit", "merge"];
```

- [ ] **Step 4: Run tests — they must pass**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/pipeline.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/lib/pipeline.ts tests/lib/pipeline.test.ts && git commit -m "feat: add pipeline types"
```

---

## Task 4: fix-issue refactor + model aliases

**Files:**
- Modify: `src/lib/config.ts` — add `model?` to ToolConfig, `retry_model?` to CommandConfig
- Modify: `src/lib/tool-runner.ts` — add `model?` to ToolRunnerOptions
- Modify: `src/lib/tools/claude.ts` — pass `--model` flag when model is set
- Modify: `src/commands/fix-issue.ts` — use worktree, stop at PR, pass model from config

### Model alias sub-task

**Step 0a: Add `model` to ToolConfig and `retry_model` to CommandConfig in src/lib/config.ts**

`ToolConfig` already has `[key: string]: string | number | boolean | string[]` so `model` is stored automatically. But add explicit typed fields for IDE support:

```typescript
export interface ToolConfig {
  model?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface CommandConfig {
  tool?: string;
  retry_model?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}
```

**Step 0b: Add `model?` to ToolRunnerOptions in src/lib/tool-runner.ts**

```typescript
export interface ToolRunnerOptions {
  prompt: string;
  cwd: string;
  jobName?: string;
  fallbackApiKey?: string;
  verbose?: boolean;
  model?: string;
  onChunk?: (chunk: string) => void;
  allowedTools?: string[];
  maxTurns?: number;
}
```

**Step 0c: Pass `--model` in ClaudeRunner.buildArgs in src/lib/tools/claude.ts**

Add after the `--name` block:

```typescript
    if (opts.model) {
      args.push("--model", opts.model);
    }
```

**Step 0d: Pass `model` and `retry_model` from fix-issue**

In `fixIssue()`, accept an optional `retryModel` parameter and pass it through:

```typescript
export async function fixIssue(
  issueNum: number,
  config: Config,
  cwd: string,
  verbose: boolean = false,
  retryModel?: string
): Promise<{ success: boolean; prUrl?: string }>
```

Then in the `tool.run()` call:
```typescript
  const commandConfig = config.commands["fix-issue"] ?? {};
  const model = retryModel ?? (config.tools[toolName]?.model as string | undefined);
  const result = await tool.run({
    ...
    model,
    ...
  });
```

In the config, users can set:
```toml
[tools.claude]
model = "sonnet"

[commands.fix-issue]
retry_model = "opus"
```

Watch will call `fixIssue(num, config, cwd, false, commandConfig.retry_model)` when re-trying after `changes-requested`.

- [ ] **Step 1: Update imports in fix-issue.ts**

Replace the existing import block at the top of `src/commands/fix-issue.ts`. Add the worktree imports and the new GitHub PR functions, and remove `mergePullRequest` since fix-issue no longer merges:

```typescript
import { $ } from "bun";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  createPullRequest,
  addPRLabel,
  formatIssueComment,
  parseBranchName,
  extractPRNumber,
  LABELS,
  type Issue,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { saveState, clearState } from "../lib/state";
import { Logger } from "../lib/logger";
import { createWorktree, removeWorktree, worktreePath } from "../lib/worktree";

const __dirname = dirname(fileURLToPath(import.meta.url));
```

- [ ] **Step 2: Replace the branch creation and AI run section**

In `fixIssue()`, replace the `git checkout -b ${branch}` line and subsequent AI tool invocation so the agent runs in the worktree instead of `cwd`:

```typescript
  // Create worktree for isolation
  const homeDir = process.env.HOME ?? "~";
  const repoName = basename(cwd);
  const branch = parseBranchName("fix", issueNum);
  const wtPath = worktreePath(homeDir, repoName, `fix-${issueNum}`);
  await createWorktree(wtPath, branch, cwd);

  // Run AI tool inside the worktree
  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for issue #${issueNum}`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd: wtPath,
    jobName: `fix-issue-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });
```

- [ ] **Step 3: Update the diffResult check to use wtPath**

```typescript
  const diffResult = await $`git diff --stat`.cwd(wtPath).text();
  const hasChanges = diffResult.trim().length > 0;
```

- [ ] **Step 4: Update the commit/push/PR section and remove test + merge**

Replace the entire block from `// Commit, push, create PR` onwards (the code that runs tests and merges) with this new version that adds the needs-verify label and removes the worktree:

```typescript
  // Commit, push, create PR
  await $`git add -A`.cwd(wtPath);
  await $`git restore --staged .claude/worktrees`.cwd(wtPath).nothrow();
  await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(wtPath);
  await $`git push -u origin ${branch}`.cwd(wtPath);

  const prUrl = await createPullRequest(
    {
      title: `Fix #${issueNum}: ${issue.title}`,
      body: `## Summary\n\nAutomatically fixes #${issueNum}.\n\n${parsed.message || result.summary}\n\n---\n🤖 Generated by flogvit-coder`,
      base: repoContext.defaultBranch,
    },
    cwd
  );

  const prNumber = extractPRNumber(prUrl);
  await addPRLabel(prNumber, LABELS.needsVerify, cwd);

  await removeWorktree(wtPath, cwd);
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removeLabel(issueNum, LABELS.inProgress, cwd);
  await clearState(stateDir, repoContext.repoName, issueNum);

  logger.summary(`Issue #${issueNum}: PR created — ${prUrl}`);
  return { success: true, prUrl };
```

- [ ] **Step 5: Update the cleanup handler in fixIssue to also remove the worktree**

The `cleanup` function runs on SIGINT/SIGTERM. Update it to remove the worktree if it was already created. Since `wtPath` is declared before the cleanup handler but `createWorktree` runs after, restructure the function so `wtPath` is in scope when cleanup is defined:

Move the `homeDir`, `repoName`, `branch`, and `wtPath` declarations to just after `addLabel(issueNum, LABELS.inProgress, cwd)` and before the `cleanup` closure, then reference `wtPath` in cleanup:

```typescript
  const homeDir = process.env.HOME ?? "~";
  const repoName = basename(cwd);
  const branch = parseBranchName("fix", issueNum);
  const wtPath = worktreePath(homeDir, repoName, `fix-${issueNum}`);

  await addLabel(issueNum, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removeLabel(issueNum, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
```

- [ ] **Step 6: Update the stuck / no-changes branches to use wtPath and remove the worktree**

For the "stuck" path (no changes made, agent asks a question), remove the worktree before returning:

```typescript
    await removeWorktree(wtPath, cwd).catch(() => {});
    logger.summary(`Issue #${issueNum}: stuck — asked question on issue`);
    return { success: false };
```

For the "no changes" path:

```typescript
  if (!hasChanges) {
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await removeWorktree(wtPath, cwd);
    logger.summary(`Issue #${issueNum}: no changes made`);
    return { success: false };
  }
```

- [ ] **Step 7: Run the full test suite to check nothing is broken**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 8: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/fix-issue.ts && git commit -m "refactor: fix-issue uses worktree, stops at PR with needs-verify label"
```

---

## Task 5: verify command

**Files:**
- Create: `src/commands/verify.ts`
- Modify: `src/cli.ts` (verify is already registered — confirm it points to the right module)

Note: `verify` is already registered in `src/cli.ts` as `() => import("./commands/verify")`. This task replaces the existing stub with the real implementation.

- [ ] **Step 1: Create src/commands/verify.ts**

```typescript
import { resolve, basename } from "path";
import type { Config } from "../lib/config";
import {
  getPR,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { createWorktreeFromRemote, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { Logger } from "../lib/logger";

export async function verifyPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? "~";
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "verify", verbose });

  const pr = await getPR(prNumber, cwd);
  const wtPath = worktreePath(homeDir, repoName, `verify-${prNumber}`);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  await createWorktreeFromRemote(wtPath, pr.headBranch, cwd);

  const repoContext = await gatherRepoContext(wtPath);

  if (!repoContext.testCommand) {
    logger.summary(`PR #${prNumber}: no test command found, skipping verify`);
    await removePRLabel(prNumber, LABELS.needsVerify, cwd);
    await addPRLabel(prNumber, LABELS.needsReview, cwd);
    await removeWorktree(wtPath, cwd);
    process.off("SIGINT", cleanup);
    process.off("SIGTERM", cleanup);
    await removePRLabel(prNumber, LABELS.inProgress, cwd);
    return { success: true };
  }

  logger.detail(`Running: ${repoContext.testCommand}`);
  const [cmd, ...args] = repoContext.testCommand.split(" ");
  const proc = Bun.spawn([cmd, ...args], { cwd: wtPath, stdout: "pipe", stderr: "pipe" });
  const testOut = await new Response(proc.stdout).text();
  const testErr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  await removeWorktree(wtPath, cwd);
  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsVerify, cwd);

  if (exitCode !== 0) {
    const output = `${testOut}\n${testErr}`.trim().slice(0, 3000);
    await commentOnPR(
      prNumber,
      formatIssueComment("verify failed", `\`\`\`\n${output}\n\`\`\``),
      cwd
    );
    await addPRLabel(prNumber, LABELS.failed, cwd);
    logger.summary(`PR #${prNumber}: tests failed`);
    return { success: false };
  }

  await addPRLabel(prNumber, LABELS.needsReview, cwd);
  logger.summary(`PR #${prNumber}: tests passed`);
  return { success: true };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-coder verify <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await verifyPR(prNumber, config, cwd, verbose);
}
```

- [ ] **Step 2: Confirm verify is registered in cli.ts**

Check that `src/cli.ts` already has:
```typescript
  verify: () => import("./commands/verify"),
```

If it does, no change needed. If the import points elsewhere or is missing, add/fix it.

- [ ] **Step 3: Run tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 4: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/verify.ts && git commit -m "feat: implement verify command"
```

---

## Task 6: review-pr command + prompt

**Files:**
- Create: `src/commands/review-pr.md`
- Create: `src/commands/review-pr.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create src/commands/review-pr.md**

```markdown
You are an autonomous code reviewer for a pull request.

## Pull Request Diff

```diff
{{pr_diff}}
```

## Repository Context

- **Repository:** {{repo_name}}
- **Language:** {{language}}

## Instructions

Review the diff above for:

1. **Correctness** — does the logic do what it claims? Are there off-by-one errors, null-pointer risks, or incorrect assumptions?
2. **Code quality** — is the code readable, well-named, and following the conventions already present in the repo?
3. **Performance** — are there obvious inefficiencies such as N+1 queries, unnecessary re-computation, or blocking operations?
4. **Test coverage** — are the changes tested? If not, is this acceptable given the nature of the change?

## Rules

- Be concise. Focus only on meaningful issues, not style nits.
- If the PR is acceptable (no blocking issues), end your response with EXACTLY this on the last line:
  `FLOGVIT-CODER:REVIEW:APPROVE: <one sentence why it looks good>`
- If the PR has issues that should be fixed before merging, end your response with EXACTLY this on the last line:
  `FLOGVIT-CODER:REVIEW:CHANGES-REQUESTED: <one sentence describing the main concern>`
```

- [ ] **Step 2: Create src/commands/review-pr.ts**

```typescript
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getPR,
  getPRDiff,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { Logger } from "../lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function reviewPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? "~";
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "review-pr", verbose });

  const pr = await getPR(prNumber, cwd);
  const diff = await getPRDiff(prNumber, cwd);
  const repoContext = await gatherRepoContext(cwd);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("review-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    pr_diff: diff,
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "review-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for PR #${prNumber} review`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `review-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsReview, cwd);

  const lines = result.output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("FLOGVIT-CODER:REVIEW:APPROVE:")) {
      const reason = line.replace("FLOGVIT-CODER:REVIEW:APPROVE:", "").trim();
      await addPRLabel(prNumber, LABELS.needsAudit, cwd);
      logger.summary(`PR #${prNumber}: review approved — ${reason}`);
      return { success: true };
    }
    if (line.startsWith("FLOGVIT-CODER:REVIEW:CHANGES-REQUESTED:")) {
      const reason = line.replace("FLOGVIT-CODER:REVIEW:CHANGES-REQUESTED:", "").trim();
      await addPRLabel(prNumber, LABELS.changesRequested, cwd);
      await commentOnPR(
        prNumber,
        formatIssueComment("review: changes requested", reason),
        cwd
      );
      logger.summary(`PR #${prNumber}: changes requested — ${reason}`);
      return { success: false };
    }
  }

  // Couldn't parse a verdict — treat as inconclusive, don't advance
  logger.summary(`PR #${prNumber}: review produced no clear verdict`);
  await addPRLabel(prNumber, LABELS.needsReview, cwd);
  return { success: false };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-coder review-pr <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await reviewPR(prNumber, config, cwd, verbose);
}
```

- [ ] **Step 3: Register review-pr in src/cli.ts**

Add to the `COMMANDS` map:

```typescript
  "review-pr": () => import("./commands/review-pr"),
```

Also add to the help text in `main()`:

```
  review-pr <#>       AI code review of a PR → advance to needs-audit
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 5: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/review-pr.ts src/commands/review-pr.md src/cli.ts && git commit -m "feat: implement review-pr command"
```

---

## Task 7: audit-pr command + prompt

**Files:**
- Create: `src/commands/audit-pr.md`
- Create: `src/commands/audit-pr.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create src/commands/audit-pr.md**

```markdown
You are an autonomous security auditor for a pull request.

## Pull Request Diff

```diff
{{pr_diff}}
```

## Repository Context

- **Repository:** {{repo_name}}
- **Language:** {{language}}

## Instructions

Perform a focused security audit of the diff above. Check specifically for:

1. **Injection risks** — SQL injection, command injection, template injection, or any place where user-controlled data flows into an interpreter without sanitization.
2. **Hardcoded secrets** — API keys, passwords, tokens, or credentials embedded in source code.
3. **Unsafe deserialization** — parsing untrusted data with formats that allow arbitrary object construction (e.g., `pickle`, `eval`, `unserialize`).
4. **Path traversal** — file path construction from user input without canonicalization or boundary checks.
5. **Improper authentication / authorization** — missing auth guards, broken access control, or privilege escalation paths.

## Rules

- Only flag genuine security concerns. Do not report theoretical or extremely unlikely issues.
- If the diff is clean and introduces no security problems, end your response with EXACTLY this on the last line:
  `FLOGVIT-CODER:AUDIT:APPROVED: <one sentence confirming no issues found>`
- If you find a security issue that must be fixed before merging, end your response with EXACTLY this on the last line:
  `FLOGVIT-CODER:AUDIT:SECURITY-ISSUE: <one sentence describing the issue>`
```

- [ ] **Step 2: Create src/commands/audit-pr.ts**

```typescript
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getPR,
  getPRDiff,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { Logger } from "../lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function auditPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose = false
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? "~";
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "audit-pr", verbose });

  const pr = await getPR(prNumber, cwd);
  const diff = await getPRDiff(prNumber, cwd);
  const repoContext = await gatherRepoContext(cwd);

  await addPRLabel(prNumber, LABELS.inProgress, cwd);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("audit-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    pr_diff: diff,
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "audit-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for PR #${prNumber} security audit`);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `audit-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);
  await removePRLabel(prNumber, LABELS.inProgress, cwd);
  await removePRLabel(prNumber, LABELS.needsAudit, cwd);

  const lines = result.output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("FLOGVIT-CODER:AUDIT:APPROVED:")) {
      const reason = line.replace("FLOGVIT-CODER:AUDIT:APPROVED:", "").trim();
      await addPRLabel(prNumber, LABELS.approved, cwd);
      logger.summary(`PR #${prNumber}: audit approved — ${reason}`);
      return { success: true };
    }
    if (line.startsWith("FLOGVIT-CODER:AUDIT:SECURITY-ISSUE:")) {
      const description = line.replace("FLOGVIT-CODER:AUDIT:SECURITY-ISSUE:", "").trim();
      await addPRLabel(prNumber, LABELS.securityIssue, cwd);
      await commentOnPR(
        prNumber,
        formatIssueComment("security audit: issue found", description),
        cwd
      );
      logger.summary(`PR #${prNumber}: security issue — ${description}`);
      return { success: false };
    }
  }

  // Couldn't parse a verdict — treat as inconclusive, restore label
  logger.summary(`PR #${prNumber}: audit produced no clear verdict`);
  await addPRLabel(prNumber, LABELS.needsAudit, cwd);
  return { success: false };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-coder audit-pr <pr-number>");
    process.exit(1);
  }
  const verbose = args.includes("--verbose") || args.includes("-v");
  await auditPR(prNumber, config, cwd, verbose);
}
```

- [ ] **Step 3: Register audit-pr in src/cli.ts**

Add to the `COMMANDS` map:

```typescript
  "audit-pr": () => import("./commands/audit-pr"),
```

Also add to the help text in `main()`:

```
  audit-pr <#>        Security audit of a PR → advance to approved
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 5: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/audit-pr.ts src/commands/audit-pr.md src/cli.ts && git commit -m "feat: implement audit-pr command"
```

---

## Task 8: merge command

**Files:**
- Create: `src/commands/merge.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Create src/commands/merge.ts**

```typescript
import { $ } from "bun";
import type { Config } from "../lib/config";
import { listPRsWithLabel, mergePullRequest, LABELS } from "../lib/github";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prs = await listPRsWithLabel(LABELS.approved, cwd);

  if (prs.length === 0) {
    console.log("No approved PRs to merge.");
    return;
  }

  const repoSlug = await getRepoSlug(cwd);

  for (const pr of prs) {
    console.log(`Merging PR #${pr.number}: ${pr.title}`);
    const prUrl = `https://github.com/${repoSlug}/pull/${pr.number}`;
    await mergePullRequest(prUrl, cwd);
    console.log(`Merged PR #${pr.number}`);
  }

  await $`git pull`.cwd(cwd);
  console.log("Pulled main. Done.");
}

async function getRepoSlug(cwd: string): Promise<string> {
  const result = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(cwd).text();
  return result.trim();
}
```

- [ ] **Step 2: Register merge in src/cli.ts**

Add to the `COMMANDS` map:

```typescript
  merge: () => import("./commands/merge"),
```

Also add to the help text in `main()`:

```
  merge               Merge all approved PRs
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 4: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/merge.ts src/cli.ts && git commit -m "feat: implement merge command"
```

---

## Task 9: watch rewrite (cron mode)

**Files:**
- Modify: `src/commands/watch.ts`

- [ ] **Step 1: Rewrite src/commands/watch.ts**

Replace the entire file contents with:

```typescript
import { resolve, basename } from "path";
import type { Config } from "../lib/config";
import { listIssuesWithLabel, listPRsWithLabel, getIssue, removeLabel, LABELS } from "../lib/github";
import { loadState } from "../lib/state";
import { fixIssue } from "./fix-issue";
import { verifyPR } from "./verify";
import { reviewPR } from "./review-pr";
import { auditPR } from "./audit-pr";
import { run as mergeRun } from "./merge";
import { PIPELINE_STAGES, STAGE_LABELS } from "../lib/pipeline";

export { findAnsweredIssues } from "./watch-helpers";

async function watchCron(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? "~";
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  // 1. Check for new autofix issues
  const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
  const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
  const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

  for (const issue of autofixIssues) {
    if (inProgressNums.has(issue.number)) continue;
    const existingState = await loadState(stateDir, repoName, issue.number);
    if (existingState) continue;
    console.log(`Found new autofix issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }

  // 2. Check for answered waiting issues
  const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
  for (const waitingIssue of waitingIssues) {
    const fullIssue = await getIssue(waitingIssue.number, cwd);
    const comments = fullIssue.comments;
    if (comments.length === 0) continue;
    const lastComment = comments[comments.length - 1];
    if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
      console.log(`Issue #${waitingIssue.number} has been answered, resuming...`);
      await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
      await fixIssue(waitingIssue.number, config, cwd);
    }
  }

  // 3. Dispatch pipeline stages
  for (const stage of PIPELINE_STAGES) {
    const label = STAGE_LABELS[stage];
    const prs = await listPRsWithLabel(label, cwd);

    for (const pr of prs) {
      // Skip if already in-progress
      if (pr.labels.includes(LABELS.inProgress)) continue;

      console.log(`Dispatching ${stage} for PR #${pr.number}: ${pr.title}`);

      switch (stage) {
        case "verify":
          await verifyPR(pr.number, config, cwd);
          break;
        case "review":
          await reviewPR(pr.number, config, cwd);
          break;
        case "audit":
          await auditPR(pr.number, config, cwd);
          break;
        case "merge":
          await mergeRun([], config, cwd);
          break;
      }
    }
  }
}

async function watchLive(config: Config, cwd: string): Promise<void> {
  // Implemented in Task 10
  console.log("--live mode not yet implemented. Run without --live for cron mode.");
  await watchCron(config, cwd);
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const live = args.includes("--live");
  const reposFlag = args.find((a) => a.startsWith("--repos"));
  const reposValue = reposFlag ? args[args.indexOf(reposFlag) + 1] : undefined;

  if (reposValue) {
    const repos = reposValue.split(",").map((r) => r.trim());
    for (const repo of repos) {
      const resolvedPath = resolve(repo);
      console.log(`Checking ${resolvedPath}...`);
      if (live) {
        await watchLive(config, resolvedPath);
      } else {
        await watchCron(config, resolvedPath);
      }
    }
  } else {
    if (live) {
      await watchLive(config, cwd);
    } else {
      await watchCron(config, cwd);
    }
  }
}
```

Note: The `findAnsweredIssues` helper that was previously defined inline in watch.ts needs to be moved to a small helper file `src/commands/watch-helpers.ts` so it can be re-exported cleanly. Create that file:

```typescript
// src/commands/watch-helpers.ts
export function findAnsweredIssues(
  issues: { number: number; comments: { author: string; body: string; createdAt: string }[] }[],
  botIdentifier: string
): number[] {
  const answered: number[] = [];
  for (const issue of issues) {
    if (issue.comments.length === 0) continue;
    const lastComment = issue.comments[issue.comments.length - 1];
    if (lastComment.author !== botIdentifier) {
      answered.push(issue.number);
    }
  }
  return answered;
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 3: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/watch.ts src/commands/watch-helpers.ts && git commit -m "feat: rewrite watch cron mode with full pipeline dispatch"
```

---

## Task 10: watch --live mode

**Files:**
- Modify: `src/commands/watch.ts`

- [ ] **Step 1: Replace the watchLive stub in watch.ts with the full implementation**

Replace the `watchLive` function body (the stub from Task 9) with:

```typescript
interface ActiveJob {
  label: string;
  startedAt: number;
  stage: string;
}

const activeJobs = new Map<string, ActiveJob>();
const recentLogs: string[] = [];
const MAX_LOGS = 8;

function log(jobName: string, msg: string) {
  const time = new Date().toLocaleTimeString("no");
  recentLogs.push(`  ${time}  ${jobName.padEnd(16)}  ${msg}`);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

function renderUI(repoName: string, queue: { stage: string; prTitle: string; prNumber: number }[]) {
  const now = Date.now();
  console.clear();
  console.log(
    `━━━ flogvit-coder · ${repoName} ${"━".repeat(Math.max(0, 50 - repoName.length))}  [${new Date().toLocaleTimeString("no")}]\n`
  );

  if (activeJobs.size > 0) {
    console.log("AKTIVE JOBBER");
    for (const [name, job] of activeJobs) {
      const elapsed = Math.floor((now - job.startedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      console.log(
        `  ● ${name.padEnd(18)} ${job.stage.padEnd(10)} ${String(m).padStart(1)}m${String(s).padStart(2, "0")}s   ${job.label}`
      );
    }
    console.log();
  }

  if (queue.length > 0) {
    console.log("KØ");
    for (const item of queue) {
      console.log(`  → ${item.stage.padEnd(14)} PR #${item.prNumber}   ${item.prTitle}`);
    }
    console.log();
  }

  if (recentLogs.length > 0) {
    console.log("SISTE LOGG");
    for (const entry of recentLogs) console.log(entry);
  }
}

async function watchLive(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? "~";
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  let queue: { stage: string; prTitle: string; prNumber: number }[] = [];
  let running = true;

  const cleanup = () => {
    running = false;
    console.clear();
    console.log("flogvit-coder: shutting down.");
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // Re-render UI every second
  const uiInterval = setInterval(() => {
    renderUI(repoName, queue);
  }, 1000);

  const poll = async () => {
    if (!running) return;

    try {
      // Collect new autofix issues
      const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
      const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
      const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

      for (const issue of autofixIssues) {
        if (inProgressNums.has(issue.number)) continue;
        const existingState = await loadState(stateDir, repoName, issue.number);
        if (existingState) continue;
        const jobName = `fix-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "fix" });
        log(jobName, `starting fix for issue #${issue.number}`);
        fixIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Collect waiting issues with answers
      const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
      for (const waitingIssue of waitingIssues) {
        const fullIssue = await getIssue(waitingIssue.number, cwd);
        const comments = fullIssue.comments;
        if (comments.length === 0) continue;
        const lastComment = comments[comments.length - 1];
        if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
          const jobName = `resume-${waitingIssue.number}`;
          if (activeJobs.has(jobName)) continue;
          activeJobs.set(jobName, { label: waitingIssue.title, startedAt: Date.now(), stage: "fix" });
          log(jobName, `resuming issue #${waitingIssue.number}`);
          (async () => {
            await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
            await fixIssue(waitingIssue.number, config, cwd);
          })().then(() => {
            activeJobs.delete(jobName);
            log(jobName, `done`);
          }).catch((err) => {
            activeJobs.delete(jobName);
            log(jobName, `error: ${String(err).slice(0, 60)}`);
          });
        }
      }

      // Collect pipeline stage work
      const nextQueue: typeof queue = [];
      for (const stage of PIPELINE_STAGES) {
        const label = STAGE_LABELS[stage];
        const prs = await listPRsWithLabel(label, cwd);
        for (const pr of prs) {
          if (pr.labels.includes(LABELS.inProgress)) continue;
          const jobName = `${stage}-${pr.number}`;
          if (activeJobs.has(jobName)) continue;
          nextQueue.push({ stage, prTitle: pr.title, prNumber: pr.number });

          activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage });
          log(jobName, `starting ${stage} for PR #${pr.number}`);

          let stagePromise: Promise<{ success: boolean }>;
          switch (stage) {
            case "verify":
              stagePromise = verifyPR(pr.number, config, cwd);
              break;
            case "review":
              stagePromise = reviewPR(pr.number, config, cwd);
              break;
            case "audit":
              stagePromise = auditPR(pr.number, config, cwd);
              break;
            case "merge":
              stagePromise = mergeRun([], config, cwd).then(() => ({ success: true }));
              break;
          }
          stagePromise.then(({ success }) => {
            activeJobs.delete(jobName);
            log(jobName, success ? `done` : `done (not advanced)`);
          }).catch((err) => {
            activeJobs.delete(jobName);
            log(jobName, `error: ${String(err).slice(0, 60)}`);
          });
        }
      }
      queue = nextQueue;
    } catch (err) {
      log("poll", `error: ${String(err).slice(0, 80)}`);
    }
  };

  // Poll immediately, then every 15 seconds
  await poll();
  const pollInterval = setInterval(poll, 15_000);

  // Keep alive until SIGINT
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        clearInterval(uiInterval);
        clearInterval(pollInterval);
        resolve();
      }
    }, 500);
  });
}
```

Make sure to add the `watchLive` function's state variables (`activeJobs`, `recentLogs`, `MAX_LOGS`, `log`, `renderUI`) at the module level above the function, not inside it, so the UI render interval can always access them.

- [ ] **Step 2: Run all tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test
```

- [ ] **Step 3: Manual smoke test of --live flag**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && timeout 5 bun run src/cli.ts watch --live 2>&1 || true
```

Verify the TUI renders without crashing, then exits cleanly after 5 seconds.

- [ ] **Step 4: Commit**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && git add src/commands/watch.ts && git commit -m "feat: add watch --live mode with terminal UI"
```
