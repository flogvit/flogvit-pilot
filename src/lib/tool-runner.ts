export interface ToolRunnerOptions {
  prompt: string;
  cwd: string;
  jobName?: string;
  fallbackApiKey?: string;
  fallbackCommand?: string; // Fallback command to use on rate limit (e.g., "ollama launch claude --model qwen3.5:122b")
  verbose?: boolean;
  model?: string;
  onChunk?: (chunk: string) => void;
  allowedTools?: string[];
  maxTurns?: number;
  command?: string; // Override default command (e.g., "claudeq" instead of "claude")
  rateLimitDelaysMs?: number[]; // Override rate limit retry delays
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
