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
