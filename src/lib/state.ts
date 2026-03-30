import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { join } from "path";

export interface WorkState {
  issueNumber: number;
  command: string;
  branch: string | null;
  agentSummary: string;
  question: string | null;
  issueData: {
    title: string;
    body: string;
  };
  createdAt: string;
  // Triage and retry loop prevention (all optional for backward compatibility)
  triageCount?: number;
  fixAttempts?: number;
  prFixAttempts?: number;
  planGenerated?: boolean;
  planFile?: string;
}

function statePath(stateDir: string, repoName: string, issueNum: number): string {
  return join(stateDir, repoName, `${issueNum}.json`);
}

export async function saveState(
  stateDir: string,
  repoName: string,
  issueNum: number,
  state: WorkState
): Promise<void> {
  const dir = join(stateDir, repoName);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath(stateDir, repoName, issueNum), JSON.stringify(state, null, 2));
}

export async function loadState(
  stateDir: string,
  repoName: string,
  issueNum: number
): Promise<WorkState | null> {
  try {
    const content = await readFile(statePath(stateDir, repoName, issueNum), "utf-8");
    return JSON.parse(content) as WorkState;
  } catch {
    return null;
  }
}

export async function clearState(
  stateDir: string,
  repoName: string,
  issueNum: number
): Promise<void> {
  try {
    await unlink(statePath(stateDir, repoName, issueNum));
  } catch {
    // Already gone
  }
}
