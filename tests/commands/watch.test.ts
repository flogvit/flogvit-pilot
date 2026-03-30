import { describe, test, expect } from "bun:test";
import { findAnsweredIssues } from "../../src/commands/watch";

describe("findAnsweredIssues", () => {
  test("identifies issues with new comments after bot question", () => {
    const botId = "🤖 **flogvit-coder**";
    const issues = [
      {
        number: 42,
        comments: [
          { author: "flogvit-coder-bot", body: `${botId} — waiting\n\nWhat encoding?`, createdAt: "2026-03-30T10:00:00Z" },
          { author: "vhanssen", body: "UTF-8 only", createdAt: "2026-03-30T11:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, botId);
    expect(result).toEqual([42]);
  });

  test("ignores issues where bot asked last", () => {
    const botId = "🤖 **flogvit-coder**";
    const issues = [
      {
        number: 10,
        comments: [
          { author: "flogvit-coder-bot", body: `${botId} — waiting\n\nQuestion`, createdAt: "2026-03-30T10:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, botId);
    expect(result).toEqual([]);
  });
});

describe("unlabeled issue detection", () => {
  test("identifies issues with no flogvit-coder labels", () => {
    const FLOGVIT_CODER_PREFIX = "flogvit-coder:";
    const ALL_KNOWN_LABELS = new Set(["autofix", "auto-implement", "auto-review", "flogvit-coder:waiting", "flogvit-coder:in-progress", "flogvit-coder:failed", "flogvit-coder:needs-verify", "flogvit-coder:needs-review", "flogvit-coder:needs-audit", "flogvit-coder:approved", "flogvit-coder:security-issue", "flogvit-coder:changes-requested", "flogvit-coder:needs-triage", "flogvit-coder:needs-plan", "flogvit-coder:ignore"]);
    const issues = [
      { number: 1, labels: [] },
      { number: 2, labels: ["bug"] },
      { number: 3, labels: ["flogvit-coder:needs-triage"] },
      { number: 4, labels: ["flogvit-coder:ignore"] },
      { number: 5, labels: ["autofix"] },
    ];

    const unlabeled = issues.filter(
      (i) =>
        !i.labels.includes("flogvit-coder:ignore") &&
        !i.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX) || ALL_KNOWN_LABELS.has(l))
    );

    expect(unlabeled.map((i) => i.number)).toEqual([1, 2]);
  });

  test("excludes issues with flogvit-coder:ignore label", () => {
    const FLOGVIT_CODER_PREFIX = "flogvit-coder:";
    const issues = [
      { number: 1, labels: ["flogvit-coder:ignore"] },
      { number: 2, labels: [] },
    ];
    const unlabeled = issues.filter(
      (i) =>
        !i.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX)) &&
        !i.labels.includes("flogvit-coder:ignore")
    );
    expect(unlabeled.map((i) => i.number)).toEqual([2]);
  });
});
