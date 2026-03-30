import { $ } from "bun";
import { readFile, stat } from "fs/promises";
import { join, basename } from "path";
import { parse as parseToml } from "@iarna/toml";

export interface RepoContext {
  repoName: string;
  language: string;
  fileStructure: string;
  claudeMd: string | null;
  defaultBranch: string;
  testCommand: string | null;
}

async function detectTestCommand(cwd: string, language: string): Promise<string | null> {
  // Check .flogvit-coder/config.toml for explicit test_command override
  try {
    const raw = await readFile(join(cwd, ".flogvit-coder", "config.toml"), "utf-8");
    const config = parseToml(raw) as { defaults?: { test_command?: string } };
    if (config.defaults?.test_command) return config.defaults.test_command;
  } catch { /* no config */ }

  // Check package.json for a test script
  if (language === "TypeScript/JavaScript") {
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
      if (pkg.scripts?.test) return "npm test";
    } catch { /* no package.json */ }
  }

  const defaults: Record<string, string> = {
    "Rust": "cargo test",
    "Go": "go test ./...",
    "Python": "pytest",
    "Ruby": "bundle exec rspec",
    "Java": "mvn test",
  };
  return defaults[language] ?? null;
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

  const [claudeMd, testCommand] = await Promise.all([
    readFile(join(cwd, "CLAUDE.md"), "utf-8").catch(() => null),
    detectTestCommand(cwd, language),
  ]);

  return { repoName, language, fileStructure, claudeMd, defaultBranch, testCommand };
}
