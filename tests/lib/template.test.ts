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
    tempDir = await mkdtemp(join(tmpdir(), "flogvit-pilot-tpl-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  test("loads repo override when present", async () => {
    const repoPromptDir = join(tempDir, "repo", ".flogvit-pilot", "prompts");
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
