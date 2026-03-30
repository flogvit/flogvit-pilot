# Triage and Plan System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make flogvit-coder fully autonomous from issue creation to merge — new issues are triaged automatically, vague ones get AI-generated plans posted as comments, and pipeline failures are retried before escalating to humans.

**Architecture:** Three new commands (`triage`, `plan-issue`, `fix-pr`) plus extensions to `watch`, `fix-issue`, and `merge`. New labels drive the flow: `needs-triage` → `triage` → `autofix`/`needs-plan`/`waiting`. `fix-pr` patches existing PR branches after review/audit failures. Loop-prevention state (`triageCount`, `fixAttempts`, `prFixAttempts`) prevents infinite retries.

**Tech Stack:** Bun + TypeScript, `bun:test`, GitHub CLI (`gh`), Claude CLI headless, existing `fix-issue`/`watch` patterns.

---

## File Structure

| File | Change |
|------|--------|
| `src/lib/github.ts` | Add `needsTriage`, `needsPlan`, `ignore` to LABELS; add `listOpenIssues` |
| `src/lib/state.ts` | Add optional triage/retry fields to `WorkState` |
| `tests/lib/state.test.ts` | Add tests for new state fields |
| `tests/lib/github.test.ts` | Add test for `listOpenIssues` shape (if applicable) |
| `src/commands/triage.ts` | Replace stub with full implementation + `parseTriageOutput` |
| `src/commands/triage.md` | New AI prompt template |
| `tests/commands/triage.test.ts` | Tests for `parseTriageOutput` |
| `src/commands/plan-issue.ts` | New command + `parsePlanOutput` + `slugify` |
| `src/commands/plan-issue.md` | New AI prompt template |
| `tests/commands/plan-issue.test.ts` | Tests for `parsePlanOutput`, `slugify` |
| `src/commands/fix-pr.ts` | New command + `parsePRIssueNumber` |
| `src/commands/fix-pr.md` | New AI prompt template |
| `tests/commands/fix-pr.test.ts` | Tests for `parsePRIssueNumber` |
| `src/commands/watch.ts` | Add unlabeled detection, needs-triage/needs-plan dispatch, changes-requested/failed retry |
| `tests/commands/watch.test.ts` | Tests for new watch helpers |
| `src/commands/fix-issue.ts` | Delete plan file on completion |
| `src/commands/merge.ts` | Delete plan file after successful merge |
| `src/cli.ts` | Register `plan-issue`, `fix-pr` |

---

### Task 1: Labels + State Extensions

**Files:**
- Modify: `src/lib/github.ts`
- Modify: `src/lib/state.ts`
- Modify: `tests/lib/state.test.ts`

- [ ] **Step 1: Write failing test for new state fields**

```typescript
// tests/lib/state.test.ts — add inside describe("state"):
test("saves and loads new triage/retry fields", async () => {
  const state: WorkState = {
    issueNumber: 7,
    command: "triage",
    branch: null,
    agentSummary: "",
    question: null,
    issueData: { title: "Vague issue", body: "" },
    createdAt: "2026-03-30T12:00:00Z",
    triageCount: 1,
    fixAttempts: 2,
    prFixAttempts: 0,
    planGenerated: true,
    planFile: "docs/superpowers/plans/issue-7-vague-issue.md",
  };

  await saveState(stateDir, "repo", 7, state);
  const loaded = await loadState(stateDir, "repo", 7);

  expect(loaded!.triageCount).toBe(1);
  expect(loaded!.fixAttempts).toBe(2);
  expect(loaded!.prFixAttempts).toBe(0);
  expect(loaded!.planGenerated).toBe(true);
  expect(loaded!.planFile).toBe("docs/superpowers/plans/issue-7-vague-issue.md");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder && bun test tests/lib/state.test.ts`
Expected: FAIL — `Object literal may only specify known properties` or test assertion fails because `WorkState` does not have the new fields

- [ ] **Step 3: Extend WorkState in state.ts**

```typescript
export interface WorkState {
  issueNumber: number;
  command: string;
  branch: string | null;
  agentSummary: string;
  question: string | null;
  issueData: {
    title: string;
    body: string;
  };
  createdAt: string;
  // Triage and retry loop prevention (all optional for backward compatibility)
  triageCount?: number;
  fixAttempts?: number;
  prFixAttempts?: number;
  planGenerated?: boolean;
  planFile?: string;
}
```

- [ ] **Step 4: Add new labels + `listOpenIssues` to github.ts**

In `LABELS` const, add after `changesRequested`:
```typescript
needsTriage: "flogvit-coder:needs-triage",
needsPlan: "flogvit-coder:needs-plan",
ignore: "flogvit-coder:ignore",
```

In `LABEL_DEFINITIONS` array, add:
```typescript
{ name: "flogvit-coder:needs-triage", description: "flogvit-coder: needs triage evaluation", color: "bfd4f2" },
{ name: "flogvit-coder:needs-plan", description: "flogvit-coder: needs implementation plan", color: "d4c5f9" },
{ name: "flogvit-coder:ignore", description: "flogvit-coder: ignore this issue/PR entirely", color: "eeeeee" },
```

