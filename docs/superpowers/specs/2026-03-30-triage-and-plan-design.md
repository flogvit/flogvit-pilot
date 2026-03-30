# Triage and Plan-Issue Design

**Date:** 2026-03-30
**Status:** Approved

## Goal

Make flogvit-coder fully autonomous from issue creation to merge. New issues are automatically evaluated: well-defined ones get `autofix` immediately; vague ones get a full implementation plan generated and posted as a comment, with human review only when a real choice is needed. Pipeline failures (verify, review, audit) are retried automatically before escalating to a human.

## Architecture

Three new commands — `triage`, `plan-issue`, `fix-pr` — plus extensions to `watch` and `state`. Triage is the central re-evaluator: it runs at the start of every issue's lifecycle and after every human response or pipeline failure (up to the loop-prevention limits).

```
New issue → watch sets needs-triage
needs-triage → triage → autofix | needs-plan | waiting
needs-plan   → plan-issue → autofix | waiting
waiting + human reply → needs-triage (counted)
autofix → fix-issue (sonnet) → fix-issue (opus) → triage → fix-issue → waiting
Pipeline failure → fix-pr (sonnet) → fix-pr (opus) → triage → fix-pr → waiting
Merge → delete plan file + state
```

## Labels

### New labels
| Label | Value | Meaning |
|-------|-------|---------|
| `needsTriage` | `flogvit-coder:needs-triage` | Needs triage evaluation |
| `needsPlan` | `flogvit-coder:needs-plan` | Triage says vague, plan-issue will run |
| `ignore` | `flogvit-coder:ignore` | flogvit-coder leaves this issue/PR completely alone |

### Existing labels (unchanged)
`autofix`, `flogvit-coder:waiting`, `flogvit-coder:in-progress`, `flogvit-coder:failed`, `flogvit-coder:changes-requested`, `flogvit-coder:security-issue`, all pipeline labels.

## State Extensions

The existing state file (`.flogvit-coder/state/<repo>/<issue>.json`) gains four new fields:

```typescript
interface IssueState {
  // existing fields...
  issueNumber: number;
  command: string;
  branch: string | null;
  agentSummary: string;
  question: string;
  issueData: { title: string; body: string };
  createdAt: string;

  // new fields
  triageCount: number;      // number of triage runs on this issue (max 2)
  fixAttempts: number;      // fix-issue attempts (new branch, max 3)
  prFixAttempts: number;    // fix-pr attempts per PR (resets when new PR is created, max 3)
  planGenerated: boolean;   // whether plan-issue has already run
  planFile?: string;        // repo-relative path to generated plan file
}
```

State is deleted on successful merge or explicit abandonment.

## Commands

### `triage <issue-number>`

A short, cheap AI run. No filesystem tools needed — just reads issue data and returns a verdict.

**Inputs to agent:**
- Issue title, body, all comments
- Existing plan (if `planFile` in state — read from disk)
- `triageCount` (so agent knows if this is a re-triage after human feedback)
- Failure context if triggered by pipeline failure (failure type + relevant output)

**Prompt output format (last line):**
- `FLOGVIT-CODER:TRIAGE:AUTOFIX` — issue is clear, agent can proceed
- `FLOGVIT-CODER:TRIAGE:NEEDS-PLAN` — issue is vague, needs a plan
- `FLOGVIT-CODER:TRIAGE:WAITING: <reason>` — needs human input, explain why

**Label transitions:**
- Remove `needs-triage`, add `autofix` / `needs-plan` / `waiting`
- If `triageCount >= 2`: always set `waiting` with "Trenger manuell gjennomgang" — never run agent

**Triggered by:** watch (new issues, human replies to waiting, post-pipeline-failure)

---

### `plan-issue <issue-number>`

A full AI planning run using the writing-plans prompt style. Generates a complete implementation plan with file structure, steps, code snippets, and test commands.

**Inputs to agent:**
- Issue title, body, comments
- Repo context (language, file structure, CLAUDE.md)
- Existing plan file content (if re-planning after human feedback)

**Output:**
- Plan file saved to `docs/superpowers/plans/issue-NNN-<slug>.md`
- Comment posted on issue containing the full plan + instructions:
  > "Plan generated. Review the steps above. If you want to proceed as-is, set the `autofix` label. If you want changes, reply with your instructions and I'll update the plan."

**Prompt output format (last line):**
- `FLOGVIT-CODER:PLAN:READY` — plan is self-sufficient, no human choice needed
- `FLOGVIT-CODER:PLAN:NEEDS-HUMAN` — plan has open questions or multiple valid approaches

**Label transitions:**
- Remove `needs-plan`
- `READY` → add `autofix`
- `NEEDS-HUMAN` → add `waiting`
- If `planGenerated = true` and `needs-plan` triggered again: skip agent, set `waiting` directly

**State updates:** `planGenerated = true`, `planFile = "docs/superpowers/plans/issue-NNN-slug.md"`

**Plan file cleanup:** Deleted by `fix-issue` on completion (success or no-changes) and by `merge` after a successful merge.

---

### `fix-pr <pr-number> [--model <model>]`

A variant of `fix-issue` that patches an existing PR branch rather than creating a new one.

