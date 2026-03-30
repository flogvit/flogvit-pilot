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