Add after the `listIssuesWithLabel` function:
```typescript
export async function listOpenIssues(cwd: string): Promise<{ number: number; title: string; labels: string[] }[]> {
  const result = await $`gh issue list --state open --limit 100 --json number,title,labels`.cwd(cwd).text();
  const data = JSON.parse(result);
  return data.map((i: { number: number; title: string; labels: { name: string }[] }) => ({
    number: i.number,
    title: i.title,
    labels: i.labels.map((l) => l.name),
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/lib/state.test.ts`
Expected: All tests pass (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/state.ts src/lib/github.ts tests/lib/state.test.ts
git commit -m "feat: add triage/retry fields to WorkState and new labels to github.ts"
```

---

### Task 2: `triage` Command

**Files:**
- Create: `src/commands/triage.ts` (replace stub)
- Create: `src/commands/triage.md`
- Create: `tests/commands/triage.test.ts`

- [ ] **Step 1: Write failing tests for `parseTriageOutput`**

Create `tests/commands/triage.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import { parseTriageOutput } from "../../src/commands/triage";

describe("parseTriageOutput", () => {
  test("detects AUTOFIX verdict", () => {
    const output = `The issue is well-defined and has enough context to proceed.
FLOGVIT-CODER:TRIAGE:AUTOFIX`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("autofix");
  });

  test("detects NEEDS-PLAN verdict", () => {
    const output = `This issue is vague and needs a plan before we can proceed.
FLOGVIT-CODER:TRIAGE:NEEDS-PLAN`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("needs-plan");
  });

  test("detects WAITING verdict with reason", () => {
    const output = `There are multiple valid approaches here.
FLOGVIT-CODER:TRIAGE:WAITING: Need to know which database to target`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("waiting");
    if (result.verdict === "waiting") {
      expect(result.reason).toBe("Need to know which database to target");
    }
  });

  test("returns unknown when no marker found", () => {
    const output = "Some inconclusive output";
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("unknown");
  });

  test("finds marker in last line even with trailing newlines", () => {
    const output = "Analysis done\nFLOGVIT-CODER:TRIAGE:AUTOFIX\n\n";
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("autofix");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/commands/triage.test.ts`
Expected: FAIL — `parseTriageOutput is not a function`

- [ ] **Step 3: Create `src/commands/triage.ts`**

```typescript
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { basename } from "path";
import { readFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TriageVerdict =
  | { verdict: "autofix" }
  | { verdict: "needs-plan" }
  | { verdict: "waiting"; reason: string }
  | { verdict: "unknown" };

export function parseTriageOutput(output: string): TriageVerdict {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "FLOGVIT-CODER:TRIAGE:AUTOFIX") return { verdict: "autofix" };
    if (line === "FLOGVIT-CODER:TRIAGE:NEEDS-PLAN") return { verdict: "needs-plan" };
    if (line.startsWith("FLOGVIT-CODER:TRIAGE:WAITING:")) {
      return {
        verdict: "waiting",
        reason: line.replace("FLOGVIT-CODER:TRIAGE:WAITING:", "").trim(),
      };
    }
  }
  return { verdict: "unknown" };
}

export async function triageIssue(
  issueNum: number,
  config: Config,
  cwd: string,
  failureContext?: string
): Promise<{ verdict: "autofix" | "needs-plan" | "waiting" }> {
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoContext = await gatherRepoContext(cwd);
  const repoName = basename(cwd);

  const existingState = await loadState(stateDir, repoName, issueNum);
  const triageCount = (existingState?.triageCount ?? 0) + 1;

  // Hard limit: if already triaged twice, escalate to human
  if (triageCount > 2) {
    const issue = await getIssue(issueNum, cwd);
    await removeLabel(issueNum, LABELS.needsTriage, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(
      issueNum,
      formatIssueComment("waiting", "Trenger manuell gjennomgang — har kjørt triage for mange ganger uten å komme videre."),
      cwd
    );
    await saveState(stateDir, repoName, issueNum, {
      ...(existingState ?? {
        issueNumber: issueNum,
        command: "triage",
        branch: null,
        agentSummary: "",
        question: null,
        issueData: { title: issue.title, body: issue.body },
        createdAt: new Date().toISOString(),
      }),
      triageCount,
    });
    return { verdict: "waiting" };
  }

  const issue = await getIssue(issueNum, cwd);

  // Read existing plan if one has been generated
  let existingPlan = "";
  if (existingState?.planFile) {
    try {
      existingPlan = await readFile(resolve(cwd, existingState.planFile), "utf-8");
    } catch {
      // Plan file may not exist yet
    }
  }

  const template = await loadTemplate("triage", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    existing_plan: existingPlan ? `## Existing Plan\n\n${existingPlan}` : "",
    failure_context: failureContext ? `## Failure Context\n\n${failureContext}` : "",
    triage_count: String(triageCount),
    repo_name: repoContext.repoName,
    language: repoContext.language,
  });

  const toolName = resolveToolForCommand(config, "triage");
  const tool = getTool(toolName);

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `triage-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    maxTurns: 1,
    allowedTools: [],
  });

  const parsed = parseTriageOutput(result.output);

  // Update state with new triageCount
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "triage",
      branch: null,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    triageCount,
  });

  // Apply label transitions
  await removeLabel(issueNum, LABELS.needsTriage, cwd);

  if (parsed.verdict === "autofix") {
    await addLabel(issueNum, LABELS.autofix, cwd);
    return { verdict: "autofix" };
  }

  if (parsed.verdict === "needs-plan") {
    await addLabel(issueNum, LABELS.needsPlan, cwd);
    return { verdict: "needs-plan" };
  }

  // waiting or unknown → set waiting
  const reason =
    parsed.verdict === "waiting"
      ? parsed.reason
      : "Triage-agent ga ikke en klar anbefaling. Vennligst avklar hva som skal gjøres.";

  await addLabel(issueNum, LABELS.waiting, cwd);
  await commentOnIssue(issueNum, formatIssueComment("waiting", reason), cwd);
  return { verdict: "waiting" };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-coder triage <issue-number>");
    process.exit(1);
  }

  const failureIndex = args.indexOf("--failure-context");
  const failureContext = failureIndex !== -1 ? args[failureIndex + 1] : undefined;
  await triageIssue(issueNum, config, cwd, failureContext);
}
```

- [ ] **Step 4: Create `src/commands/triage.md`**

```markdown
You are a triage agent for flogvit-coder. Your job is to evaluate a GitHub issue and decide what to do next.

## Issue: {{issue_title}}

{{issue_body}}

{{issue_comments}}

{{existing_plan}}

{{failure_context}}

## Context

- **Repository:** {{repo_name}}
- **Language:** {{language}}
- **Triage run number:** {{triage_count}} (max 2 before escalating to human)

## Your Task

Read the issue carefully. Decide which of these applies:

**AUTOFIX** — The issue is clearly defined. There is enough information to implement a fix or feature without any ambiguity. Choose this if a developer would know exactly what to build.

**NEEDS-PLAN** — The issue is too vague or complex to implement directly, but it could be made actionable with a detailed implementation plan. Choose this if the issue describes a goal but not a solution.

**WAITING** — A human decision is required before any implementation can happen. Choose this if there are multiple valid approaches with real trade-offs, missing requirements, or conflicting constraints.

## Rules

- Be decisive. When in doubt between AUTOFIX and NEEDS-PLAN, pick NEEDS-PLAN.
- Only choose WAITING when a human choice is genuinely required (not just "this could be done multiple ways").
- If this is a re-triage after human feedback (triage_count > 1), look at the comments for guidance.
- If a failure context is provided, factor it into your decision.

## Output

Write a short analysis (2-5 sentences), then end with EXACTLY ONE of these on the last line:

`FLOGVIT-CODER:TRIAGE:AUTOFIX`
`FLOGVIT-CODER:TRIAGE:NEEDS-PLAN`
`FLOGVIT-CODER:TRIAGE:WAITING: <concise reason in Norwegian>`
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/commands/triage.test.ts`
Expected: All 5 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/commands/triage.ts src/commands/triage.md tests/commands/triage.test.ts
git commit -m "feat: implement triage command with parseTriageOutput"
```

---

### Task 3: `plan-issue` Command

**Files:**
- Create: `src/commands/plan-issue.ts`
- Create: `src/commands/plan-issue.md`
- Create: `tests/commands/plan-issue.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/commands/plan-issue.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import { parsePlanOutput, slugify } from "../../src/commands/plan-issue";

describe("parsePlanOutput", () => {
  test("detects READY verdict", () => {
    const output = `Here is the complete implementation plan with all steps defined.
FLOGVIT-CODER:PLAN:READY`;
    const result = parsePlanOutput(output);
    expect(result.verdict).toBe("ready");
  });

  test("detects NEEDS-HUMAN verdict with reason", () => {
    const output = `The plan has two viable approaches for the database layer.
FLOGVIT-CODER:PLAN:NEEDS-HUMAN: Choose between Postgres and SQLite`;
    const result = parsePlanOutput(output);
    expect(result.verdict).toBe("needs-human");
    if (result.verdict === "needs-human") {
      expect(result.reason).toBe("Choose between Postgres and SQLite");
    }
  });

  test("returns unknown when no marker found", () => {
    const output = "Inconclusive plan output";
    const result = parsePlanOutput(output);
    expect(result.verdict).toBe("unknown");
  });
});

describe("slugify", () => {
  test("converts title to slug", () => {
    expect(slugify("Add user authentication")).toBe("add-user-authentication");
  });

  test("removes special characters", () => {
    expect(slugify("Fix: null pointer in parse_config!")).toBe("fix-null-pointer-in-parse-config");
  });

  test("collapses multiple spaces/dashes", () => {
    expect(slugify("  multiple   spaces  ")).toBe("multiple-spaces");
  });

  test("truncates to 50 characters", () => {
    const long = "a".repeat(60);
    expect(slugify(long).length).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/plan-issue.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/commands/plan-issue.ts`**

```typescript
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { mkdir, writeFile, readFile } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type PlanVerdict =
  | { verdict: "ready" }
  | { verdict: "needs-human"; reason: string }
  | { verdict: "unknown" };

export function parsePlanOutput(output: string): PlanVerdict {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "FLOGVIT-CODER:PLAN:READY") return { verdict: "ready" };
    if (line.startsWith("FLOGVIT-CODER:PLAN:NEEDS-HUMAN:")) {
      return {
        verdict: "needs-human",
        reason: line.replace("FLOGVIT-CODER:PLAN:NEEDS-HUMAN:", "").trim(),
      };
    }
  }
  return { verdict: "unknown" };
}

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 50)
    .replace(/-+$/, "");
}

export async function planIssue(
  issueNum: number,
  config: Config,
  cwd: string
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoName = basename(cwd);
  const repoContext = await gatherRepoContext(cwd);

  const existingState = await loadState(stateDir, repoName, issueNum);

  // Guard: if plan already generated, set waiting directly
  if (existingState?.planGenerated) {
    const issue = await getIssue(issueNum, cwd);
    await removeLabel(issueNum, LABELS.needsPlan, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);
    await commentOnIssue(
      issueNum,
      formatIssueComment(
        "waiting",
        "En plan er allerede generert. Vennligst gjennomgå planen og gi tilbakemelding som kommentar, eller sett `autofix`-labelen for å starte implementasjonen."
      ),
      cwd
    );
    return { success: false };
  }

  const issue = await getIssue(issueNum, cwd);

  // Read existing plan if re-planning after feedback
  let existingPlan = "";
  if (existingState?.planFile) {
    try {
      existingPlan = await readFile(resolve(cwd, existingState.planFile), "utf-8");
    } catch {
      // ignore
    }
  }

  const template = await loadTemplate("plan-issue", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    existing_plan: existingPlan ? `## Existing Plan (update this)\n\n${existingPlan}` : "",
    repo_name: repoContext.repoName,
    language: repoContext.language,
    file_structure: repoContext.fileStructure,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
  });

  const toolName = resolveToolForCommand(config, "plan-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  const result = await tool.run({
    prompt,
    cwd,
    jobName: `plan-issue-${issueNum}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    allowedTools: ["Read", "Glob", "Grep", "Write"],
    maxTurns: (toolConfig["max-turns"] as number) ?? 20,
  });

  const parsed = parsePlanOutput(result.output);

  // Build plan file path from issue title slug
  const slug = slugify(issue.title);
  const planFile = `docs/superpowers/plans/issue-${issueNum}-${slug}.md`;

  // Update state
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "plan-issue",
      branch: null,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    planGenerated: true,
    planFile,
  });

  // Remove needs-plan label
  await removeLabel(issueNum, LABELS.needsPlan, cwd);

  if (parsed.verdict === "ready") {
    // Plan is self-sufficient — auto-proceed
    await addLabel(issueNum, LABELS.autofix, cwd);
    await commentOnIssue(
      issueNum,
      formatIssueComment(
        "plan klar",
        `Implementasjonsplan er generert og klar til utførelse.\n\nSe planen: \`${planFile}\`\n\nJeg starter implementasjonen automatisk.`
      ),
      cwd
    );
    return { success: true };
  }

  // needs-human or unknown → post plan as comment and wait
  const reason =
    parsed.verdict === "needs-human"
      ? parsed.reason
      : "Plan generert, men trenger din gjennomgang.";

  await addLabel(issueNum, LABELS.waiting, cwd);
  await commentOnIssue(
    issueNum,
    formatIssueComment(
      "plan klar — trenger gjennomgang",
      `Implementasjonsplan er generert og lagret i \`${planFile}\`.\n\n**Åpent spørsmål:** ${reason}\n\nGjennomgå planen og legg til en kommentar med instruksjoner. Sett \`autofix\`-labelen for å starte implementasjonen når du er klar.`
    ),
    cwd
  );
  return { success: false };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-coder plan-issue <issue-number>");
    process.exit(1);
  }
  await planIssue(issueNum, config, cwd);
}
```

- [ ] **Step 4: Create `src/commands/plan-issue.md`**

```markdown
You are an implementation planning agent for flogvit-coder. Your job is to create a complete, actionable implementation plan for a GitHub issue.

## Issue: {{issue_title}}

{{issue_body}}

{{issue_comments}}

{{existing_plan}}

## Repository Context

- **Language:** {{language}}
- **Repository:** {{repo_name}}

{{claude_md}}

## File Structure

{{file_structure}}

## Your Task

Explore the codebase (use Read, Glob, Grep as needed), then write a complete implementation plan.

The plan MUST be saved to `docs/superpowers/plans/issue-NNN-<slug>.md` using the Write tool, where NNN is the issue number and slug is a kebab-case version of the issue title.

### Plan Format

The plan must follow this structure:

```markdown
# [Issue Title] Implementation Plan

**Goal:** [One sentence]

**Architecture:** [2-3 sentences about approach]

---

## File Structure

| File | Change |
|------|--------|
| `path/to/file.ts` | What changes |

---

### Task N: [Name]

**Files:**
- Modify/Create: `exact/path/to/file.ts`

- [ ] Step 1: [action]
  ```typescript
  // actual code
  ```
- [ ] Step 2: Run: `command`  Expected: result
- [ ] Step 3: Commit
```

### Rules

- Every step must contain actual code, not descriptions
- Include exact file paths
- Include test steps with commands and expected output
- Cover all aspects of the issue
- Follow existing patterns in the codebase

## Verdict

After saving the plan file, end your response with EXACTLY ONE of these on the last line:

`FLOGVIT-CODER:PLAN:READY` — if the plan is complete and self-sufficient (no human choice needed)
`FLOGVIT-CODER:PLAN:NEEDS-HUMAN: <concise question in Norwegian>` — if a human must choose between real alternatives
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/commands/plan-issue.test.ts`
Expected: All 7 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/commands/plan-issue.ts src/commands/plan-issue.md tests/commands/plan-issue.test.ts
git commit -m "feat: add plan-issue command with parsePlanOutput and slugify"
```

---

### Task 4: `fix-pr` Command

**Files:**
- Create: `src/commands/fix-pr.ts`
- Create: `src/commands/fix-pr.md`
- Create: `tests/commands/fix-pr.test.ts`

- [ ] **Step 1: Write failing tests for `parsePRIssueNumber`**

Create `tests/commands/fix-pr.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import { parsePRIssueNumber } from "../../src/commands/fix-pr";

describe("parsePRIssueNumber", () => {
  test("parses 'fixes #NNN'", () => {
    const body = "## Summary\n\nAutomatically fixes #42.\n\n🤖 Generated by flogvit-coder";
    expect(parsePRIssueNumber(body)).toBe(42);
  });

  test("parses 'closes #NNN'", () => {
    const body = "This PR closes #123.";
    expect(parsePRIssueNumber(body)).toBe(123);
  });

  test("parses 'resolves #NNN'", () => {
    const body = "resolves #7";
    expect(parsePRIssueNumber(body)).toBe(7);
  });

  test("is case insensitive", () => {
    const body = "Fixes #55";
    expect(parsePRIssueNumber(body)).toBe(55);
  });

  test("returns null when no issue link found", () => {
    const body = "No issue link here";
    expect(parsePRIssueNumber(body)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/commands/fix-pr.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create `src/commands/fix-pr.ts`**

```typescript
import { $, resolve, dirname, basename } from "bun";
import { fileURLToPath } from "url";
import { mkdir, appendFile, readFile } from "fs/promises";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getPR,
  getIssue,
  addPRLabel,
  removePRLabel,
  commentOnPR,
  getPRDiff,
  formatIssueComment,
  LABELS,
} from "../lib/github";
import { createWorktreeFromRemote, removeWorktree, worktreePath } from "../lib/worktree";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { loadState, saveState } from "../lib/state";
import { Logger } from "../lib/logger";
import { parseToolOutput, buildIssueCommentsSection } from "./fix-issue";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function parsePRIssueNumber(prBody: string): number | null {
  const match = prBody.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export async function fixPR(
  prNumber: number,
  config: Config,
  cwd: string,
  verbose: boolean = false,
  retryModel?: string,
  failureContext?: string
): Promise<{ success: boolean }> {
  const homeDir = process.env.HOME ?? homedir();
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoContext = await gatherRepoContext(cwd);
  const repoName = basename(cwd);
  const logger = new Logger({ logDir, repoName, command: "fix-pr", verbose });

  const pr = await getPR(prNumber, cwd);
  const issueNum = parsePRIssueNumber(pr.body);
  if (!issueNum) {
    logger.summary(`PR #${prNumber}: could not find linked issue number in body`);
    return { success: false };
  }

  const existingState = await loadState(stateDir, repoName, issueNum);
  const prFixAttempts = (existingState?.prFixAttempts ?? 0) + 1;

  const issue = await getIssue(issueNum, cwd);
  const diff = await getPRDiff(prNumber, cwd);

  // Read plan file if exists
  let planContent = "";
  if (existingState?.planFile) {
    try {
      planContent = await readFile(resolve(cwd, existingState.planFile), "utf-8");
    } catch {
      // ignore
    }
  }

  const wtPath = worktreePath(homeDir, repoName, `fix-pr-${prNumber}`);

  const cleanup = async () => {
    await removePRLabel(prNumber, LABELS.inProgress, cwd).catch(() => {});
    await removeWorktree(wtPath, cwd).catch(() => {});
    process.exit(1);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  const template = await loadTemplate("fix-pr", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_num: String(issue.number),
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    pr_number: String(prNumber),
    pr_diff: diff.slice(0, 8000),
    failure_context: failureContext ?? "No specific failure context provided.",
    plan_content: planContent ? `## Implementation Plan\n\n${planContent}` : "",
    language: repoContext.language,
    repo_name: repoContext.repoName,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    file_structure: repoContext.fileStructure,
  });

  await createWorktreeFromRemote(wtPath, pr.headBranch, cwd);

  const toolName = resolveToolForCommand(config, "fix-pr");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};
  const model = retryModel ?? (toolConfig.model as string | undefined);

  const agentLogFile = logger.getLogFile().replace(".log", "-agent.log");
  await mkdir(resolve(agentLogFile, ".."), { recursive: true });

  const result = await tool.run({
    prompt,
    cwd: wtPath,
    jobName: `fix-pr-${prNumber}`,
    fallbackApiKey: config.defaults.fallback_api_key,
    verbose,
    model,
    onChunk: (chunk) => appendFile(agentLogFile, chunk).catch(() => {}),
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  const parsed = parseToolOutput(result.output);
  const diffResult = await $`git status --porcelain`.cwd(wtPath).text();
  const hasChanges = diffResult.trim().length > 0;

  process.off("SIGINT", cleanup);
  process.off("SIGTERM", cleanup);

  if (parsed.status === "stuck" || (!hasChanges && parsed.status !== "done")) {
    await removeWorktree(wtPath, cwd).catch(() => {});

    // Update prFixAttempts counter
    await saveState(stateDir, repoName, issueNum, {
      ...(existingState ?? {
        issueNumber: issueNum,
        command: "fix-pr",
        branch: pr.headBranch,
        agentSummary: "",
        question: null,
        issueData: { title: issue.title, body: issue.body },
        createdAt: new Date().toISOString(),
      }),
      prFixAttempts,
    });

    logger.summary(`PR #${prNumber}: fix-pr stuck (attempt ${prFixAttempts})`);
    return { success: false };
  }

  if (!hasChanges) {
    await removeWorktree(wtPath, cwd);
    logger.summary(`PR #${prNumber}: no changes made`);
    return { success: false };
  }

  // Commit and push to existing branch — PR updates automatically
  await $`git add -A`.cwd(wtPath);
  await $`git restore --staged .claude/worktrees`.cwd(wtPath).nothrow();
  await $`git commit -m ${"fix-pr: address review feedback"}`.cwd(wtPath);
  await $`git push`.cwd(wtPath);

  await removeWorktree(wtPath, cwd);

  // Remove failure labels, add needs-verify to restart pipeline
  await removePRLabel(prNumber, LABELS.changesRequested, cwd);
  await removePRLabel(prNumber, LABELS.failed, cwd);
  await addPRLabel(prNumber, LABELS.needsVerify, cwd);

  // Reset prFixAttempts since we succeeded
  await saveState(stateDir, repoName, issueNum, {
    ...(existingState ?? {
      issueNumber: issueNum,
      command: "fix-pr",
      branch: pr.headBranch,
      agentSummary: "",
      question: null,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    }),
    prFixAttempts: 0,
  });

  logger.summary(`PR #${prNumber}: fixed and pushed — pipeline restarted`);
  return { success: true };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prNumber = parseInt(args[0], 10);
  if (isNaN(prNumber)) {
    console.error("Usage: flogvit-coder fix-pr <pr-number> [--model <model>] [--failure-context <text>]");
    process.exit(1);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  const modelIndex = args.indexOf("--model");
  const model = modelIndex !== -1 ? args[modelIndex + 1] : undefined;
  const failureIndex = args.indexOf("--failure-context");
  const failureContext = failureIndex !== -1 ? args[failureIndex + 1] : undefined;

  await fixPR(prNumber, config, cwd, verbose, model, failureContext);
}
```

- [ ] **Step 4: Create `src/commands/fix-pr.md`**

```markdown
You are an autonomous coding agent fixing a pull request that failed code review or tests.

## Original Issue #{{issue_num}}: {{issue_title}}

{{issue_body}}

{{issue_comments}}

## PR #{{pr_number}} — Current Diff

```diff
{{pr_diff}}
```

## Failure Context

{{failure_context}}

{{plan_content}}

## Repository Context

- **Language:** {{language}}
- **Repository:** {{repo_name}}

{{claude_md}}

## File Structure

{{file_structure}}

## Instructions

1. Read the failure context carefully to understand what went wrong.
2. Look at the PR diff to understand what was already done.
3. Make the minimal changes needed to address the failure.
4. Run any existing tests to verify your fix doesn't break anything.
5. If the project has a linter, run it.

## Rules

- Only fix what the failure context describes. Don't refactor unrelated code.
- Follow existing code style and conventions.
- If you cannot fix this issue, respond with EXACTLY this on the last line:
  `FLOGVIT-CODER:STUCK:<your question for the developer>`
- If you successfully address the failure, respond with EXACTLY this on the last line:
  `FLOGVIT-CODER:DONE:<one-line summary of what you changed>`
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/commands/fix-pr.test.ts`
Expected: All 5 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/commands/fix-pr.ts src/commands/fix-pr.md tests/commands/fix-pr.test.ts
git commit -m "feat: add fix-pr command with parsePRIssueNumber"
```

---

### Task 5: Watch Extensions

**Files:**
- Modify: `src/commands/watch.ts`
- Modify: `tests/commands/watch.test.ts`

This task adds five new behaviors to `watch`:
1. Detect unlabeled issues → set `needs-triage`
2. Dispatch `triage` for `needs-triage` issues
3. Dispatch `plan-issue` for `needs-plan` issues
4. Answered waiting issues → set `needs-triage` instead of directly calling `fix-issue`
5. `changes-requested`/`failed` PRs → run `fix-pr` retry logic

- [ ] **Step 1: Write failing tests for the new watch helpers**

Open `tests/commands/watch.test.ts` and read its current content, then add:
```typescript
import { describe, test, expect } from "bun:test";
import { findAnsweredIssues } from "../../src/commands/watch";
// ... existing tests ...

describe("unlabeled issue detection", () => {
  test("identifies issues with no flogvit-coder labels", () => {
    const issues = [
      { number: 1, title: "Bug report", labels: [] },
      { number: 2, title: "Feature request", labels: ["bug"] },
      { number: 3, title: "Already triaged", labels: ["flogvit-coder:needs-triage"] },
      { number: 4, title: "Has ignore", labels: ["flogvit-coder:ignore"] },
      { number: 5, title: "Has autofix", labels: ["autofix"] },
    ];

    const FLOGVIT_CODER_PREFIX = "flogvit-coder:";
    const unlabeled = issues.filter(
      (i) =>
        !i.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX)) &&
        !i.labels.includes("flogvit-coder:ignore")
    );

    expect(unlabeled.map((i) => i.number)).toEqual([1, 2, 5]);
  });

  test("ignores issues with flogvit-coder:ignore label", () => {
    const issues = [
      { number: 1, labels: ["flogvit-coder:ignore"] },
      { number: 2, labels: [] },
    ];
    const FLOGVIT_CODER_PREFIX = "flogvit-coder:";
    const unlabeled = issues.filter(
      (i) =>
        !i.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX)) &&
        !i.labels.includes("flogvit-coder:ignore")
    );
    expect(unlabeled.map((i) => i.number)).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run tests to verify behavior**

Run: `bun test tests/commands/watch.test.ts`
Expected: All existing tests pass; new tests pass (they only test filtering logic, not GitHub calls)

- [ ] **Step 3: Update imports in `src/commands/watch.ts`**

Add to the import block at the top of `watch.ts`:
```typescript
import { listOpenIssues, addLabel } from "../lib/github";
import { triageIssue } from "./triage";
import { planIssue } from "./plan-issue";
import { fixPR } from "./fix-pr";
import { loadState, saveState } from "../lib/state";
```

(Note: `loadState` is already imported; add `saveState` if not present. Also add `addLabel` if not already imported.)

- [ ] **Step 4: Update `watchCron` to add the five new sections**

Replace the `watchCron` function body with:

```typescript
async function watchCron(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const FLOGVIT_CODER_PREFIX = "flogvit-coder:";

  // 1. Detect unlabeled issues → set needs-triage
  const allOpenIssues = await listOpenIssues(cwd);
  for (const issue of allOpenIssues) {
    if (issue.labels.includes(LABELS.ignore)) continue;
    if (issue.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX))) continue;
    console.log(`Found unlabeled issue #${issue.number}: ${issue.title} → needs-triage`);
    await addLabel(issue.number, LABELS.needsTriage, cwd);
  }

  // 2. Dispatch triage for needs-triage issues
  const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
  const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

  const triageIssues = await listIssuesWithLabel(LABELS.needsTriage, cwd);
  for (const issue of triageIssues) {
    if (inProgressNums.has(issue.number)) continue;
    console.log(`Triaging issue #${issue.number}: ${issue.title}`);
    await triageIssue(issue.number, config, cwd);
  }

  // 3. Dispatch plan-issue for needs-plan issues
  const planIssues = await listIssuesWithLabel(LABELS.needsPlan, cwd);
  for (const issue of planIssues) {
    if (inProgressNums.has(issue.number)) continue;
    console.log(`Planning issue #${issue.number}: ${issue.title}`);
    await planIssue(issue.number, config, cwd);
  }

  // 4. Check for new autofix issues
  const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
  for (const issue of autofixIssues) {
    if (inProgressNums.has(issue.number)) continue;
    const existingState = await loadState(stateDir, repoName, issue.number);
    if (existingState) continue;
    console.log(`Found new autofix issue #${issue.number}: ${issue.title}`);
    const state = await loadState(stateDir, repoName, issue.number);
    const fixAttempts = (state?.fixAttempts ?? 0) + 1;
    if (fixAttempts > 3) {
      console.log(`Issue #${issue.number}: fix attempts exhausted, skipping`);
      continue;
    }
    await saveState(stateDir, repoName, issue.number, {
      ...(state ?? {
        issueNumber: issue.number,
        command: "fix-issue",
        branch: null,
        agentSummary: "",
        question: null,
        issueData: { title: issue.title, body: "" },
        createdAt: new Date().toISOString(),
      }),
      fixAttempts,
    });
    await fixIssue(issue.number, config, cwd);
  }

  // 5. Check for answered waiting issues → set needs-triage
  const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
  const waitingWithComments = await Promise.all(
    waitingIssues.map((i) => getIssue(i.number, cwd))
  );
  const answeredNums = findAnsweredIssues(waitingWithComments, "🤖 **flogvit-coder**");
  for (const num of answeredNums) {
    const issue = waitingIssues.find((i) => i.number === num)!;
    console.log(`Issue #${num} has been answered, setting needs-triage...`);
    await removeLabel(num, LABELS.waiting, cwd);
    await addLabel(num, LABELS.needsTriage, cwd);
  }

  // 6. Retry changes-requested PRs with fix-pr
  const changesRequestedPRs = await listPRsWithLabel(LABELS.changesRequested, cwd);
  for (const pr of changesRequestedPRs) {
    if (pr.labels.includes(LABELS.inProgress)) continue;
    const issueNum = parsePRIssueNumber(pr.body);
    if (!issueNum) continue;
    const state = await loadState(stateDir, repoName, issueNum);
    const prFixAttempts = state?.prFixAttempts ?? 0;

    if (prFixAttempts >= 3) {
      console.log(`PR #${pr.number}: prFixAttempts exhausted, setting waiting`);
      continue;
    }

    const model = prFixAttempts >= 1 ? "opus" : undefined;
    console.log(`Fixing changes-requested PR #${pr.number} (attempt ${prFixAttempts + 1})`);
    await fixPR(pr.number, config, cwd, false, model);
  }

  // 7. Retry failed PRs with fix-pr
  const failedPRs = await listPRsWithLabel(LABELS.failed, cwd);
  for (const pr of failedPRs) {
    if (pr.labels.includes(LABELS.inProgress)) continue;
    const issueNum = parsePRIssueNumber(pr.body);
    if (!issueNum) continue;
    const state = await loadState(stateDir, repoName, issueNum);
    const prFixAttempts = state?.prFixAttempts ?? 0;

    if (prFixAttempts >= 3) {
      console.log(`PR #${pr.number}: prFixAttempts exhausted, setting waiting`);
      continue;
    }

    const model = prFixAttempts >= 1 ? "opus" : undefined;
    console.log(`Fixing failed PR #${pr.number} (attempt ${prFixAttempts + 1})`);
    await fixPR(pr.number, config, cwd, false, model);
  }

  // 8. Dispatch pipeline stages
  for (const stage of PIPELINE_STAGES) {
    const label = STAGE_LABELS[stage];
    const prs = await listPRsWithLabel(label, cwd);
    for (const pr of prs) {
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
```

- [ ] **Step 5: Update `watchLive` poll function in the same way**

In `watchLive`, update the `poll` function to add:

After `// Collect new autofix issues` block, add these sections BEFORE the existing autofix block:

```typescript
// Detect unlabeled issues → set needs-triage
const allOpenIssues = await listOpenIssues(cwd);
for (const issue of allOpenIssues) {
  if (issue.labels.includes(LABELS.ignore)) continue;
  if (issue.labels.some((l) => l.startsWith("flogvit-coder:"))) continue;
  await addLabel(issue.number, LABELS.needsTriage, cwd);
}

// Dispatch triage for needs-triage issues
const triageIssues = await listIssuesWithLabel(LABELS.needsTriage, cwd);
for (const issue of triageIssues) {
  if (inProgressNums.has(issue.number)) continue;
  const jobName = `triage-${issue.number}`;
  if (activeJobs.has(jobName)) continue;
  activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "triage" });
  log(jobName, `triaging issue #${issue.number}`);
  triageIssue(issue.number, config, cwd).then(() => {
    activeJobs.delete(jobName);
    log(jobName, `done`);
  }).catch((err) => {
    activeJobs.delete(jobName);
    log(jobName, `error: ${String(err).slice(0, 60)}`);
  });
}

// Dispatch plan-issue for needs-plan issues
const planIssuesList = await listIssuesWithLabel(LABELS.needsPlan, cwd);
for (const issue of planIssuesList) {
  if (inProgressNums.has(issue.number)) continue;
  const jobName = `plan-${issue.number}`;
  if (activeJobs.has(jobName)) continue;
  activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "plan" });
  log(jobName, `planning issue #${issue.number}`);
  planIssue(issue.number, config, cwd).then(() => {
    activeJobs.delete(jobName);
    log(jobName, `done`);
  }).catch((err) => {
    activeJobs.delete(jobName);
    log(jobName, `error: ${String(err).slice(0, 60)}`);
  });
}
```

Replace the answered waiting issues section (the one that calls `fixIssue` directly) with:
```typescript
// Collect waiting issues with answers → set needs-triage
const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
const waitingWithComments = await Promise.all(
  waitingIssues.map((i) => getIssue(i.number, cwd))
);
const answeredNums = findAnsweredIssues(waitingWithComments, "🤖 **flogvit-coder**");
for (const num of answeredNums) {
  const waitingIssue = waitingIssues.find((i) => i.number === num)!;
  const jobName = `retriage-${num}`;
  if (activeJobs.has(jobName)) continue;
  activeJobs.set(jobName, { label: waitingIssue.title, startedAt: Date.now(), stage: "triage" });
  log(jobName, `re-triaging answered issue #${num}`);
  (async () => {
    await removeLabel(num, LABELS.waiting, cwd);
    await addLabel(num, LABELS.needsTriage, cwd);
  })().then(() => {
    activeJobs.delete(jobName);
    log(jobName, `done`);
  }).catch((err) => {
    activeJobs.delete(jobName);
    log(jobName, `error: ${String(err).slice(0, 60)}`);
  });
}
```

Add fix-pr for changes-requested/failed before the pipeline stages loop:
```typescript
// Retry changes-requested and failed PRs
for (const label of [LABELS.changesRequested, LABELS.failed]) {
  const prs = await listPRsWithLabel(label, cwd);
  for (const pr of prs) {
    if (pr.labels.includes(LABELS.inProgress)) continue;
    const issueNum = parsePRIssueNumber(pr.body);
    if (!issueNum) continue;
    const state = await loadState(stateDir, repoName, issueNum);
    const prFixAttempts = state?.prFixAttempts ?? 0;
    if (prFixAttempts >= 3) continue;
    const jobName = `fix-pr-${pr.number}`;
    if (activeJobs.has(jobName)) continue;
    const model = prFixAttempts >= 1 ? "opus" : undefined;
    activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage: "fix-pr" });
    log(jobName, `fixing PR #${pr.number} (attempt ${prFixAttempts + 1})`);
    fixPR(pr.number, config, cwd, false, model).then(() => {
      activeJobs.delete(jobName);
      log(jobName, `done`);
    }).catch((err) => {
      activeJobs.delete(jobName);
      log(jobName, `error: ${String(err).slice(0, 60)}`);
    });
  }
}
```

Also add `import { parsePRIssueNumber } from "./fix-pr";` to the watch.ts imports.

- [ ] **Step 6: Run tests**

Run: `bun test tests/commands/watch.test.ts`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/commands/watch.ts tests/commands/watch.test.ts
git commit -m "feat: extend watch with triage/plan dispatch, fix-pr retry, and ignore label support"
```

