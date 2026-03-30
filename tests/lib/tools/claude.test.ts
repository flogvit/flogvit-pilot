import { describe, test, expect } from "bun:test";
import { ClaudeRunner } from "../../../src/lib/tools/claude";
import type { ToolRunnerOptions } from "../../../src/lib/tool-runner";

describe("ClaudeRunner", () => {
  test("has correct name", () => {
    const runner = new ClaudeRunner();
    expect(runner.name).toBe("claude");
  });

  test("buildArgs constructs correct CLI arguments", () => {
    const runner = new ClaudeRunner();
    const args = runner.buildArgs({
      prompt: "Fix the bug",
      cwd: "/tmp/repo",
      maxTurns: 30,
      allowedTools: ["Bash", "Read", "Edit"],
    });

    expect(args).toContain("-p");
    expect(args).toContain("Fix the bug");
    expect(args).toContain("--max-turns");
    expect(args).toContain(30);
    expect(args).toContain("--allowedTools");
    expect(args).toContain("Bash,Read,Edit");
  });

  test("buildArgs omits optional flags when not provided", () => {
    const runner = new ClaudeRunner();
    const args = runner.buildArgs({
      prompt: "Hello",
      cwd: "/tmp",
    });

    expect(args).toContain("-p");
    expect(args).toContain("Hello");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--allowedTools");
  });
});
