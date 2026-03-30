import { mkdir, appendFile } from "fs/promises";
import { join } from "path";

export interface LoggerOptions {
  logDir: string;
  repoName: string;
  command: string;
  verbose: boolean;
}

export class Logger {
  private logFile: string;
  private summaries: string[] = [];
  private buffer: string[] = [];
  private options: LoggerOptions;

  constructor(options: LoggerOptions) {
    this.options = options;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logFile = join(
      options.logDir,
      options.repoName,
      `${timestamp}-${options.command}.log`
    );
  }

  summary(message: string): void {
    this.summaries.push(message);
    console.log(message);
  }

  detail(message: string): void {
    this.buffer.push(message);
    if (this.options.verbose) {
      console.log(message);
    }
  }

  error(message: string): void {
    this.buffer.push(`[ERROR] ${message}`);
    console.error(message);
  }

  getSummaries(): string[] {
    return [...this.summaries];
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const dir = join(
      this.options.logDir,
      this.options.repoName
    );
    await mkdir(dir, { recursive: true });
    await appendFile(this.logFile, this.buffer.join("\n") + "\n");
    this.buffer = [];
  }
}