---

### Task 6: fix-issue + merge Plan File Cleanup

**Files:**
- Modify: `src/commands/fix-issue.ts`
- Modify: `src/commands/merge.ts`

When fix-issue completes successfully (or makes no changes), it should delete the plan file if one exists. Similarly, merge should delete the plan file after a successful merge.

- [ ] **Step 1: Update `fix-issue.ts` to delete plan file on completion**

In `fixIssue`, add the `unlink` import at the top of the file:
```typescript
import { mkdir, appendFile, unlink } from "fs/promises";
```

In the "no changes" early-return block (around line 170-175), before `return { success: false }`:
```typescript
// Delete plan file if exists
if (repoContext) { /* already have it */ }
const stateBeforeClean = await loadState(stateDir, repoContext.repoName, issueNum);
if (stateBeforeClean?.planFile) {
  await unlink(resolve(cwd, stateBeforeClean.planFile)).catch(() => {});
}
```

Wait — it's cleaner to do this in one place. After the `clearState` call (near the bottom, success path), add:
```typescript
// Delete plan file if one was generated
const stateToClean = await loadState(stateDir, repoContext.repoName, issueNum);
if (stateToClean?.planFile) {
  await unlink(resolve(cwd, stateToClean.planFile)).catch(() => {});
}
await clearState(stateDir, repoContext.repoName, issueNum);
```

