# flogvit-coder Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core CLI infrastructure and three essential commands (init, fix-issue, watch) so flogvit-coder can autonomously fix GitHub issues and create PRs.

**Architecture:** Bun CLI with Unix-style command composition. Each command is a self-contained module with a paired .md instruction file. A thin lib layer provides config loading, AI tool orchestration, GitHub integration, logging, templating, and state persistence.

**Tech Stack:** Bun runtime, TypeScript, TOML config (`@iarna/toml`), `gh` CLI for GitHub, `claude`/`aider` CLI for AI backends.

---

## File Map

### Lib files (created in Tasks 1-7)
| File | Responsibility |
|------|---------------|
| `src/lib/config.ts` | Load and merge config from global → repo → CLI flags |
| `src/lib/logger.ts` | Terminal summary output + detailed file-based logging |
| `src/lib/template.ts` | Read .md files and replace `{{variables}}` |
| `src/lib/github.ts` | Wrapper around `gh` CLI (issues, PRs, labels) |
| `src/lib/tool-runner.ts` | ToolRunner interface + registry |
| `src/lib/tools/claude.ts` | Claude CLI tool runner implementation |
| `src/lib/tools/aider.ts` | Aider CLI tool runner implementation |
| `src/lib/state.ts` | Serialize/restore paused work context |
| `src/lib/context.ts` | Gather repo context (language, structure, etc.) |

### CLI entry (created in Task 8)
| File | Responsibility |
|------|---------------|
| `src/cli.ts` | Entry point, parse global flags, dispatch to command |

### Commands (created in Tasks 9-11)
| File | Responsibility |
|------|---------------|
| `src/commands/init.ts` | Set up `.flogvit-coder/` dir and GitHub labels |
| `src/commands/fix-issue.ts` | Fix a single issue → branch + PR |
| `src/commands/fix-issue.md` | AI prompt template for fix-issue |
| `src/commands/fix-issues.ts` | Fix all autofix-labeled issues (orchestrates fix-issue) |
| `src/commands/watch.ts` | Cheap cron checks, trigger fix-issue/resume waiting |

### Test files
| File | Tests for |
|------|-----------|
| `tests/lib/config.test.ts` | Config loading and merging |
| `tests/lib/template.test.ts` | Template variable replacement |
| `tests/lib/logger.test.ts` | Log file writing and terminal output |
| `tests/lib/state.test.ts` | State serialization and restoration |
| `tests/lib/github.test.ts` | GitHub CLI wrapper |
| `tests/lib/tools/claude.test.ts` | Claude tool runner |
| `tests/commands/init.test.ts` | Init command |
| `tests/commands/fix-issue.test.ts` | Fix-issue command |
| `tests/commands/watch.test.ts` | Watch command |

---

## Task 1: Project Setup

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/cli.ts` (stub)

- [ ] **Step 1: Initialize the Bun project**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder
bun init -y
```

- [ ] **Step 2: Install dependencies**

```bash
bun add @iarna/toml
bun add -d @types/bun
```

- [ ] **Step 3: Update package.json**

Replace the generated `package.json` with:

```json
{
  "name": "flogvit-coder",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "flogvit-coder": "./src/cli.ts"
  },
  "scripts": {
    "test": "bun test",
    "dev": "bun run src/cli.ts"
  },
  "dependencies": {
    "@iarna/toml": "^3.0.0"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "baseUrl": ".",
    "paths": {
      "@lib/*": ["./src/lib/*"]
    }
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 5: Create CLI stub**

Create `src/cli.ts`:

```typescript
#!/usr/bin/env bun

console.log("flogvit-coder v0.1.0");
```

- [ ] **Step 6: Verify it runs**

```bash
bun run src/cli.ts
```

Expected: `flogvit-coder v0.1.0`

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json bun.lock src/cli.ts
git commit -m "chore: initialize bun project with CLI stub"
```

---

## Task 2: Config Module

**Files:**
- Create: `src/lib/config.ts`
- Create: `tests/lib/config.test.ts`

- [ ] **Step 1: Write failing tests for config loading**

Create `tests/lib/config.test.ts`:

```typescript
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
        aider: { model: "claude-sonnet-4-20250514" },
      },
      commands: {},
    };
    const result = mergeConfigs(global, repo);
    expect(result.tools.claude?.["max-turns"]).toBe(20);
    expect(result.tools.aider?.model).toBe("claude-sonnet-4-20250514");
  });
});

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-coder-test-"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/config.test.ts
```

Expected: FAIL — module `../../src/lib/config` not found.

- [ ] **Step 3: Implement config module**

Create `src/lib/config.ts`:

```typescript
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lib/config.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts tests/lib/config.test.ts
git commit -m "feat: add config module with TOML loading and merge hierarchy"
```

---

## Task 3: Logger Module

**Files:**
- Create: `src/lib/logger.ts`
- Create: `tests/lib/logger.test.ts`

- [ ] **Step 1: Write failing tests for logger**

Create `tests/lib/logger.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Logger } from "../../src/lib/logger";
import { mkdtemp, rm, readFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("Logger", () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), "flogvit-coder-log-"));
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/logger.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement logger module**

Create `src/lib/logger.ts`:

```typescript
import { mkdir, appendFile } from "fs/promises";
import { join } from "path";

export interface LoggerOptions {
  logDir: string;
  repoName: string;
  command: string;
  verbose: boolean;
}

