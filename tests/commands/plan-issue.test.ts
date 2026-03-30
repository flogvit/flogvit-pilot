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