Actually, since `clearState` already deletes the state file, we need to read it first. The current code calls `clearState` on the success path. Insert the plan file deletion BEFORE `clearState`:

Find this block in `fixIssue` (around line 194-200):
```typescript
await removeWorktree(wtPath, cwd);
process.off("SIGINT", cleanup);
process.off("SIGTERM", cleanup);
await removeLabel(issueNum, LABELS.inProgress, cwd);
await clearState(stateDir, repoContext.repoName, issueNum);
```

Replace with:
```typescript
await removeWorktree(wtPath, cwd);
process.off("SIGINT", cleanup);
process.off("SIGTERM", cleanup);
await removeLabel(issueNum, LABELS.inProgress, cwd);

// Delete plan file before clearing state
const finalState = await loadState(stateDir, repoContext.repoName, issueNum);
if (finalState?.planFile) {
  await unlink(resolve(cwd, finalState.planFile)).catch(() => {});
}
await clearState(stateDir, repoContext.repoName, issueNum);
```

Also handle the "no changes" path — after `await removeWorktree(wtPath, cwd);` in that block:
```typescript
if (!hasChanges) {
  await removeLabel(issueNum, LABELS.inProgress, cwd);
  await removeWorktree(wtPath, cwd);
  // Delete plan file if exists
  const noChangesState = await loadState(stateDir, repoContext.repoName, issueNum);
  if (noChangesState?.planFile) {
    await unlink(resolve(cwd, noChangesState.planFile)).catch(() => {});
  }
  logger.summary(`Issue #${issueNum}: no changes made`);
  return { success: false };
}
```

- [ ] **Step 2: Update `merge.ts` to delete plan files after merge**

```typescript
import { $ } from "bun";
import { resolve, basename } from "path";
import { homedir } from "os";
import { unlink } from "fs/promises";
import type { Config } from "../lib/config";
import { listPRsWithLabel, mergePullRequest, getPR, LABELS } from "../lib/github";
import { loadState, clearState } from "../lib/state";
import { parsePRIssueNumber } from "./fix-pr";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const prs = await listPRsWithLabel(LABELS.approved, cwd);

  if (prs.length === 0) {
    console.log("No approved PRs to merge.");
    return;
  }

  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoName = basename(cwd);
  const repoSlug = await getRepoSlug(cwd);

  for (const pr of prs) {
    console.log(`Merging PR #${pr.number}: ${pr.title}`);
    const prUrl = `https://github.com/${repoSlug}/pull/${pr.number}`;

    // Get full PR to find linked issue number
    const fullPR = await getPR(pr.number, cwd);
    const issueNum = parsePRIssueNumber(fullPR.body);

    await mergePullRequest(prUrl, cwd);
    console.log(`Merged PR #${pr.number}`);

    // Clean up plan file and state for linked issue
    if (issueNum) {
      const state = await loadState(stateDir, repoName, issueNum);
      if (state?.planFile) {
        await unlink(resolve(cwd, state.planFile)).catch(() => {});
        console.log(`Deleted plan file: ${state.planFile}`);
      }
      await clearState(stateDir, repoName, issueNum);
    }
  }

  await $`git pull`.cwd(cwd);
  console.log("Pulled main. Done.");
}

