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
