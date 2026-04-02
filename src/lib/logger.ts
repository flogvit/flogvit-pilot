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
  private dirReady: Promise<void>;
  private flushInFlight: Promise<void> = Promise.resolve();

  constructor(options: LoggerOptions) {
    this.options = options;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(options.logDir, options.repoName);
    this.logFile = join(dir, `${timestamp}-${options.command}.log`);
    this.dirReady = mkdir(dir, { recursive: true }).then(() => {});
  }

  summary(message: string): void {
    this.summaries.push(message);
    this.buffer.push(message);
    console.log(message);
    this.scheduleFlush();
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
    this.scheduleFlush();
  }

  getSummaries(): string[] {
    return [...this.summaries];
  }

  getLogFile(): string {
    return this.logFile;
  }

  /** Fire-and-forget flush — errors are swallowed so callers don't need to await. */
  private scheduleFlush(): void {
    this.flushInFlight = this.flushInFlight.then(() => this.drainBuffer()).catch(() => {});
  }

  private async drainBuffer(): Promise<void> {
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    await this.dirReady;
    await appendFile(this.logFile, lines.join("\n") + "\n");
  }

  async flush(): Promise<void> {
    // Wait for any scheduled flush, then drain whatever is left
    await this.flushInFlight;
    await this.drainBuffer();
  }
}