**Differences from `fix-issue`:**
- Fetches the PR to get `headBranch`
- Uses `createWorktreeFromRemote(wtPath, headBranch, cwd)` instead of `createWorktree`
- Does not create a new PR — pushes to existing branch (PR auto-updates)
- Includes failure context in prompt: PR diff + failure reason (review comment / test output / audit finding)
- Does not remove `needs-verify` / `changes-requested` label before starting — only on success

**Inputs to agent:**
- Original issue (fetched via PR → linked issue number)
- PR diff (`getPRDiff`)
- Failure reason (review comment body, test output, or audit finding — passed as parameter)
- Plan file content (if exists)

**On success:** Remove `changes-requested` / `failed`, add `needs-verify` to restart pipeline.
**On no-changes / stuck:** Increment `prFixAttempts`, proceed to next retry tier. `prFixAttempts` resets to 0 when a new PR is created (i.e. a fix-issue success creates a fresh PR).

---

## Retry Logic

All retry state is tracked in the issue's state file.

### Initial fix (new issue → autofix)

```
attempt 1: fix-issue, model = sonnet
  success → PR + needs-verify pipeline
  fail    → attempt 2

attempt 2: fix-issue, model = opus
  success → PR + needs-verify pipeline
  fail    → triage (triageCount++)

triage resolves:
  AUTOFIX → attempt 3: fix-issue with plan context
    success → PR + needs-verify pipeline
    fail    → waiting "Alle forsøk oppbrukt"
  NEEDS-PLAN → plan-issue → waiting (human reviews updated plan)
  WAITING → waiting

fixAttempts >= 3 at any point → waiting, stop
```

### Pipeline failure (verify / review / audit)

```
verify failed or changes-requested:
  attempt 1: fix-pr, model = sonnet
  attempt 2: fix-pr, model = opus
  attempt 3: triage → fix-pr (once) or waiting
  attempt 4+: waiting

security-issue: always → waiting immediately (no auto-retry)
```

### Hard limits (loop prevention)

| Condition | Action |
|-----------|--------|
| `triageCount >= 2` | Set `waiting`, do not run triage agent |
| `fixAttempts >= 3` | Set `waiting`, do not retry fix-issue |
| `prFixAttempts >= 3` | Set `waiting`, do not retry fix-pr |
| `planGenerated = true` and `needs-plan` triggered again | Set `waiting` directly |
| `security-issue` label | Set `waiting`, never auto-retry |
| `waiting` → only cleared by human reply | Watch checks last comment is not from bot |
| `flogvit-coder:ignore` present | Skip entirely — no triage, no dispatch, no state |

---

## Watch Extensions

### New polling sections (in order):

1. **Unlabeled issues** — find open issues with no `flogvit-coder:*` labels → set `needs-triage`
   - Skip issues with `flogvit-coder:ignore`
2. **needs-triage** — dispatch `triage` (skip if `in-progress`)
3. **needs-plan** — dispatch `plan-issue` (skip if `in-progress`)
4. **waiting + human reply** — set `needs-triage` (existing logic, redirected from `fix-issue` to `triage`)
5. **changes-requested PRs** — dispatch `fix-pr` retry logic
6. **failed PRs** — dispatch `fix-pr` retry logic
7. *(existing)* needs-verify, needs-review, needs-audit, approved

### Determining the linked issue number from a PR

`fix-pr` and retry logic need to find the issue number linked to a PR. Strategy: parse the PR body for `fixes #NNN` / `closes #NNN` patterns (already present in PRs created by `fix-issue`).

---

## Triage Prompt (`src/commands/triage.md`)

Short prompt. No tools. Agent reads provided context and returns a single verdict line.

Template variables: `{{issue_title}}`, `{{issue_body}}`, `{{issue_comments}}`, `{{existing_plan}}`, `{{failure_context}}`, `{{triage_count}}`, `{{repo_name}}`, `{{language}}`

---

## Plan-Issue Prompt (`src/commands/plan-issue.md`)

Full writing-plans style prompt. Agent has read-only filesystem access (Glob, Grep, Read) to explore the codebase.

Template variables: `{{issue_title}}`, `{{issue_body}}`, `{{issue_comments}}`, `{{existing_plan}}`, `{{repo_name}}`, `{{language}}`, `{{file_structure}}`, `{{claude_md}}`

---

## Files Created or Modified

| File | Change |
|------|--------|
| `src/lib/github.ts` | Add `needsTriage`, `needsPlan` to LABELS |
| `src/lib/state.ts` | Add `triageCount`, `fixAttempts`, `prFixAttempts`, `planGenerated`, `planFile` to state type |
| `src/commands/triage.ts` | Replace stub with full implementation |
| `src/commands/triage.md` | New AI prompt template |
| `src/commands/plan-issue.ts` | New command |
| `src/commands/plan-issue.md` | New AI prompt template |
| `src/commands/fix-pr.ts` | New command (existing-branch variant of fix-issue) |
| `src/commands/fix-pr.md` | New AI prompt template (fix-issue.md + failure context) |
| `src/commands/watch.ts` | Add unlabeled-issue detection, needs-triage/needs-plan dispatch, retry logic |
| `src/commands/merge.ts` | Delete plan files after merge |
| `src/cli.ts` | Register triage, plan-issue, fix-pr |
