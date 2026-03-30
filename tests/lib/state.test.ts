import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { saveState, loadState, clearState, type WorkState } from "../../src/lib/state";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "flogvit-coder-state-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true });
  });

  test("save and load round-trips state", async () => {
    const state: WorkState = {
      issueNumber: 42,
      command: "fix-issue",
      branch: "flogvit-coder/fix-42",
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
    expect(loaded!.branch).toBe("flogvit-coder/fix-42");
    expect(loaded!.agentSummary).toContain("Started fixing");
    expect(loaded!.question).toContain("null values");
  });

  test("returns null for non-existent state", async () => {
    const loaded = await loadState(stateDir, "my-repo", 999);
    expect(loaded).toBeNull();
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
