import { $ } from "bun";
import type { Config } from "./config";

/**
 * Ask a model to identify which uncommitted files are genuine code changes
 * for a given fix, and stage only those files.
 *
 * This replaces `git add -A` + manual exclusion lists. The model understands
 * context across all languages and tools, so we never need to hardcode paths
 * like .cargo/config.toml, .claude/, .idea/, etc.
 *
 * Falls back to `git add -u` (tracked files only) if the model call fails.
 */
export async function stageRelevantFiles(
  wtPath: string,
  context: { title: string; body?: string },
  config: Config
): Promise<void> {
  const status = await $`git status --porcelain`.cwd(wtPath).nothrow().text();
  if (!status.trim()) return;

  const diff = await $`git diff`.cwd(wtPath).nothrow().text();

  const prompt = `You are helping stage the right files for a git commit.

A coding agent just finished working on: "${context.title}"

Uncommitted changes:
\`\`\`
${status}
\`\`\`

Diff of modified files (truncated):
\`\`\`
${diff.slice(0, 8000)}
\`\`\`

Which files should be staged for this commit? Include only genuine code changes relevant to the task.

Do NOT include:
- Tool/build configs with machine-specific absolute paths (e.g. .cargo/config.toml with target-dir)
- Editor or IDE directories (.claude/, .idea/, .vscode/, .cursor/, etc.)
- OS metadata (.DS_Store, Thumbs.db, etc.)
- Files that are clearly tool-generated infrastructure unrelated to the fix

Respond with ONLY a JSON array of file paths to stage. Example:
["src/foo.ts", "tests/foo.test.ts"]

If there are no files worth staging, respond with: []`;

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  delete env.ANTHROPIC_API_KEY;
  if (config.defaults.fallback_api_key) {
    env.ANTHROPIC_API_KEY = config.defaults.fallback_api_key;
  }

  let filesToStage: string[] | null = null;

  try {
    const result = await $`claude -p ${prompt} --output-format text --allowedTools none --max-turns 1 --model claude-haiku-4-5`
      .env(env)
      .nothrow()
      .text();

    const match = result.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.every((f) => typeof f === "string")) {
        filesToStage = parsed;
      }
    }
  } catch {
    // Model call failed — fall through to fallback
  }

  if (filesToStage === null) {
    // Fallback: only stage changes to already-tracked files (safe across all languages)
    await $`git add -u`.cwd(wtPath).nothrow();
    return;
  }

  for (const file of filesToStage) {
    await $`git add ${file}`.cwd(wtPath).nothrow();
  }
}
