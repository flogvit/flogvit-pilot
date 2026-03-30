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
