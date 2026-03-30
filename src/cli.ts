#!/usr/bin/env bun

// Register all tool runners
import "./lib/tools/claude";
import "./lib/tools/aider";

import { resolveConfig } from "./lib/config";
import type { Config } from "./lib/config";

interface CommandModule {
  run(args: string[], config: Config, cwd: string): Promise<void>;
}

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  init: () => import("./commands/init"),
  "fix-issue": () => import("./commands/fix-issue"),
  "fix-issues": () => import("./commands/fix-issues"),
  watch: () => import("./commands/watch"),
  review: () => import("./commands/review"),
  audit: () => import("./commands/audit"),
  health: () => import("./commands/health"),
  implement: () => import("./commands/implement"),
  "update-deps": () => import("./commands/update-deps"),
  migrate: () => import("./commands/migrate"),
  refactor: () => import("./commands/refactor"),
  explain: () => import("./commands/explain"),
  changelog: () => import("./commands/changelog"),
  "test-gen": () => import("./commands/test-gen"),
  verify: () => import("./commands/verify"),
  triage: () => import("./commands/triage"),
  "review-pr": () => import("./commands/review-pr"),
  "pr-review": () => import("./commands/pr-review"),
};

function parseGlobalFlags(argv: string[]): {
  command: string | undefined;
  args: string[];
  flags: Partial<Config>;
  verbose: boolean;
  confirm: boolean;
} {
  const args: string[] = [];
  let tool: string | undefined;
  let verbose = false;
  let confirm = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--tool" && i + 1 < argv.length) {
      tool = argv[++i];
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--confirm") {
      confirm = true;
    } else {
      args.push(arg);
    }
    i++;
  }

  const command = args.shift();
  const flags: Partial<Config> = {};
  if (tool) {
    flags.defaults = { tool };
  }

  return { command, args, flags, verbose, confirm };
}

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
    console.log(`flogvit-coder v0.1.0

Usage: flogvit-coder <command> [options]

Commands:
  init                Set up flogvit-coder in current repo
  fix-issue <#>       Fix a GitHub issue and create PR
  fix-issues          Fix all issues labeled 'autofix'
  watch               Check for new work (cron-friendly)
  review              Code review → GitHub issues
  audit               Security audit → GitHub issues
  health              Repo health report
  implement <#>       Implement a feature issue
  update-deps         Update dependencies
  migrate <desc>      Run a migration
  refactor <desc>     Refactor code
  explain             Generate architecture overview
  changelog           Generate changelog
  test-gen            Generate missing tests
  verify              Run tests + lint + Playwright
  triage              Triage and label new issues
  review-pr <#>       AI code review of a PR → advance to needs-audit
  pr-review <#>       Review a pull request

Options:
  --tool <name>       Override AI tool (claude, aider)
  --verbose, -v       Show full AI output
  --confirm           Ask for confirmation before acting
  -h, --help          Show this help`);
    process.exit(0);
  }

  const { command, args, flags, verbose, confirm } = parseGlobalFlags(rawArgs);

  if (!command || !COMMANDS[command]) {
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'flogvit-coder --help' for available commands.`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const config = await resolveConfig(cwd, flags);

  try {
    const mod = await COMMANDS[command]();
    await mod.run(args, config, cwd);
  } catch (error) {
    console.error(`Error running '${command}':`, error);
    process.exit(1);
  }
}

main();
