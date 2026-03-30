import { resolve, basename } from "path";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { listIssuesWithLabel, listPRsWithLabel, getIssue, removeLabel, LABELS } from "../lib/github";
import { loadState } from "../lib/state";
import { fixIssue } from "./fix-issue";
import { verifyPR } from "./verify";
import { reviewPR } from "./review-pr";
import { auditPR } from "./audit-pr";
import { run as mergeRun } from "./merge";
import { PIPELINE_STAGES, STAGE_LABELS } from "../lib/pipeline";

export { findAnsweredIssues } from "./watch-helpers";

async function watchCron(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  // 1. Check for new autofix issues
  const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
  const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
  const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

  for (const issue of autofixIssues) {
    if (inProgressNums.has(issue.number)) continue;
    const existingState = await loadState(stateDir, repoName, issue.number);
    if (existingState) continue;
    console.log(`Found new autofix issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd);
  }

  // 2. Check for answered waiting issues
  const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
  for (const waitingIssue of waitingIssues) {
    const fullIssue = await getIssue(waitingIssue.number, cwd);
    const comments = fullIssue.comments;
    if (comments.length === 0) continue;
    const lastComment = comments[comments.length - 1];
    if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
      console.log(`Issue #${waitingIssue.number} has been answered, resuming...`);
      await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
      await fixIssue(waitingIssue.number, config, cwd);
    }
  }

  // 3. Dispatch pipeline stages
  for (const stage of PIPELINE_STAGES) {
    const label = STAGE_LABELS[stage];
    const prs = await listPRsWithLabel(label, cwd);

    for (const pr of prs) {
      // Skip if already in-progress
      if (pr.labels.includes(LABELS.inProgress)) continue;

      console.log(`Dispatching ${stage} for PR #${pr.number}: ${pr.title}`);

      switch (stage) {
        case "verify":
          await verifyPR(pr.number, config, cwd);
          break;
        case "review":
          await reviewPR(pr.number, config, cwd);
          break;
        case "audit":
          await auditPR(pr.number, config, cwd);
          break;
        case "merge":
          await mergeRun([], config, cwd);
          break;
      }
    }
  }
}

// --- Live mode state (module-level so renderUI can access it) ---

interface ActiveJob {
  label: string;
  startedAt: number;
  stage: string;
}

const activeJobs = new Map<string, ActiveJob>();
const recentLogs: string[] = [];
const MAX_LOGS = 8;

