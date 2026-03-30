export interface ToolRunnerOptions {
  prompt: string;
  cwd: string;
  jobName?: string;
  fallbackApiKey?: string;
  verbose?: boolean;
  allowedTools?: string[];
  maxTurns?: number;
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