export class Logger {
  private logFile: string;
  private summaries: string[] = [];
  private buffer: string[] = [];
  private options: LoggerOptions;

  constructor(options: LoggerOptions) {
    this.options = options;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = join(
      options.logDir,
      options.repoName,
      `${timestamp}-${options.command}.log`
    );
  }

  summary(message: string): void {
    this.summaries.push(message);
    console.log(message);
  }

  detail(message: string): void {
    this.buffer.push(message);
    if (this.options.verbose) {
      console.log(message);
    }
  }

  error(message: string): void {
    this.buffer.push(`[ERROR] ${message}`);
    console.error(message);
  }

  getSummaries(): string[] {
    return [...this.summaries];
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const dir = join(
      this.options.logDir,
      this.options.repoName
    );
    await mkdir(dir, { recursive: true });
    await appendFile(this.logFile, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lib/logger.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/logger.ts tests/lib/logger.test.ts
git commit -m "feat: add logger with terminal summary and file-based detailed logs"
```

---

## Task 4: Template Module

**Files:**
- Create: `src/lib/template.ts`
- Create: `tests/lib/template.test.ts`

- [ ] **Step 1: Write failing tests for template**

Create `tests/lib/template.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderTemplate, loadTemplate } from "../../src/lib/template";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("renderTemplate", () => {
  test("replaces single variable", () => {
    const result = renderTemplate("Fix {{issue_title}}", {
      issue_title: "broken thumbnails",
    });
    expect(result).toBe("Fix broken thumbnails");
  });

  test("replaces multiple variables", () => {
    const result = renderTemplate(
      "Issue #{{issue_num}}: {{issue_title}}",
      { issue_num: "42", issue_title: "crash on startup" }
    );
    expect(result).toBe("Issue #42: crash on startup");
  });

  test("replaces all occurrences of same variable", () => {
    const result = renderTemplate(
      "{{name}} says hello to {{name}}",
      { name: "bot" }
    );
    expect(result).toBe("bot says hello to bot");
  });

  test("leaves unknown variables as-is", () => {
    const result = renderTemplate("Hello {{unknown}}", {});
    expect(result).toBe("Hello {{unknown}}");
  });

  test("handles multiline templates", () => {
    const template = `# Review for {{repo}}

{{repo_context}}

Please review.`;
    const result = renderTemplate(template, {
      repo: "culling",
      repo_context: "Rust project with egui",
    });
    expect(result).toContain("# Review for culling");
    expect(result).toContain("Rust project with egui");
  });
});

describe("loadTemplate", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-coder-tpl-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("loads repo override when present", async () => {
    const repoPromptDir = join(tempDir, "repo", ".flogvit-coder", "prompts");
    await mkdir(repoPromptDir, { recursive: true });
    await writeFile(join(repoPromptDir, "review.md"), "Custom: {{repo}}");

    const builtinDir = join(tempDir, "builtin");
    await mkdir(builtinDir, { recursive: true });
    await writeFile(join(builtinDir, "review.md"), "Default: {{repo}}");

    const template = await loadTemplate("review", {
      builtinDir,
      repoDir: join(tempDir, "repo"),
    });
    expect(template).toBe("Custom: {{repo}}");
  });

  test("falls back to builtin when no repo override", async () => {
    const builtinDir = join(tempDir, "builtin");
    await mkdir(builtinDir, { recursive: true });
    await writeFile(join(builtinDir, "review.md"), "Default: {{repo}}");

    const template = await loadTemplate("review", {
      builtinDir,
      repoDir: join(tempDir, "repo"),
    });
    expect(template).toBe("Default: {{repo}}");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/template.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement template module**

Create `src/lib/template.ts`:

```typescript
import { readFile } from "fs/promises";
import { join } from "path";

export function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] ?? match;
  });
}

export interface TemplateLoadOptions {
  builtinDir: string;
  repoDir: string;
}

export async function loadTemplate(
  command: string,
  options: TemplateLoadOptions
): Promise<string> {
  const repoOverridePath = join(
    options.repoDir,
    ".flogvit-coder",
    "prompts",
    `${command}.md`
  );

  try {
    return await readFile(repoOverridePath, "utf-8");
  } catch {
    // Fall back to builtin
  }

  const builtinPath = join(options.builtinDir, `${command}.md`);
  return await readFile(builtinPath, "utf-8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lib/template.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/template.ts tests/lib/template.test.ts
git commit -m "feat: add template module with variable substitution and override loading"
```

---

## Task 5: GitHub Module

**Files:**
- Create: `src/lib/github.ts`
- Create: `tests/lib/github.test.ts`

- [ ] **Step 1: Write failing tests for GitHub module**

Create `tests/lib/github.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

// We test the parsing/formatting helpers, not the gh CLI calls themselves
import {
  formatIssueComment,
  parseBranchName,
  LABELS,
} from "../../src/lib/github";

describe("formatIssueComment", () => {
  test("formats a status comment", () => {
    const comment = formatIssueComment("in-progress", "Working on fix");
    expect(comment).toContain("🤖 **flogvit-coder**");
    expect(comment).toContain("in-progress");
    expect(comment).toContain("Working on fix");
  });

  test("formats a waiting comment", () => {
    const comment = formatIssueComment(
      "waiting",
      "Need clarification: should this handle null values?"
    );
    expect(comment).toContain("waiting");
    expect(comment).toContain("Need clarification");
  });
});

describe("parseBranchName", () => {
  test("generates fix branch name", () => {
    expect(parseBranchName("fix", 42)).toBe("flogvit-coder/fix-42");
  });

  test("generates impl branch name", () => {
    expect(parseBranchName("impl", 17)).toBe("flogvit-coder/impl-17");
  });

  test("generates refactor branch name from description", () => {
    expect(parseBranchName("refactor", "extract config module")).toBe(
      "flogvit-coder/refactor-extract-config-module"
    );
  });

  test("sanitizes description for branch name", () => {
    expect(parseBranchName("refactor", "fix/weird chars!@#")).toBe(
      "flogvit-coder/refactor-fix-weird-chars"
    );
  });
});

describe("LABELS", () => {
  test("has all required labels defined", () => {
    expect(LABELS.autofix).toBe("autofix");
    expect(LABELS.autoImplement).toBe("auto-implement");
    expect(LABELS.autoReview).toBe("auto-review");
    expect(LABELS.waiting).toBe("flogvit-coder:waiting");
    expect(LABELS.inProgress).toBe("flogvit-coder:in-progress");
    expect(LABELS.failed).toBe("flogvit-coder:failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/github.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement GitHub module**

Create `src/lib/github.ts`:

```typescript
import { $ } from "bun";

export const LABELS = {
  autofix: "autofix",
  autoImplement: "auto-implement",
  autoReview: "auto-review",
  waiting: "flogvit-coder:waiting",
  inProgress: "flogvit-coder:in-progress",
  failed: "flogvit-coder:failed",
} as const;

const LABEL_DEFINITIONS = [
  { name: LABELS.autofix, description: "flogvit-coder: auto-fix this issue", color: "0e8a16" },
  { name: LABELS.autoImplement, description: "flogvit-coder: auto-implement this feature", color: "1d76db" },
  { name: LABELS.autoReview, description: "flogvit-coder: auto-review this PR", color: "5319e7" },
  { name: LABELS.waiting, description: "flogvit-coder: waiting for human input", color: "fbca04" },
  { name: LABELS.inProgress, description: "flogvit-coder: currently working", color: "0075ca" },
  { name: LABELS.failed, description: "flogvit-coder: failed, needs manual help", color: "d73a4a" },
];

export function formatIssueComment(
  status: string,
  message: string
): string {
  return `🤖 **flogvit-coder** — ${status}\n\n${message}`;
}

export function parseBranchName(
  type: "fix" | "impl" | "refactor",
  identifier: number | string
): string {
  if (typeof identifier === "number") {
    return `flogvit-coder/${type}-${identifier}`;
  }
  const sanitized = identifier
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return `flogvit-coder/${type}-${sanitized}`;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: { body: string; author: string; createdAt: string }[];
}

export async function getIssue(issueNum: number, cwd: string): Promise<Issue> {
  const result = await $`gh issue view ${issueNum} --json number,title,body,labels,comments`.cwd(cwd).text();
  const data = JSON.parse(result);
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? "",
    labels: data.labels?.map((l: { name: string }) => l.name) ?? [],
    comments: data.comments?.map((c: { body: string; author: { login: string }; createdAt: string }) => ({
      body: c.body,
      author: c.author.login,
      createdAt: c.createdAt,
    })) ?? [],
  };
}

export async function listIssuesWithLabel(
  label: string,
  cwd: string
): Promise<{ number: number; title: string }[]> {
  const result = await $`gh issue list --label ${label} --state open --limit 50 --json number,title`.cwd(cwd).text();
  return JSON.parse(result);
}

export async function addLabel(
  issueNum: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh issue edit ${issueNum} --add-label ${label}`.cwd(cwd);
}

export async function removeLabel(
  issueNum: number,
  label: string,
  cwd: string
): Promise<void> {
  await $`gh issue edit ${issueNum} --remove-label ${label}`.cwd(cwd).nothrow();
}

export async function commentOnIssue(
  issueNum: number,
  body: string,
  cwd: string
): Promise<void> {
  await $`gh issue comment ${issueNum} --body ${body}`.cwd(cwd);
}

export async function createPullRequest(
  opts: { title: string; body: string; base?: string },
  cwd: string
): Promise<string> {
  const base = opts.base ?? "main";
  const result = await $`gh pr create --title ${opts.title} --body ${opts.body} --base ${base}`.cwd(cwd).text();
  return result.trim();
}

export async function ensureLabels(cwd: string): Promise<void> {
  for (const label of LABEL_DEFINITIONS) {
    await $`gh label create ${label.name} --description ${label.description} --color ${label.color}`.cwd(cwd).nothrow();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/lib/github.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.ts tests/lib/github.test.ts
git commit -m "feat: add GitHub module with gh CLI wrappers, labels, and comment formatting"
```

---

## Task 6: Tool Runner Abstraction + Claude/Aider Implementations

**Files:**
- Create: `src/lib/tool-runner.ts`
- Create: `src/lib/tools/claude.ts`
- Create: `src/lib/tools/aider.ts`
- Create: `tests/lib/tools/claude.test.ts`

- [ ] **Step 1: Write failing tests for Claude tool runner**

Create `tests/lib/tools/claude.test.ts`:

```typescript
import { describe, test, expect, mock, beforeEach } from "bun:test";
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
    expect(args).toContain("30");
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/tools/claude.test.ts
```

Expected: FAIL — modules not found.

- [ ] **Step 3: Implement tool-runner interface**

Create `src/lib/tool-runner.ts`:

```typescript
export interface ToolRunnerOptions {
  prompt: string;
  cwd: string;
  allowedTools?: string[];
  maxTurns?: number;
}

export interface ToolResult {
  success: boolean;
  output: string;
  summary: string;
}

export interface ToolRunner {
  name: string;
  run(opts: ToolRunnerOptions): Promise<ToolResult>;
}

const registry = new Map<string, ToolRunner>();

export function registerTool(runner: ToolRunner): void {
  registry.set(runner.name, runner);
}

export function getTool(name: string): ToolRunner {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(
      `Unknown tool "${name}". Available: ${[...registry.keys()].join(", ")}`
    );
  }
  return tool;
}

export function getAvailableTools(): string[] {
  return [...registry.keys()];
}
```

- [ ] **Step 4: Implement Claude runner**

Create `src/lib/tools/claude.ts`:

```typescript
import { $ } from "bun";
import type { ToolRunner, ToolRunnerOptions, ToolResult } from "../tool-runner";
import { registerTool } from "../tool-runner";

export class ClaudeRunner implements ToolRunner {
  name = "claude";

  buildArgs(opts: ToolRunnerOptions): (string | number)[] {
    const args: (string | number)[] = ["-p", opts.prompt, "--output-format", "text"];

    if (opts.maxTurns) {
      args.push("--max-turns", opts.maxTurns);
    }

    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push("--allowedTools", opts.allowedTools.join(","));
    }

    return args;
  }

  async run(opts: ToolRunnerOptions): Promise<ToolResult> {
    const args = this.buildArgs(opts);

    try {
      const proc = Bun.spawn(["claude", ...args.map(String)], {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return {
          success: false,
          output: `${output}\n${stderr}`,
          summary: `Claude exited with code ${exitCode}`,
        };
      }

      // Extract last line as summary (Claude typically ends with a summary)
      const lines = output.trim().split("\n");
      const summary = lines[lines.length - 1] ?? "";

      return {
        success: true,
        output,
        summary,
      };
    } catch (error) {
      return {
        success: false,
        output: String(error),
        summary: `Failed to run claude: ${error}`,
      };
    }
  }
}

registerTool(new ClaudeRunner());
```

- [ ] **Step 5: Implement Aider runner**

Create `src/lib/tools/aider.ts`:

```typescript
import type { ToolRunner, ToolRunnerOptions, ToolResult } from "../tool-runner";
import { registerTool } from "../tool-runner";

export class AiderRunner implements ToolRunner {
  name = "aider";

  buildArgs(opts: ToolRunnerOptions): string[] {
    const args: string[] = [
      "--message", opts.prompt,
      "--yes-always",
      "--no-git",
    ];

    return args;
  }

  async run(opts: ToolRunnerOptions): Promise<ToolResult> {
    const args = this.buildArgs(opts);

    try {
      const proc = Bun.spawn(["aider", ...args], {
        cwd: opts.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        return {
          success: false,
          output: `${output}\n${stderr}`,
          summary: `Aider exited with code ${exitCode}`,
        };
      }

      const lines = output.trim().split("\n");
      const summary = lines[lines.length - 1] ?? "";

      return {
        success: true,
        output,
        summary,
      };
    } catch (error) {
      return {
        success: false,
        output: String(error),
        summary: `Failed to run aider: ${error}`,
      };
    }
  }
}

registerTool(new AiderRunner());
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
bun test tests/lib/tools/claude.test.ts
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/tool-runner.ts src/lib/tools/claude.ts src/lib/tools/aider.ts tests/lib/tools/claude.test.ts
git commit -m "feat: add tool runner abstraction with Claude and Aider implementations"
```

---

## Task 7: State Module + Repo Context

**Files:**
- Create: `src/lib/state.ts`
- Create: `src/lib/context.ts`
- Create: `tests/lib/state.test.ts`

- [ ] **Step 1: Write failing tests for state module**

Create `tests/lib/state.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { saveState, loadState, clearState, type WorkState } from "../../src/lib/state";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

describe("state", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "flogvit-coder-state-"));
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true });
  });

  test("save and load round-trips state", async () => {
    const state: WorkState = {
      issueNumber: 42,
      command: "fix-issue",
      branch: "flogvit-coder/fix-42",
      agentSummary: "Started fixing the bug, need to know if null values are valid input",
      question: "Should this function handle null values?",
      issueData: {
        title: "Crash on null input",
        body: "The app crashes when...",
      },
      createdAt: "2026-03-30T12:00:00Z",
    };

    await saveState(stateDir, "my-repo", 42, state);
    const loaded = await loadState(stateDir, "my-repo", 42);

    expect(loaded).not.toBeNull();
    expect(loaded!.issueNumber).toBe(42);
    expect(loaded!.command).toBe("fix-issue");
    expect(loaded!.branch).toBe("flogvit-coder/fix-42");
    expect(loaded!.agentSummary).toContain("Started fixing");
    expect(loaded!.question).toContain("null values");
  });

  test("returns null for non-existent state", async () => {
    const loaded = await loadState(stateDir, "my-repo", 999);
    expect(loaded).toBeNull();
  });

  test("clearState removes the state file", async () => {
    const state: WorkState = {
      issueNumber: 10,
      command: "fix-issue",
      branch: null,
      agentSummary: "test",
      question: null,
      issueData: { title: "test", body: "" },
      createdAt: "2026-03-30T12:00:00Z",
    };

    await saveState(stateDir, "repo", 10, state);
    await clearState(stateDir, "repo", 10);
    const loaded = await loadState(stateDir, "repo", 10);
    expect(loaded).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lib/state.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement state module**

Create `src/lib/state.ts`:

```typescript
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";

export interface WorkState {
  issueNumber: number;
  command: string;
  branch: string | null;
  agentSummary: string;
  question: string | null;
  issueData: {
    title: string;
    body: string;
  };
  createdAt: string;
}

function statePath(stateDir: string, repoName: string, issueNum: number): string {
  return join(stateDir, repoName, `${issueNum}.json`);
}

export async function saveState(
  stateDir: string,
  repoName: string,
  issueNum: number,
  state: WorkState
): Promise<void> {
  const dir = join(stateDir, repoName);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(stateDir, repoName, issueNum), JSON.stringify(state, null, 2));
}

export async function loadState(
  stateDir: string,
  repoName: string,
  issueNum: number
): Promise<WorkState | null> {
  try {
    const content = await readFile(statePath(stateDir, repoName, issueNum), "utf-8");
    return JSON.parse(content) as WorkState;
  } catch {
    return null;
  }
}

export async function clearState(
  stateDir: string,
  repoName: string,
  issueNum: number
): Promise<void> {
  try {
    await unlink(statePath(stateDir, repoName, issueNum));
  } catch {
    // Already gone
  }
}
```

- [ ] **Step 4: Implement context module**

Create `src/lib/context.ts`:

```typescript
import { $ } from "bun";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";

export interface RepoContext {
  repoName: string;
  language: string;
  fileStructure: string;
  claudeMd: string | null;
  defaultBranch: string;
}

async function detectLanguage(cwd: string): Promise<string> {
  const indicators: Record<string, string> = {
    "Cargo.toml": "Rust",
    "package.json": "TypeScript/JavaScript",
    "pyproject.toml": "Python",
    "go.mod": "Go",
    "pom.xml": "Java",
    "build.gradle": "Java/Kotlin",
    "Gemfile": "Ruby",
  };

  for (const [file, language] of Object.entries(indicators)) {
    try {
      await stat(join(cwd, file));
      return language;
    } catch {
      continue;
    }
  }
  return "Unknown";
}

async function getFileStructure(cwd: string): Promise<string> {
  try {
    const result = await $`find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './target/*' -not -path './.next/*' | head -100`.cwd(cwd).text();
    return result.trim();
  } catch {
    return "";
  }
}

async function getDefaultBranch(cwd: string): Promise<string> {
  try {
    const result = await $`git symbolic-ref refs/remotes/origin/HEAD`.cwd(cwd).text();
    return result.trim().replace("refs/remotes/origin/", "");
  } catch {
    return "main";
  }
}

export async function gatherRepoContext(cwd: string): Promise<RepoContext> {
  const repoName = basename(cwd);
  const [language, fileStructure, defaultBranch] = await Promise.all([
    detectLanguage(cwd),
    getFileStructure(cwd),
    getDefaultBranch(cwd),
  ]);

  let claudeMd: string | null = null;
  try {
    claudeMd = await readFile(join(cwd, "CLAUDE.md"), "utf-8");
  } catch {
    // No CLAUDE.md
  }

  return { repoName, language, fileStructure, claudeMd, defaultBranch };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/lib/state.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/state.ts src/lib/context.ts tests/lib/state.test.ts
git commit -m "feat: add state persistence and repo context gathering"
```

---

## Task 8: CLI Dispatcher

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Implement the CLI dispatcher**

Replace `src/cli.ts` with:

```typescript
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
```

- [ ] **Step 2: Verify help output works**

```bash
bun run src/cli.ts --help
```

Expected: Shows help text with all commands listed.

- [ ] **Step 3: Verify unknown command gives error**

```bash
bun run src/cli.ts nonexistent
```

Expected: `Unknown command: nonexistent`

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: add CLI dispatcher with global flag parsing and command routing"
```

---

## Task 9: Init Command

**Files:**
- Create: `src/commands/init.ts`
- Create: `tests/commands/init.test.ts`

- [ ] **Step 1: Write failing test for init command**

Create `tests/commands/init.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, stat, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createLocalConfig } from "../../src/commands/init";

describe("init", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-coder-init-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("creates .flogvit-coder directory structure", async () => {
    await createLocalConfig(tempDir);

    const dirStat = await stat(join(tempDir, ".flogvit-coder"));
    expect(dirStat.isDirectory()).toBe(true);

    const promptsStat = await stat(join(tempDir, ".flogvit-coder", "prompts"));
    expect(promptsStat.isDirectory()).toBe(true);
  });

  test("creates default config.toml", async () => {
    await createLocalConfig(tempDir);

    const configStat = await stat(join(tempDir, ".flogvit-coder", "config.toml"));
    expect(configStat.isFile()).toBe(true);
  });

  test("does not overwrite existing config", async () => {
    await createLocalConfig(tempDir);
    // Write custom content
    const configPath = join(tempDir, ".flogvit-coder", "config.toml");
    await Bun.write(configPath, "# custom\n");

    // Run again
    await createLocalConfig(tempDir);

    const content = await Bun.file(configPath).text();
    expect(content).toBe("# custom\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/commands/init.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement init command**

Create `src/commands/init.ts`:

```typescript
import { mkdir, stat, writeFile } from "fs/promises";
import { join } from "path";
import { ensureLabels } from "../lib/github";
import type { Config } from "../lib/config";

const DEFAULT_CONFIG = `# flogvit-coder config for this repo
# See ~/.flogvit-coder/config.toml for global defaults

# [defaults]
# tool = "claude"

# [commands.fix-issue]
# tool = "aider"
`;

export async function createLocalConfig(cwd: string): Promise<void> {
  const baseDir = join(cwd, ".flogvit-coder");
  const promptsDir = join(baseDir, "prompts");

  await mkdir(promptsDir, { recursive: true });

  const configPath = join(baseDir, "config.toml");
  try {
    await stat(configPath);
    // Config already exists, don't overwrite
  } catch {
    await writeFile(configPath, DEFAULT_CONFIG);
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  console.log("Initializing flogvit-coder...");

  await createLocalConfig(cwd);
  console.log("  Created .flogvit-coder/ directory");

  await ensureLabels(cwd);
  console.log("  Created GitHub labels");

  console.log("\nDone! flogvit-coder is ready in this repo.");
  console.log("Add .flogvit-coder/ to .gitignore if you don't want to commit config.");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/commands/init.test.ts
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/init.ts tests/commands/init.test.ts
git commit -m "feat: add init command to set up repo config and GitHub labels"
```

---

## Task 10: Fix-Issue Command

**Files:**
- Create: `src/commands/fix-issue.ts`
- Create: `src/commands/fix-issue.md`
- Create: `tests/commands/fix-issue.test.ts`

- [ ] **Step 1: Create the prompt template**

Create `src/commands/fix-issue.md`:

```markdown
You are an autonomous coding agent fixing a GitHub issue.

## Issue #{{issue_num}}: {{issue_title}}

{{issue_body}}

{{issue_comments}}

## Repository Context

- **Language:** {{language}}
- **Repository:** {{repo_name}}

{{claude_md}}

## File Structure

{{file_structure}}

## Instructions

1. Read the issue carefully and understand what needs to be fixed.
2. Explore the codebase to find the relevant files.
3. Make the minimal changes needed to fix the issue.
4. Run any existing tests to verify your fix doesn't break anything.
5. If the project has a linter, run it.

## Rules

- Make minimal, focused changes. Don't refactor unrelated code.
- Follow existing code style and conventions.
- If you cannot fix this issue, respond with EXACTLY this on the last line:
  `FLOGVIT-CODER:STUCK:<your question for the developer>`
- If you successfully fix the issue, respond with EXACTLY this on the last line:
  `FLOGVIT-CODER:DONE:<one-line summary of what you did>`
```

- [ ] **Step 2: Write failing test for fix-issue orchestration**

Create `tests/commands/fix-issue.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/commands/fix-issue.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement fix-issue command**

Create `src/commands/fix-issue.ts`:

```typescript
import { $ } from "bun";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { getTool } from "../lib/tool-runner";
import {
  getIssue,
  addLabel,
  removeLabel,
  commentOnIssue,
  createPullRequest,
  formatIssueComment,
  parseBranchName,
  LABELS,
  type Issue,
} from "../lib/github";
import { gatherRepoContext } from "../lib/context";
import { loadTemplate, renderTemplate } from "../lib/template";
import { saveState, clearState } from "../lib/state";
import { Logger } from "../lib/logger";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ToolOutputResult {
  status: "done" | "stuck" | "unknown";
  message: string;
}

export function parseToolOutput(output: string): ToolOutputResult {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("FLOGVIT-CODER:DONE:")) {
      return { status: "done", message: line.replace("FLOGVIT-CODER:DONE:", "") };
    }
    if (line.startsWith("FLOGVIT-CODER:STUCK:")) {
      return { status: "stuck", message: line.replace("FLOGVIT-CODER:STUCK:", "") };
    }
  }
  return { status: "unknown", message: "" };
}

export function buildIssueCommentsSection(
  comments: { body: string; author: string; createdAt: string }[]
): string {
  if (comments.length === 0) return "";

  const lines = comments.map(
    (c) => `**${c.author}** (${c.createdAt}):\n${c.body}`
  );
  return `## Comments\n\n${lines.join("\n\n---\n\n")}`;
}

export async function fixIssue(
  issueNum: number,
  config: Config,
  cwd: string,
  verbose: boolean = false
): Promise<{ success: boolean; prUrl?: string }> {
  const homeDir = process.env.HOME ?? "~";
  const logDir = resolve(homeDir, ".flogvit-coder", "logs");
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");
  const repoContext = await gatherRepoContext(cwd);
  const logger = new Logger({ logDir, repoName: repoContext.repoName, command: "fix-issue", verbose });

  // Fetch issue
  const issue = await getIssue(issueNum, cwd);
  await addLabel(issueNum, LABELS.inProgress, cwd);

  // Build prompt
  const template = await loadTemplate("fix-issue", {
    builtinDir: __dirname,
    repoDir: cwd,
  });

  const prompt = renderTemplate(template, {
    issue_num: String(issue.number),
    issue_title: issue.title,
    issue_body: issue.body,
    issue_comments: buildIssueCommentsSection(issue.comments),
    language: repoContext.language,
    repo_name: repoContext.repoName,
    claude_md: repoContext.claudeMd ? `## Project Instructions\n\n${repoContext.claudeMd}` : "",
    file_structure: repoContext.fileStructure,
  });

  // Create branch
  const branch = parseBranchName("fix", issueNum);
  await $`git checkout -b ${branch}`.cwd(cwd);

  // Run AI tool
  const toolName = resolveToolForCommand(config, "fix-issue");
  const tool = getTool(toolName);
  const toolConfig = config.tools[toolName] ?? {};

  logger.detail(`Running ${toolName} for issue #${issueNum}`);

  const result = await tool.run({
    prompt,
    cwd,
    maxTurns: (toolConfig["max-turns"] as number) ?? undefined,
    allowedTools: (toolConfig["allowed-tools"] as string[]) ?? undefined,
  });

  logger.detail(result.output);
  await logger.flush();

  const parsed = parseToolOutput(result.output);

  // Check if there are actual changes
  const diffResult = await $`git diff --stat`.cwd(cwd).text();
  const hasChanges = diffResult.trim().length > 0;

  if (parsed.status === "stuck" || (!hasChanges && parsed.status !== "done")) {
    // Agent is stuck or made no changes
    const question = parsed.message || "Could not determine how to fix this issue. Please provide more details.";

    await saveState(stateDir, repoContext.repoName, issueNum, {
      issueNumber: issueNum,
      command: "fix-issue",
      branch: hasChanges ? branch : null,
      agentSummary: result.summary,
      question,
      issueData: { title: issue.title, body: issue.body },
      createdAt: new Date().toISOString(),
    });

    await commentOnIssue(
      issueNum,
      formatIssueComment("waiting", question),
      cwd
    );
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await addLabel(issueNum, LABELS.waiting, cwd);

    // Go back to default branch if no changes
    if (!hasChanges) {
      await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);
      await $`git branch -D ${branch}`.cwd(cwd).nothrow();
    }

    logger.summary(`Issue #${issueNum}: stuck — asked question on issue`);
    return { success: false };
  }

  if (!hasChanges) {
    await removeLabel(issueNum, LABELS.inProgress, cwd);
    await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);
    await $`git branch -D ${branch}`.cwd(cwd).nothrow();
    logger.summary(`Issue #${issueNum}: no changes made`);
    return { success: false };
  }

  // Commit, push, create PR
  await $`git add -A`.cwd(cwd);
  await $`git commit -m ${`fix: ${issue.title} (fixes #${issueNum})`}`.cwd(cwd);
  await $`git push -u origin ${branch}`.cwd(cwd);

  const prUrl = await createPullRequest(
    {
      title: `Fix #${issueNum}: ${issue.title}`,
      body: `## Summary\n\nAutomatically fixes #${issueNum}.\n\n${parsed.message || result.summary}\n\n---\n🤖 Generated by flogvit-coder`,
      base: repoContext.defaultBranch,
    },
    cwd
  );

  await commentOnIssue(
    issueNum,
    formatIssueComment("done", `Created PR: ${prUrl}`),
    cwd
  );
  await removeLabel(issueNum, LABELS.inProgress, cwd);
  await clearState(stateDir, repoContext.repoName, issueNum);

  // Go back to default branch
  await $`git checkout ${repoContext.defaultBranch}`.cwd(cwd);

  logger.summary(`Issue #${issueNum}: fixed — ${prUrl}`);
  return { success: true, prUrl };
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issueNum = parseInt(args[0], 10);
  if (isNaN(issueNum)) {
    console.error("Usage: flogvit-coder fix-issue <issue-number>");
    process.exit(1);
  }

  const verbose = args.includes("--verbose") || args.includes("-v");
  await fixIssue(issueNum, config, cwd, verbose);
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/commands/fix-issue.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/fix-issue.ts src/commands/fix-issue.md tests/commands/fix-issue.test.ts
git commit -m "feat: add fix-issue command with AI tool orchestration and state management"
```

---

## Task 11: Watch Command + Fix-Issues

**Files:**
- Create: `src/commands/watch.ts`
- Create: `src/commands/fix-issues.ts`
- Create: `tests/commands/watch.test.ts`

- [ ] **Step 1: Write failing test for watch logic**

Create `tests/commands/watch.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { findAnsweredIssues } from "../../src/commands/watch";

describe("findAnsweredIssues", () => {
  test("identifies issues with new comments after bot question", () => {
    const issues = [
      {
        number: 42,
        comments: [
          { author: "flogvit-coder-bot", body: "🤖 **flogvit-coder** — waiting\n\nWhat encoding?", createdAt: "2026-03-30T10:00:00Z" },
          { author: "vhanssen", body: "UTF-8 only", createdAt: "2026-03-30T11:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, "flogvit-coder-bot");
    expect(result).toEqual([42]);
  });

  test("ignores issues where bot asked last", () => {
    const issues = [
      {
        number: 10,
        comments: [
          { author: "flogvit-coder-bot", body: "🤖 **flogvit-coder** — waiting\n\nQuestion", createdAt: "2026-03-30T10:00:00Z" },
        ],
      },
    ];
    const result = findAnsweredIssues(issues, "flogvit-coder-bot");
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/commands/watch.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement watch command**

Create `src/commands/watch.ts`:

```typescript
import { resolve, basename } from "path";
import type { Config } from "../lib/config";
import { listIssuesWithLabel, getIssue, removeLabel, LABELS } from "../lib/github";
import { loadState } from "../lib/state";
import { fixIssue } from "./fix-issue";

interface IssueWithComments {
  number: number;
  comments: { author: string; body: string; createdAt: string }[];
}

export function findAnsweredIssues(
  issues: IssueWithComments[],
  botIdentifier: string
): number[] {
  const answered: number[] = [];

  for (const issue of issues) {
    if (issue.comments.length === 0) continue;
    const lastComment = issue.comments[issue.comments.length - 1];
    if (lastComment.author !== botIdentifier) {
      answered.push(issue.number);
    }
  }

  return answered;
}

async function watchRepo(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? "~";
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  // 1. Check for new autofix issues
  const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
  const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
  const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

  for (const issue of autofixIssues) {
    if (inProgressNums.has(issue.number)) continue;

    // Check if we already have state (i.e., we're waiting)
    const existingState = await loadState(stateDir, repoName, issue.number);
    if (existingState) continue;

    console.log(`Found new autofix issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }

  // 2. Check for answered waiting issues
  const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
  for (const waitingIssue of waitingIssues) {
    const fullIssue = await getIssue(waitingIssue.number, cwd);
    const comments = fullIssue.comments;
    if (comments.length === 0) continue;

    const lastComment = comments[comments.length - 1];
    // If last comment is NOT from the bot, someone answered
    if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
      console.log(`Issue #${waitingIssue.number} has been answered, resuming...`);
      await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
      await fixIssue(waitingIssue.number, config, cwd);
    }
  }
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const reposFlag = args.find((a) => a.startsWith("--repos"));
  const reposValue = reposFlag ? args[args.indexOf(reposFlag) + 1] : undefined;

  if (reposValue) {
    const repos = reposValue.split(",").map((r) => r.trim());
    for (const repo of repos) {
      const resolvedPath = resolve(repo);
      console.log(`Checking ${resolvedPath}...`);
      await watchRepo(config, resolvedPath);
    }
  } else {
    await watchRepo(config, cwd);
  }
}
```

- [ ] **Step 4: Implement fix-issues command**

Create `src/commands/fix-issues.ts`:

```typescript
import type { Config } from "../lib/config";
import { listIssuesWithLabel, LABELS } from "../lib/github";
import { fixIssue } from "./fix-issue";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const issues = await listIssuesWithLabel(LABELS.autofix, cwd);

  if (issues.length === 0) {
    console.log("No issues labeled 'autofix' found.");
    return;
  }

  console.log(`Found ${issues.length} autofix issue(s).`);

  for (const issue of issues) {
    console.log(`\nFixing issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/commands/watch.test.ts
```

Expected: All tests PASS.

- [ ] **Step 6: Run all tests**

```bash
bun test
```

Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/watch.ts src/commands/fix-issues.ts tests/commands/watch.test.ts
git commit -m "feat: add watch and fix-issues commands for autonomous operation"
```

---

## Task 12: Stub Remaining Commands + Bun Link

**Files:**
- Create: stub files for all remaining commands

Each remaining command gets a minimal stub that prints "not yet implemented" so the CLI doesn't crash on unknown imports. The actual implementations come in Plan 2.

- [ ] **Step 1: Create command stubs**

Create a stub for each unimplemented command. Each file follows this pattern:

`src/commands/review.ts`:
```typescript
import type { Config } from "../lib/config";

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  console.log("'review' command is not yet implemented.");
  console.log("Coming soon in a future update.");
}
```

Create identical stubs (changing the command name in the message) for:
- `src/commands/review.ts`
- `src/commands/audit.ts`
- `src/commands/health.ts`
- `src/commands/implement.ts`
- `src/commands/update-deps.ts`
- `src/commands/migrate.ts`
- `src/commands/refactor.ts`
- `src/commands/explain.ts`
- `src/commands/changelog.ts`
- `src/commands/test-gen.ts`
- `src/commands/verify.ts`
- `src/commands/triage.ts`
- `src/commands/pr-review.ts`

- [ ] **Step 2: Test the full CLI**

```bash
bun run src/cli.ts --help
bun run src/cli.ts review
```

Expected: Help shows all commands. `review` prints "not yet implemented".

- [ ] **Step 3: Link globally**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder
bun link
```

Expected: `flogvit-coder` is now available as a global command.

- [ ] **Step 4: Verify global command works**

```bash
flogvit-coder --help
```

Expected: Shows help text.

- [ ] **Step 5: Commit**

```bash
git add src/commands/
git commit -m "feat: add command stubs and global CLI link"
```

---

## Task 13: Run Full Test Suite and Verify

- [ ] **Step 1: Run all tests**

```bash
cd /Users/vhanssen/WebstormProjects/flogvit/flogvit-coder
bun test
```

Expected: All tests PASS.

- [ ] **Step 2: Run linting (TypeScript check)**

```bash
bunx tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Test end-to-end with help**

```bash
flogvit-coder --help
flogvit-coder init --help 2>&1 || true
flogvit-coder review
```

Expected: Help works, review shows stub message.

- [ ] **Step 4: Final commit if any fixes were needed**

```bash
git add -A
git status
# Only commit if there are changes
git diff --cached --quiet || git commit -m "fix: address issues found during final verification"
```
