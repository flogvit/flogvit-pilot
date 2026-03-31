import { describe, test, expect } from "bun:test";
import { parsePlanOutput, slugify, parseSubIssues } from "../../src/commands/plan-issue";

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

  test("removes leading dashes", () => {
    expect(slugify("--- hello world ---")).toBe("hello-world");
  });

  test("returns 'untitled' for all-special-char titles", () => {
    expect(slugify("!!!")).toBe("untitled");
  });
});

describe("parseSubIssues", () => {
  test("parses a valid sub-issues block", () => {
    const output = `FLOGVIT-CODER:PLAN:READY
FLOGVIT-CODER:ISSUES:BEGIN
[
  {"title": "Task 1", "body": "Do X", "labels": ["enhancement"], "dependsOn": []},
  {"title": "Task 2", "body": "Do Y", "labels": ["enhancement"], "dependsOn": [0]}
]
FLOGVIT-CODER:ISSUES:END`;
    const result = parseSubIssues(output);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].title).toBe("Task 1");
    expect(result![0].dependsOn).toEqual([]);
    expect(result![1].dependsOn).toEqual([0]);
  });

  test("returns null when no block present", () => {
    expect(parseSubIssues("FLOGVIT-CODER:PLAN:READY")).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    const output = `FLOGVIT-CODER:ISSUES:BEGIN
not json
FLOGVIT-CODER:ISSUES:END`;
    expect(parseSubIssues(output)).toBeNull();
  });

  test("defaults missing fields", () => {
    const output = `FLOGVIT-CODER:ISSUES:BEGIN
[{"title": "Minimal"}]
FLOGVIT-CODER:ISSUES:END`;
    const result = parseSubIssues(output);
    expect(result![0].body).toBe("");
    expect(result![0].labels).toEqual([]);
    expect(result![0].dependsOn).toEqual([]);
  });
});
