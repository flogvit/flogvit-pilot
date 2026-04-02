import { describe, test, expect } from "bun:test";
import { parseTriageOutput } from "../../src/commands/triage";

describe("parseTriageOutput", () => {
  test("detects AUTOFIX verdict", () => {
    const output = `The issue is well-defined and has enough context to proceed.
FLOGVIT-PILOT:TRIAGE:AUTOFIX`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("autofix");
  });

  test("detects NEEDS-SPLIT verdict", () => {
    const output = `This issue bundles multiple concerns and should be split.
FLOGVIT-PILOT:TRIAGE:NEEDS-SPLIT`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("needs-split");
  });

  test("maps legacy NEEDS-PLAN to needs-split", () => {
    const output = `This issue is vague and needs a plan before we can proceed.
FLOGVIT-PILOT:TRIAGE:NEEDS-PLAN`;
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("needs-split");
  });

  test("detects WAITING verdict with reason", () => {
    const output = `There are multiple valid approaches here.
FLOGVIT-PILOT:TRIAGE:WAITING: Need to know which database to target`;
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
    const output = "Analysis done\nFLOGVIT-PILOT:TRIAGE:AUTOFIX\n\n";
    const result = parseTriageOutput(output);
    expect(result.verdict).toBe("autofix");
  });
});
