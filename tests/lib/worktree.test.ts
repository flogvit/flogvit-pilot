import { describe, test, expect } from "bun:test";
import { worktreesBaseDir, worktreePath } from "../../src/lib/worktree";

describe("worktreesBaseDir", () => {
  test("builds base dir under ~/.flogvit-pilot/worktrees/repoName", () => {
    expect(worktreesBaseDir("/home/user", "my-repo")).toBe("/home/user/.flogvit-pilot/worktrees/my-repo");
  });
  test("handles different home directories", () => {
    expect(worktreesBaseDir("/Users/alice", "flogvit")).toBe("/Users/alice/.flogvit-pilot/worktrees/flogvit");
  });
});

describe("worktreePath", () => {
  test("builds worktree path for a job", () => {
    expect(worktreePath("/home/user", "my-repo", "fix-42")).toBe("/home/user/.flogvit-pilot/worktrees/my-repo/fix-42");
  });
  test("builds worktree path for verify job", () => {
    expect(worktreePath("/home/user", "my-repo", "verify-26")).toBe("/home/user/.flogvit-pilot/worktrees/my-repo/verify-26");
  });
  test("builds worktree path for review job", () => {
    expect(worktreePath("/Users/vhanssen", "flogvit-pilot", "review-pr-7")).toBe("/Users/vhanssen/.flogvit-pilot/worktrees/flogvit-pilot/review-pr-7");
  });
});
