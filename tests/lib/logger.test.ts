import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Logger } from "../../src/lib/logger";
import { mkdtemp, rm, readFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Logger", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "flogvit-pilot-log-"));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true });
  });

  test("writes detailed output to log file", async () => {
    const logger = new Logger({
      logDir,
      repoName: "test-repo",
      command: "fix-issue",
      verbose: false,
    });

    logger.detail("Full AI output here");
    await logger.flush();

    const files = await readdir(join(logDir, "test-repo"));
    expect(files.length).toBe(1);
    expect(files[0]).toContain("fix-issue");

    const content = await readFile(join(logDir, "test-repo", files[0]), "utf-8");
    expect(content).toContain("Full AI output here");
  });

  test("summary method collects summaries", () => {
    const logger = new Logger({
      logDir,
      repoName: "test-repo",
      command: "review",
      verbose: false,
    });

    logger.summary("Created issue #1");
    logger.summary("Created issue #2");

    expect(logger.getSummaries()).toEqual([
      "Created issue #1",
      "Created issue #2",
    ]);
  });
});
