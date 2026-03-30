import { describe, test, expect } from "bun:test";
import { STAGE_LABELS, PIPELINE_STAGES, type PipelineJob } from "../../src/lib/pipeline";
import { LABELS } from "../../src/lib/github";

describe("STAGE_LABELS", () => {
  test("verify maps to needsVerify label", () => {
    expect(STAGE_LABELS.verify).toBe(LABELS.needsVerify);
  });
  test("review maps to needsReview label", () => {
    expect(STAGE_LABELS.review).toBe(LABELS.needsReview);
  });
  test("audit maps to needsAudit label", () => {
    expect(STAGE_LABELS.audit).toBe(LABELS.needsAudit);
  });
  test("merge maps to approved label", () => {
    expect(STAGE_LABELS.merge).toBe(LABELS.approved);
  });
});

describe("PIPELINE_STAGES", () => {
  test("contains all four stages in order", () => {
    expect(PIPELINE_STAGES).toEqual(["verify", "review", "audit", "merge"]);
  });
  test("has exactly four stages", () => {
    expect(PIPELINE_STAGES).toHaveLength(4);
  });
});

describe("PipelineJob type", () => {
  test("can construct a valid PipelineJob", () => {
    const job: PipelineJob = {
      prNumber: 42,
      prTitle: "Fix: update login flow",
      headBranch: "flogvit-coder/fix-42",
      stage: "verify",
    };
    expect(job.prNumber).toBe(42);
    expect(job.stage).toBe("verify");
  });
});
