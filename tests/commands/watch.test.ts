import { describe, test, expect } from "bun:test";
import { findAnsweredIssues } from "../../src/commands/watch";

describe("findAnsweredIssues", () => {
  test("identifies issues with new comments after bot question", () => {
    const botId = "🤖 **flogvit-pilot**";
    const issues = [
      {
        number: 42,
        comments: [
          { author: "flogvit-pilot-bot", body: `${botId} — waiting\n\nWhat encoding?`, createdAt: "2026-03-30T10:00:00Z" },
          { author: "vhanssen", body: "UTF-8 only", createdAt: "2026-03-30T11:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, botId);
    expect(result).toEqual([42]);
  });

  test("ignores issues where bot asked last", () => {
    const botId = "🤖 **flogvit-pilot**";
    const issues = [
      {
        number: 10,
        comments: [
          { author: "flogvit-pilot-bot", body: `${botId} — waiting\n\nQuestion`, createdAt: "2026-03-30T10:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, botId);
    expect(result).toEqual([]);
  });
});

describe("unlabeled issue detection", () => {
  test("identifies issues with no flogvit-pilot labels", () => {
    const FLOGVIT_LABEL_PREFIXES = ["flogvit-pilot:", "flogvit-coder:"];
    const hasOurPrefix = (l: string) => FLOGVIT_LABEL_PREFIXES.some((p) => l.startsWith(p));
    const ALL_KNOWN_LABELS = new Set(["autofix", "auto-implement", "auto-review", "flogvit-pilot:waiting", "flogvit-pilot:in-progress", "flogvit-pilot:failed", "flogvit-pilot:needs-verify", "flogvit-pilot:needs-review", "flogvit-pilot:needs-audit", "flogvit-pilot:approved", "flogvit-pilot:security-issue", "flogvit-pilot:changes-requested", "flogvit-pilot:needs-triage", "flogvit-pilot:needs-plan", "flogvit-pilot:ignore"]);
    const issues = [
      { number: 1, labels: [] },
      { number: 2, labels: ["bug"] },
      { number: 3, labels: ["flogvit-pilot:needs-triage"] },
      { number: 4, labels: ["flogvit-pilot:ignore"] },
      { number: 5, labels: ["autofix"] },
    ];

    const unlabeled = issues.filter(
      (i) =>
        !i.labels.includes("flogvit-pilot:ignore") &&
        !i.labels.some((l) => hasOurPrefix(l) || ALL_KNOWN_LABELS.has(l))
    );

    expect(unlabeled.map((i) => i.number)).toEqual([1, 2]);
  });

  test("excludes issues with flogvit-pilot:ignore label", () => {
    const FLOGVIT_LABEL_PREFIXES = ["flogvit-pilot:", "flogvit-coder:"];
    const hasOurPrefix = (l: string) => FLOGVIT_LABEL_PREFIXES.some((p) => l.startsWith(p));
    const issues = [
      { number: 1, labels: ["flogvit-pilot:ignore"] },
      { number: 2, labels: [] },
    ];
    const unlabeled = issues.filter(
      (i) =>
        !i.labels.some((l) => hasOurPrefix(l)) &&
        !i.labels.includes("flogvit-pilot:ignore")
    );
    expect(unlabeled.map((i) => i.number)).toEqual([2]);
  });
});
