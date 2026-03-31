import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { saveState, loadState, clearState, type WorkState } from "../../src/lib/state";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "flogvit-pilot-state-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true });
  });

  test("save and load round-trips state", async () => {
    const state: WorkState = {
      issueNumber: 42,
      command: "fix-issue",
      branch: "flogvit-pilot/fix-42",
      agentSummary: "Started fixing the bug, need to know if null values are valid input",
      question: "Should this function handle null values?",
      issueData: {
        title: "Crash on null input",
        body: "The app crashes when...",
      },
      createdAt: "2026-03-30T12:00:00Z",
    };

    await saveState(stateDir, "my-repo", 42, state);
    const loaded = await loadState(stateDir, "my-repo", 42);

    expect(loaded).not.toBeNull();
    expect(loaded!.issueNumber).toBe(42);
    expect(loaded!.command).toBe("fix-issue");
    expect(loaded!.branch).toBe("flogvit-pilot/fix-42");
    expect(loaded!.agentSummary).toContain("Started fixing");
    expect(loaded!.question).toContain("null values");
  });

  test("returns null for non-existent state", async () => {
    const loaded = await loadState(stateDir, "my-repo", 999);
    expect(loaded).toBeNull();
  });

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

  test("clearState removes the state file", async () => {
    const state: WorkState = {
      issueNumber: 10,
      command: "fix-issue",
      branch: null,
      agentSummary: "test",
      question: null,
      issueData: { title: "test", body: "" },
      createdAt: "2026-03-30T12:00:00Z",
    };

    await saveState(stateDir, "repo", 10, state);
    await clearState(stateDir, "repo", 10);
    const loaded = await loadState(stateDir, "repo", 10);
    expect(loaded).toBeNull();
  });
});