function log(jobName: string, msg: string) {
  const time = new Date().toLocaleTimeString("no");
  recentLogs.push(`  ${time}  ${jobName.padEnd(16)}  ${msg}`);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

function renderUI(repoName: string, queue: { stage: string; prTitle: string; prNumber: number }[]) {
  const now = Date.now();
  console.clear();
  console.log(
    `━━━ flogvit-coder · ${repoName} ${"━".repeat(Math.max(0, 50 - repoName.length))}  [${new Date().toLocaleTimeString("no")}]\n`
  );

  if (activeJobs.size > 0) {
    console.log("AKTIVE JOBBER");
    for (const [name, job] of activeJobs) {
      const elapsed = Math.floor((now - job.startedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      console.log(
        `  ● ${name.padEnd(18)} ${job.stage.padEnd(10)} ${String(m).padStart(1)}m${String(s).padStart(2, "0")}s   ${job.label}`
      );
    }
    console.log();
  }

  if (queue.length > 0) {
    console.log("KØ");
    for (const item of queue) {
      console.log(`  → ${item.stage.padEnd(14)} PR #${item.prNumber}   ${item.prTitle}`);
    }
    console.log();
  }

  if (recentLogs.length > 0) {
    console.log("SISTE LOGG");
    for (const entry of recentLogs) console.log(entry);
  }
}

async function watchLive(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  let queue: { stage: string; prTitle: string; prNumber: number }[] = [];
  let running = true;

  const cleanup = () => {
    running = false;
    console.clear();
    console.log("flogvit-coder: shutting down.");
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  // Re-render UI every second
  const uiInterval = setInterval(() => {
    renderUI(repoName, queue);
  }, 1000);

  const poll = async () => {
    if (!running) return;

    try {
      // Collect new autofix issues
      const autofixIssues = await listIssuesWithLabel(LABELS.autofix, cwd);
      const inProgressIssues = await listIssuesWithLabel(LABELS.inProgress, cwd);
      const inProgressNums = new Set(inProgressIssues.map((i) => i.number));

      for (const issue of autofixIssues) {
        if (inProgressNums.has(issue.number)) continue;
        const existingState = await loadState(stateDir, repoName, issue.number);
        if (existingState) continue;
        const jobName = `fix-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "fix" });
        log(jobName, `starting fix for issue #${issue.number}`);
        fixIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Collect waiting issues with answers
      const waitingIssues = await listIssuesWithLabel(LABELS.waiting, cwd);
      for (const waitingIssue of waitingIssues) {
        const fullIssue = await getIssue(waitingIssue.number, cwd);
        const comments = fullIssue.comments;
        if (comments.length === 0) continue;
        const lastComment = comments[comments.length - 1];
        if (!lastComment.body.includes("🤖 **flogvit-coder**")) {
          const jobName = `resume-${waitingIssue.number}`;
          if (activeJobs.has(jobName)) continue;
          activeJobs.set(jobName, { label: waitingIssue.title, startedAt: Date.now(), stage: "fix" });
          log(jobName, `resuming issue #${waitingIssue.number}`);
          (async () => {
            await removeLabel(waitingIssue.number, LABELS.waiting, cwd);
            await fixIssue(waitingIssue.number, config, cwd);
          })().then(() => {
            activeJobs.delete(jobName);
            log(jobName, `done`);
          }).catch((err) => {
            activeJobs.delete(jobName);
            log(jobName, `error: ${String(err).slice(0, 60)}`);
          });
        }
      }

      // Collect pipeline stage work
      const nextQueue: typeof queue = [];
      for (const stage of PIPELINE_STAGES) {
        const label = STAGE_LABELS[stage];
        const prs = await listPRsWithLabel(label, cwd);
        for (const pr of prs) {
          if (pr.labels.includes(LABELS.inProgress)) continue;
          const jobName = `${stage}-${pr.number}`;
          if (activeJobs.has(jobName)) continue;
          nextQueue.push({ stage, prTitle: pr.title, prNumber: pr.number });

          activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage });
          log(jobName, `starting ${stage} for PR #${pr.number}`);

          let stagePromise: Promise<{ success: boolean }> = Promise.resolve({ success: false });
          switch (stage) {
            case "verify":
              stagePromise = verifyPR(pr.number, config, cwd);
              break;
            case "review":
              stagePromise = reviewPR(pr.number, config, cwd);
              break;
            case "audit":
              stagePromise = auditPR(pr.number, config, cwd);
              break;
            case "merge":
              stagePromise = mergeRun([], config, cwd).then(() => ({ success: true }));
              break;
          }
          stagePromise.then(({ success }) => {
            activeJobs.delete(jobName);
            log(jobName, success ? `done` : `done (not advanced)`);
          }).catch((err) => {
            activeJobs.delete(jobName);
            log(jobName, `error: ${String(err).slice(0, 60)}`);
          });
        }
      }
      queue = nextQueue;
    } catch (err) {
      log("poll", `error: ${String(err).slice(0, 80)}`);
    }
  };

  // Poll immediately, then every 15 seconds
  await poll();
  const pollInterval = setInterval(poll, 15_000);

  // Keep alive until SIGINT
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        clearInterval(uiInterval);
        clearInterval(pollInterval);
        resolve();
      }
    }, 500);
  });
}

export async function run(args: string[], config: Config, cwd: string): Promise<void> {
  const live = args.includes("--live");
  const reposFlag = args.find((a) => a.startsWith("--repos"));
  const reposValue = reposFlag ? args[args.indexOf(reposFlag) + 1] : undefined;

  if (reposValue) {
    const repos = reposValue.split(",").map((r) => r.trim());
    for (const repo of repos) {
      const resolvedPath = resolve(repo);
      console.log(`Checking ${resolvedPath}...`);
      if (live) {
        await watchLive(config, resolvedPath);
      } else {
        await watchCron(config, resolvedPath);
      }
    }
  } else {
    if (live) {
      await watchLive(config, cwd);
    } else {
      await watchCron(config, cwd);
    }
  }
}
