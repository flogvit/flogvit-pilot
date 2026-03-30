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
