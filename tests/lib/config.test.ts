import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, mergeConfigs, type Config } from "../../src/lib/config";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("mergeConfigs", () => {
  test("returns defaults when no overrides", () => {
    const defaults: Config = {
      defaults: { tool: "claude" },
      tools: {},
      commands: {},
    };
    const result = mergeConfigs(defaults);
    expect(result.defaults.tool).toBe("claude");
  });

  test("repo config overrides global config", () => {
    const global: Config = {
      defaults: { tool: "claude" },
      tools: {},
      commands: {},
    };
    const repo: Config = {
      defaults: { tool: "aider" },
      tools: {},
      commands: {},
    };
    const result = mergeConfigs(global, repo);
    expect(result.defaults.tool).toBe("aider");
  });

  test("CLI flags override everything", () => {
    const global: Config = {
      defaults: { tool: "claude" },
      tools: {},
      commands: {},
    };
    const repo: Config = {
      defaults: { tool: "aider" },
      tools: {},
      commands: {},
    };
    const flags: Partial<Config> = {
      defaults: { tool: "claude" },
    };
    const result = mergeConfigs(global, repo, flags);
    expect(result.defaults.tool).toBe("claude");
  });

  test("deep merges tool configs", () => {
    const global: Config = {
      defaults: { tool: "claude" },
      tools: {
        claude: { "max-turns": 50 },
      },
      commands: {},
    };
    const repo: Config = {
      defaults: { tool: "claude" },
      tools: {
        claude: { "max-turns": 20 },
        aider: { model: "claude-sonnet-4-6" },
      },
      commands: {},
    };
    const result = mergeConfigs(global, repo);
    expect(result.tools.claude?.["max-turns"]).toBe(20);
    expect(result.tools.aider?.model).toBe("claude-sonnet-4-6");
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-pilot-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("loads TOML config from a directory", async () => {
    await writeFile(
      join(tempDir, "config.toml"),
      `[defaults]\ntool = "aider"\n`
    );
    const config = await loadConfig(tempDir);
    expect(config).not.toBeNull();
    expect(config!.defaults.tool).toBe("aider");
  });

  test("returns null when config file does not exist", async () => {
    const config = await loadConfig(tempDir);
    expect(config).toBeNull();
  });
});
