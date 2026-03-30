import { describe, test, expect } from "bun:test";
import { parseToolOutput, buildIssueCommentsSection } from "../../src/commands/fix-issue";

describe("parseToolOutput", () => {
  test("detects DONE status", () => {
    const output = `Some work output here
FLOGVIT-CODER:DONE:Fixed the null pointer in parse_config`;
    const result = parseToolOutput(output);
    expect(result.status).toBe("done");
    expect(result.message).toBe("Fixed the null pointer in parse_config");
  });

  test("detects STUCK status", () => {
    const output = `Tried to fix but unclear
FLOGVIT-CODER:STUCK:Should this handle both UTF-8 and UTF-16?`;
    const result = parseToolOutput(output);
    expect(result.status).toBe("stuck");
    expect(result.message).toBe("Should this handle both UTF-8 and UTF-16?");
  });

  test("defaults to unknown when no marker found", () => {
    const output = "Just some random output";
    const result = parseToolOutput(output);
    expect(result.status).toBe("unknown");
  });
});

describe("buildIssueCommentsSection", () => {
  test("formats comments as markdown", () => {
    const comments = [
      { body: "This also happens on Windows", author: "user1", createdAt: "2026-03-30T10:00:00Z" },
      { body: "I can reproduce it", author: "user2", createdAt: "2026-03-30T11:00:00Z" },
    ];
    const result = buildIssueCommentsSection(comments);
    expect(result).toContain("user1");
    expect(result).toContain("This also happens on Windows");
    expect(result).toContain("user2");
  });

  test("returns empty string for no comments", () => {
    const result = buildIssueCommentsSection([]);
    expect(result).toBe("");
  });
});
