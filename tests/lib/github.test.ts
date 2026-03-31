import { describe, test, expect } from "bun:test";
import {
  formatIssueComment,
  parseBranchName,
  LABELS,
  extractPRNumber,
  parseDependsOn,
} from "../../src/lib/github";

describe("formatIssueComment", () => {
  test("formats a status comment", () => {
    const comment = formatIssueComment("in-progress", "Working on fix");
    expect(comment).toContain("🤖 **flogvit-pilot**");
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
    expect(parseBranchName("fix", 42)).toBe("flogvit-pilot/fix-42");
  });

  test("generates impl branch name", () => {
    expect(parseBranchName("impl", 17)).toBe("flogvit-pilot/impl-17");
  });

  test("generates refactor branch name from description", () => {
    expect(parseBranchName("refactor", "extract config module")).toBe(
      "flogvit-pilot/refactor-extract-config-module"
    );
  });

  test("sanitizes description for branch name", () => {
    expect(parseBranchName("refactor", "fix/weird chars!@#")).toBe(
      "flogvit-pilot/refactor-fix-weird-chars"
    );
  });
});

describe("LABELS", () => {
  test("has all required labels defined", () => {
    expect(LABELS.autofix).toBe("autofix");
    expect(LABELS.autoImplement).toBe("auto-implement");
    expect(LABELS.autoReview).toBe("auto-review");
    expect(LABELS.waiting).toBe("flogvit-pilot:waiting");
    expect(LABELS.inProgress).toBe("flogvit-pilot:in-progress");
    expect(LABELS.failed).toBe("flogvit-pilot:failed");
  });
});

describe("LABELS pipeline additions", () => {
  test("has needsVerify label", () => {
    expect(LABELS.needsVerify).toBe("flogvit-pilot:needs-verify");
  });
  test("has needsReview label", () => {
    expect(LABELS.needsReview).toBe("flogvit-pilot:needs-review");
  });
  test("has needsAudit label", () => {
    expect(LABELS.needsAudit).toBe("flogvit-pilot:needs-audit");
  });
  test("has approved label", () => {
    expect(LABELS.approved).toBe("flogvit-pilot:approved");
  });
  test("has securityIssue label", () => {
    expect(LABELS.securityIssue).toBe("flogvit-pilot:security-issue");
  });
  test("has changesRequested label", () => {
    expect(LABELS.changesRequested).toBe("flogvit-pilot:changes-requested");
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

describe("parseDependsOn", () => {
  test("parses single dependency", () => {
    expect(parseDependsOn("Depends-on: #5")).toEqual([5]);
  });

  test("parses multiple dependencies", () => {
    expect(parseDependsOn("Depends-on: #3, #7")).toEqual([3, 7]);
  });

  test("returns empty for no dependency line", () => {
    expect(parseDependsOn("Just a normal body")).toEqual([]);
  });

  test("is case-insensitive", () => {
    expect(parseDependsOn("DEPENDS-ON: #10")).toEqual([10]);
  });

  test("deduplicates", () => {
    expect(parseDependsOn("Depends-on: #5, #5")).toEqual([5]);
  });

  test("parses from multi-line body", () => {
    const body = "## Task\n\nDo something.\n\nDepends-on: #3, #4\n\nMore text";
    expect(parseDependsOn(body)).toEqual([3, 4]);
  });
});
