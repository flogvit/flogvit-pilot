import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createLocalConfig } from "../../src/commands/init";

describe("init", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-pilot-init-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("creates .flogvit-pilot directory structure", async () => {
    await createLocalConfig(tempDir);

    const dirStat = await stat(join(tempDir, ".flogvit-pilot"));
    expect(dirStat.isDirectory()).toBe(true);

    const promptsStat = await stat(join(tempDir, ".flogvit-pilot", "prompts"));
    expect(promptsStat.isDirectory()).toBe(true);
  });

  test("creates default config.toml", async () => {
    await createLocalConfig(tempDir);

    const configStat = await stat(join(tempDir, ".flogvit-pilot", "config.toml"));
    expect(configStat.isFile()).toBe(true);
  });

  test("does not overwrite existing config", async () => {
    await createLocalConfig(tempDir);
    // Write custom content
    const configPath = join(tempDir, ".flogvit-pilot", "config.toml");
    await Bun.write(configPath, "# custom\n");

    // Run again
    await createLocalConfig(tempDir);

    const content = await Bun.file(configPath).text();
    expect(content).toBe("# custom\n");
  });
});