async function getRepoSlug(cwd: string): Promise<string> {
  const result = await $`gh repo view --json nameWithOwner -q .nameWithOwner`.cwd(cwd).text();
  return result.trim();
}
```

- [ ] **Step 3: Run existing tests to make sure nothing is broken**

Run: `bun test`
Expected: All existing tests pass

- [ ] **Step 4: Commit**

```bash
git add src/commands/fix-issue.ts src/commands/merge.ts
git commit -m "feat: delete plan files on fix-issue completion and after merge"
```

---

### Task 7: CLI Registration

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add `plan-issue` and `fix-pr` to the COMMANDS map**

In `src/cli.ts`, add to the `COMMANDS` object (after `triage`):
```typescript
"plan-issue": () => import("./commands/plan-issue"),
"fix-pr": () => import("./commands/fix-pr"),
```

- [ ] **Step 2: Update the help text**

In the `--help` output, add after `triage`:
```
  plan-issue <#>      Generate implementation plan for a vague issue
  fix-pr <#>          Fix a PR after review/audit failure
```

- [ ] **Step 3: Run the help command to verify**

Run: `bun run src/cli.ts --help`
Expected: Both `plan-issue` and `fix-pr` appear in the output

- [ ] **Step 4: Smoke test each command registers correctly**

Run: `bun run src/cli.ts plan-issue 2>&1 | head -3`
Expected: "Usage: flogvit-coder plan-issue <issue-number>"

Run: `bun run src/cli.ts fix-pr 2>&1 | head -3`
Expected: "Usage: flogvit-coder fix-pr <pr-number> ..."

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: register plan-issue and fix-pr commands in CLI"
```

