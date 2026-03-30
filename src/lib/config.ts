import { parse as parseToml } from "@iarna/toml";
import { readFile } from "fs/promises";
import { join } from "path";

export interface ToolConfig {
  [key: string]: string | number | boolean | string[];
}

export interface CommandConfig {
  tool?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface Config {
  defaults: {
    tool: string;
  };
  tools: Record<string, ToolConfig>;
  commands: Record<string, CommandConfig>;
}

const BUILTIN_DEFAULTS: Config = {
  defaults: { tool: "claude" },
  tools: {
    claude: {
      "max-turns": 50,
      "allowed-tools": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    },
    aider: {
      model: "claude-sonnet-4-20250514",
    },
  },
  commands: {},
};

export function getBuiltinDefaults(): Config {
  return structuredClone(BUILTIN_DEFAULTS);
}

export async function loadConfig(dir: string): Promise<Config | null> {
  const configPath = join(dir, "config.toml");
  try {
    const content = await readFile(configPath, "utf-8");
    const parsed = parseToml(content) as unknown as Config;
    return parsed;
  } catch {
    return null;
  }
}

export function mergeConfigs(...configs: (Config | Partial<Config> | undefined | null)[]): Config {
  const result = getBuiltinDefaults();

  for (const config of configs) {
    if (!config) continue;

    if (config.defaults) {
      Object.assign(result.defaults, config.defaults);
    }

    if (config.tools) {
      for (const [name, toolConfig] of Object.entries(config.tools)) {
        result.tools[name] = { ...result.tools[name], ...toolConfig };
      }
    }

    if (config.commands) {
      for (const [name, cmdConfig] of Object.entries(config.commands)) {
        result.commands[name] = { ...result.commands[name], ...cmdConfig };
      }
    }
  }

  return result;
}

export function resolveToolForCommand(config: Config, command: string): string {
  return config.commands[command]?.tool ?? config.defaults.tool;
}

export async function resolveConfig(
  repoDir: string,
  cliFlags?: Partial<Config>
): Promise<Config> {
  const homeDir = process.env.HOME ?? "~";
  const globalConfig = await loadConfig(join(homeDir, ".flogvit-coder"));
  const repoConfig = await loadConfig(join(repoDir, ".flogvit-coder"));
  return mergeConfigs(globalConfig, repoConfig, cliFlags);
}
