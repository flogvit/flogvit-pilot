import { describe, test, expect } from "bun:test";
import {
  formatIssueComment,
  parseBranchName,
  LABELS,
} from "../../src/lib/github";

describe("formatIssueComment", () => {
  test("formats a status comment", () => {
    const comment = formatIssueComment("in-progress", "Working on fix");
    expect(comment).toContain("🤖 **flogvit-coder**");
    expect(comment).toContain("in-progress");
    expect(comment).toContain("Working on fix");
  });

  test("formats a waiting comment", () => {
    const comment = formatIssueComment(
      "waiting",
      "Need clarification: should this handle null values?"
    );
    expect(comment).toContain("waiting");
    expect(comment).toContain("Need clarification");
  });
});

describe("parseBranchName", () => {
  test("generates fix branch name", () => {
    expect(parseBranchName("fix", 42)).toBe("flogvit-coder/fix-42");
  });

  test("generates impl branch name", () => {
    expect(parseBranchName("impl", 17)).toBe("flogvit-coder/impl-17");
  });

  test("generates refactor branch name from description", () => {
    expect(parseBranchName("refactor", "extract config module")).toBe(
      "flogvit-coder/refactor-extract-config-module"
    );
  });

  test("sanitizes description for branch name", () => {
    expect(parseBranchName("refactor", "fix/weird chars!@#")).toBe(
      "flogvit-coder/refactor-fix-weird-chars"
    );
  });
});

describe("LABELS", () => {
  test("has all required labels defined", () => {
    expect(LABELS.autofix).toBe("autofix");
    expect(LABELS.autoImplement).toBe("auto-implement");
    expect(LABELS.autoReview).toBe("auto-review");
    expect(LABELS.waiting).toBe("flogvit-coder:waiting");
    expect(LABELS.inProgress).toBe("flogvit-coder:in-progress");
    expect(LABELS.failed).toBe("flogvit-coder:failed");
  });
});
