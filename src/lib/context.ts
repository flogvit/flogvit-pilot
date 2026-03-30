import { $ } from "bun";
import { readFile, stat } from "fs/promises";
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