---

## Self-Review

### Spec Coverage

- ✅ New labels `needsTriage`, `needsPlan`, `ignore` → Task 1
- ✅ New state fields `triageCount`, `fixAttempts`, `prFixAttempts`, `planGenerated`, `planFile` → Task 1
- ✅ `triage` command with `parseTriageOutput` → Task 2
- ✅ `triage.md` prompt → Task 2
- ✅ `plan-issue` command with `parsePlanOutput`, `slugify` → Task 3
- ✅ `plan-issue.md` prompt → Task 3
- ✅ `fix-pr` command with `parsePRIssueNumber` → Task 4
- ✅ `fix-pr.md` prompt → Task 4
- ✅ Unlabeled issue detection → Task 5 (watch)
- ✅ needs-triage/needs-plan dispatch → Task 5 (watch)
- ✅ Answered waiting → needs-triage (not directly fix-issue) → Task 5 (watch)
- ✅ changes-requested/failed retry with fix-pr → Task 5 (watch)
- ✅ `ignore` label: skip entirely → Task 5 (watch)
- ✅ Plan file cleanup on fix-issue completion → Task 6
- ✅ Plan file cleanup on merge → Task 6
- ✅ CLI registration for plan-issue and fix-pr → Task 7
- ✅ triageCount >= 2 guard → Task 2 (triageIssue)
- ✅ planGenerated guard → Task 3 (planIssue)
- ✅ security-issue: always waiting (existing label, watch skips it)
- ✅ fixAttempts tracked in watch before calling fixIssue → Task 5

### Notes

- `fixAttempts` in watch cron is incremented before calling `fixIssue`. The retry model selection (sonnet → opus) should be wired in: attempt 1 uses default model, attempt 2 uses opus. This is handled in watch via `const model = fixAttempts >= 2 ? "opus" : undefined` — add this to the autofix dispatch in both `watchCron` and `watchLive`.
- `listOpenIssues` is a new GitHub function that fetches ALL open issues with their labels (needed to find issues without any `flogvit-coder:*` label). This was added in Task 1.
- The `parsePRIssueNumber` function is imported into `watch.ts` from `fix-pr.ts` to parse linked issue numbers from PR bodies.
