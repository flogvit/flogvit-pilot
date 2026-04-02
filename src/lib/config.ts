import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface ToolConfig {
  model?: string;
  max_concurrent_jobs?: number;
  command?: string;
  fallback_tool?: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface CommandConfig {
  tool?: string;
  retry_model?: string;
  max_turns?: number;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface WatchConfig {
  poll_interval_s?: number;
  supervisor_cooldown_s?: number;
  max_fix_attempts?: number;
  max_pr_fix_attempts?: number;
  retry_model?: string;
}

export interface RateLimitConfig {
  retry_delays_m?: number[];
}

export interface Config {
  defaults: {
    tool: string;
    fallback_api_key?: string;
    max_concurrent_jobs?: number;
  };
  tools: Record<string, ToolConfig>;
  commands: Record<string, CommandConfig>;
  watch?: WatchConfig;
  rate_limit?: RateLimitConfig;
}

const BUILTIN_DEFAULTS: Config = {
  defaults: { tool: "claude", max_concurrent_jobs: 3 },
  tools: {
    claude: {
      "max-turns": 50,
      "allowed-tools": ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    },
    aider: {
      model: "claude-sonnet-4-6",
    },
  },
  commands: {
    triage: { max_turns: 5 },
    "plan-issue": { max_turns: 20 },
  },
  watch: {
    poll_interval_s: 60,
    supervisor_cooldown_s: 300,
    max_fix_attempts: 3,
    max_pr_fix_attempts: 3,
    retry_model: "opus",
  },
  rate_limit: {
    retry_delays_m: [5, 10, 20],
  },
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

    if (config.watch) {
      result.watch = { ...result.watch, ...config.watch };
    }

    if (config.rate_limit) {
      result.rate_limit = { ...result.rate_limit, ...config.rate_limit };
    }
  }

  return result;
}

export function resolveToolForCommand(config: Config, command: string): string {
  return config.commands[command]?.tool ?? config.defaults.tool;
}

export function resolveMaxConcurrentJobs(config: Config, toolName: string): number {
  return config.tools[toolName]?.max_concurrent_jobs ?? config.defaults.max_concurrent_jobs ?? 3;
}

export function resolveToolCommand(config: Config, toolName: string): string | undefined {
  return config.tools[toolName]?.command;
}

export function resolveCommandMaxTurns(config: Config, command: string, toolName: string): number | undefined {
  return config.commands[command]?.max_turns ?? (config.tools[toolName]?.["max-turns"] as number | undefined);
}

export function resolveWatchConfig(config: Config): Required<WatchConfig> {
  const defaults = BUILTIN_DEFAULTS.watch!;
  const w = config.watch ?? {};
  return {
    poll_interval_s: w.poll_interval_s ?? defaults.poll_interval_s!,
    supervisor_cooldown_s: w.supervisor_cooldown_s ?? defaults.supervisor_cooldown_s!,
    max_fix_attempts: w.max_fix_attempts ?? defaults.max_fix_attempts!,
    max_pr_fix_attempts: w.max_pr_fix_attempts ?? defaults.max_pr_fix_attempts!,
    retry_model: w.retry_model ?? defaults.retry_model!,
  };
}

export function resolveRateLimitDelays(config: Config): number[] {
  const minutes = config.rate_limit?.retry_delays_m ?? BUILTIN_DEFAULTS.rate_limit!.retry_delays_m!;
  return minutes.map((m) => m * 60_000);
}

const DEFAULT_CONFIG_TOML = `# flogvit-pilot global configuration
# This file is auto-generated. Edit freely — it won't be overwritten.

[defaults]
tool = "claude"
max_concurrent_jobs = 3
# fallback_api_key = "sk-..."

[tools.claude]
model = "claude-opus-4-6"
max-turns = 50
allowed-tools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]
# command = "claude"          # override binary name

# [tools.aider]
# model = "claude-sonnet-4-6"

# Ollama fallback on rate limit (optional)
# [tools.ollama]
# model = "qwen3.5:122b"
# max_concurrent_jobs = 1

# Per-command overrides
[commands.triage]
max_turns = 5

[commands.plan-issue]
max_turns = 20

# [commands.fix-issue]
# tool = "claude"
# retry_model = "opus"

# Watch / live mode settings
[watch]
poll_interval_s = 60
supervisor_cooldown_s = 300
max_fix_attempts = 3
max_pr_fix_attempts = 3
retry_model = "opus"

# Rate limit retry delays (minutes between retries)
[rate_limit]
retry_delays_m = [5, 10, 20]
`;

export async function ensureGlobalConfig(): Promise<void> {
  const homeDir = process.env.HOME ?? "~";
  const dir = join(homeDir, ".flogvit-pilot");
  const configPath = join(dir, "config.toml");

  if (existsSync(configPath)) return;

  await mkdir(dir, { recursive: true });
  await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf-8");
  console.log(`Created default config: ${configPath}`);
}

export async function resolveConfig(
  repoDir: string,
  cliFlags?: Partial<Config>
): Promise<Config> {
  const homeDir = process.env.HOME ?? "~";
  const globalConfig = await loadConfig(join(homeDir, ".flogvit-pilot"));
  const repoConfig = await loadConfig(join(repoDir, ".flogvit-pilot"));
  return mergeConfigs(globalConfig, repoConfig, cliFlags);
}
