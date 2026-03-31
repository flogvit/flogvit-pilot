import type { ToolRunner, ToolRunnerOptions, ToolResult } from "../tool-runner";
import { registerTool } from "../tool-runner";

const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /too many requests/i,
  /usage.?limit/i,
  /quota.?exceeded/i,
];

const RATE_LIMIT_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000, 20 * 60_000];

function isRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(text));
}

/**
 * Try to extract the suggested wait time from a rate limit message.
 * Claude CLI may output e.g. "try again in 47 minutes" or "resets at 14:32".
 * Returns milliseconds to wait, or null if no time found.
 *
 * NOTE: The exact format of Claude CLI rate limit messages is not documented.
 * This function should be updated once the actual output is observed in the wild.
 * Check the rate_limit raw output logged to stderr to improve the parser.
 */
function parseRateLimitDelay(text: string): number | null {
  const seconds = text.match(/try again in (\d+)\s*second/i);
  if (seconds) return parseInt(seconds[1]) * 1000;

  const minutes = text.match(/try again in (\d+)\s*minute/i);
  if (minutes) return parseInt(minutes[1]) * 60_000;

  const hours = text.match(/try again in (\d+)\s*hour/i);
  if (hours) return parseInt(hours[1]) * 3_600_000;

  const resetsAt = text.match(/resets? at (\d{1,2}):(\d{2})/i);
  if (resetsAt) {
    const now = new Date();
    const target = new Date();
    target.setHours(parseInt(resetsAt[1]), parseInt(resetsAt[2]), 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime() - now.getTime();
  }

  return null;
}

export class ClaudeRunner implements ToolRunner {
  name = "claude";

  buildArgs(opts: ToolRunnerOptions): (string | number)[] {
    const args: (string | number)[] = ["-p", opts.prompt, "--output-format", "text"];

    if (opts.maxTurns) {
      args.push("--max-turns", opts.maxTurns);
    }

    if (opts.allowedTools !== undefined) {
      if (opts.allowedTools.length > 0) {
        args.push("--allowedTools", opts.allowedTools.join(","));
      } else {
        // Empty array means no tools allowed
        args.push("--allowedTools", "none");
      }
    }

    if (opts.jobName) {
      args.push("--name", opts.jobName);
    }

    if (opts.model) {
      args.push("--model", opts.model);
    }

    return args;
  }

  async run(opts: ToolRunnerOptions): Promise<ToolResult> {
    const args = this.buildArgs(opts);

    // Always strip ANTHROPIC_API_KEY so flogvit-coder agents use Max subscription.
    // If fallbackApiKey is set in config, it will be added on rate limit retry.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    delete env.ANTHROPIC_API_KEY;

    for (let attempt = 0; attempt <= RATE_LIMIT_RETRY_DELAYS_MS.length; attempt++) {
      try {
        const proc = Bun.spawn(["claude", ...args.map(String)], {
          cwd: opts.cwd,
          stdout: "pipe",
          stderr: "pipe",
          env,
        });

        // Stream stdout live when verbose, while still collecting it for parsing
        const chunks: Buffer[] = [];
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          if (opts.verbose) process.stderr.write(value);
          opts.onChunk?.(decoder.decode(value));
        }
        const output = Buffer.concat(chunks).toString("utf-8");
        const stderr = await new Response(proc.stderr).text();
        const exitCode = await proc.exited;
        const combined = `${output}\n${stderr}`;

        if (exitCode !== 0 && isRateLimited(combined)) {
          // Log full raw output so we can inspect the exact format and improve parseRateLimitDelay
          console.error("[claude] Rate limit hit. Raw stdout:", output.trim());
          console.error("[claude] Rate limit hit. Raw stderr:", stderr.trim());

          if (opts.fallbackApiKey && attempt === 0) {
            console.error("[claude] Max rate limited. Retrying immediately with fallback API key...");
            env.ANTHROPIC_API_KEY = opts.fallbackApiKey;
            continue;
          }

          const parsed = parseRateLimitDelay(combined);
          const delayMs = parsed ?? RATE_LIMIT_RETRY_DELAYS_MS[attempt];
          if (delayMs === undefined) {
            return {
              success: false,
              output: combined,
              summary: "Rate limit hit — all retries exhausted",
            };
          }

          const delayMin = Math.ceil(delayMs / 60_000);
          if (parsed) {
            console.error(`[claude] Rate limited. Sleeping ${delayMin}m (wait time parsed from Claude output).`);
          } else {
            console.error(
              `[claude] Rate limited. Could not parse wait time from output — using fallback delay of ${delayMin}m` +
              ` (attempt ${attempt + 1}/${RATE_LIMIT_RETRY_DELAYS_MS.length}). Check raw output above to improve parser.`
            );
          }
          await Bun.sleep(delayMs);
          continue;
        }

        if (exitCode !== 0) {
          return {
            success: false,
            output: combined,
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

    return { success: false, output: "", summary: "Unexpected exit from retry loop" };
  }
}

registerTool(new ClaudeRunner());
