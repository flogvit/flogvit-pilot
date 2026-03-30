import { resolve, basename } from "path";
import { homedir } from "os";
import type { Config } from "../lib/config";
import { listOpenIssues, listOpenPRs, getIssue, removeLabel, addLabel, addPRLabel, removePRLabel, LABELS } from "../lib/github";
import { loadState, saveState } from "../lib/state";
import { triageIssue } from "./triage";
import { planIssue } from "./plan-issue";
import { fixPR, parsePRIssueNumber } from "./fix-pr";
import { fixIssue } from "./fix-issue";
import { verifyPR } from "./verify";
import { reviewPR } from "./review-pr";
import { auditPR } from "./audit-pr";
import { run as mergeRun } from "./merge";
import { PIPELINE_STAGES, STAGE_LABELS } from "../lib/pipeline";
import { findAnsweredIssues } from "./watch-helpers";

export { findAnsweredIssues } from "./watch-helpers";

async function watchCron(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-coder", "state");

  // Fetch all open issues and PRs in two calls — filter locally
  const allOpenIssues = await listOpenIssues(cwd);
  const allOpenPRs = await listOpenPRs(cwd);

  const byLabel = (label: string) => allOpenIssues.filter((i) => i.labels.includes(label));
  const prsByLabel = (label: string) => allOpenPRs.filter((pr) => pr.labels.includes(label));
  const inProgressNums = new Set(byLabel(LABELS.inProgress).map((i) => i.number));

  // 1. Detect unlabeled issues → set needs-triage
  for (const issue of allOpenIssues) {
    if (issue.labels.includes(LABELS.ignore)) continue;
    if (issue.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX) || ALL_KNOWN_LABELS.has(l as never))) continue;
    console.log(`Found unlabeled issue #${issue.number}: ${issue.title} → needs-triage`);
    await addLabel(issue.number, LABELS.needsTriage, cwd);
  }

  // 2. Detect unlabeled PRs → set needs-verify
  for (const pr of allOpenPRs) {
    if (pr.labels.includes(LABELS.ignore)) continue;
    if (pr.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX))) continue;
    console.log(`Found unlabeled PR #${pr.number}: ${pr.title} → needs-verify`);
    await addPRLabel(pr.number, LABELS.needsVerify, cwd);
  }

  // 3. Dispatch triage for needs-triage issues
  for (const issue of byLabel(LABELS.needsTriage)) {
    if (inProgressNums.has(issue.number)) continue;
    console.log(`Triaging issue #${issue.number}: ${issue.title}`);
    await triageIssue(issue.number, config, cwd);
  }

  // 4. Dispatch plan-issue for needs-plan issues
  for (const issue of byLabel(LABELS.needsPlan)) {
    if (inProgressNums.has(issue.number)) continue;
    console.log(`Planning issue #${issue.number}: ${issue.title}`);
    await planIssue(issue.number, config, cwd);
  }

  // 5. Dispatch fix for autofix issues (and retry stuck ones)
  for (const issue of byLabel(LABELS.autofix)) {
    if (inProgressNums.has(issue.number)) continue;
    const existingState = await loadState(stateDir, repoName, issue.number);

    let retryModel: string | undefined;
    if (existingState) {
      if (existingState.command === "triage") {
        // Leftover triage state — proceed normally
      } else if (existingState.command === "fix-issue") {
        const attempts = existingState.fixAttempts ?? 0;
        if (attempts >= 3 || !issue.labels.includes(LABELS.waiting)) continue;
        retryModel = "opus";
        console.log(`Retrying stuck fix for issue #${issue.number} (attempt ${attempts + 1})`);
        await removeLabel(issue.number, LABELS.waiting, cwd);
      } else {
        continue;
      }
    }

    console.log(`${retryModel ? "Re-fixing" : "Fixing"} issue #${issue.number}: ${issue.title}`);
    await fixIssue(issue.number, config, cwd, false, retryModel);
  }

  // 6. Check for answered waiting issues → set needs-triage
  const waitingIssues = byLabel(LABELS.waiting);
  const waitingWithComments = await Promise.all(waitingIssues.map((i) => getIssue(i.number, cwd)));
  const answeredNums = findAnsweredIssues(waitingWithComments, "🤖 **flogvit-coder**");
  for (const num of answeredNums) {
    console.log(`Issue #${num} has been answered, setting needs-triage...`);
    await removeLabel(num, LABELS.waiting, cwd);
    await addLabel(num, LABELS.needsTriage, cwd);
  }

  // 7. Retry changes-requested and failed PRs with fix-pr
  const retryPRs = allOpenPRs.filter((pr) =>
    pr.labels.includes(LABELS.changesRequested) || pr.labels.includes(LABELS.failed)
  );
  for (const pr of retryPRs) {
    if (pr.labels.includes(LABELS.inProgress)) continue;
    if (pr.labels.includes(LABELS.approved)) continue;
    const issueNum = parsePRIssueNumber(pr.body);
    if (!issueNum) continue;
    const state = await loadState(stateDir, repoName, issueNum);
    const prFixAttempts = state?.prFixAttempts ?? 0;
    if (prFixAttempts >= 3) {
      console.log(`PR #${pr.number}: prFixAttempts exhausted, skipping`);
      continue;
    }
    const model = prFixAttempts >= 1 ? "opus" : undefined;
    console.log(`Fixing PR #${pr.number} (attempt ${prFixAttempts + 1})`);
    await fixPR(pr.number, config, cwd, false, model);
  }

  // 8. Dispatch pipeline stages
  for (const stage of PIPELINE_STAGES) {
    for (const pr of prsByLabel(STAGE_LABELS[stage])) {
      if (pr.labels.includes(LABELS.inProgress)) continue;
      console.log(`Dispatching ${stage} for PR #${pr.number}: ${pr.title}`);
      switch (stage) {
        case "verify": await verifyPR(pr.number, config, cwd); break;
        case "review": await reviewPR(pr.number, config, cwd); break;
        case "audit": await auditPR(pr.number, config, cwd); break;
        case "merge": await mergeRun([], config, cwd); break;
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

const FLOGVIT_CODER_PREFIX = "flogvit-coder:";
const ALL_KNOWN_LABELS = new Set(Object.values(LABELS));

// Cache of last-seen updatedAt per waiting issue — avoids fetching full issue on every poll
const issueLastUpdated = new Map<number, string>();

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
      // Fetch all open issues and PRs in two calls — filter locally
      const allOpenIssues = await listOpenIssues(cwd);
      const allOpenPRs = await listOpenPRs(cwd);

      const byLabel = (label: string) => allOpenIssues.filter((i) => i.labels.includes(label));
      const prsByLabel = (label: string) => allOpenPRs.filter((pr) => pr.labels.includes(label));
      const inProgressNums = new Set(byLabel(LABELS.inProgress).map((i) => i.number));

      // Detect unlabeled issues → set needs-triage
      for (const issue of allOpenIssues) {
        if (issue.labels.includes(LABELS.ignore)) continue;
        if (issue.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX) || ALL_KNOWN_LABELS.has(l as never))) continue;
        await addLabel(issue.number, LABELS.needsTriage, cwd);
        log(`issue-${issue.number}`, `unlabeled → needs-triage`);
      }

      // Detect unlabeled PRs → set needs-verify
      for (const pr of allOpenPRs) {
        if (pr.labels.includes(LABELS.ignore)) continue;
        if (pr.labels.some((l) => l.startsWith(FLOGVIT_CODER_PREFIX))) continue;
        await addPRLabel(pr.number, LABELS.needsVerify, cwd);
        log(`pr-${pr.number}`, `unlabeled PR → needs-verify`);
      }

      // Dispatch triage for needs-triage issues
      for (const issue of byLabel(LABELS.needsTriage)) {
        if (inProgressNums.has(issue.number)) continue;
        const jobName = `triage-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "triage" });
        log(jobName, `triaging issue #${issue.number}`);
        triageIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Dispatch plan-issue for needs-plan issues
      for (const issue of byLabel(LABELS.needsPlan)) {
        if (inProgressNums.has(issue.number)) continue;
        const jobName = `plan-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "plan" });
        log(jobName, `planning issue #${issue.number}`);
        planIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Dispatch fix for autofix issues (and retry stuck ones)
      for (const issue of byLabel(LABELS.autofix)) {
        if (inProgressNums.has(issue.number)) continue;
        const existingState = await loadState(stateDir, repoName, issue.number);
        const jobName = `fix-${issue.number}`;
        if (activeJobs.has(jobName)) continue;

        let retryModel: string | undefined;
        if (existingState) {
          if (existingState.command === "triage") {
            // Leftover triage state — proceed normally
          } else if (existingState.command === "fix-issue") {
            const attempts = existingState.fixAttempts ?? 0;
            if (attempts >= 3 || !issue.labels.includes(LABELS.waiting)) continue;
            retryModel = "opus";
            log(jobName, `retry stuck fix (attempt ${attempts + 1})`);
            await removeLabel(issue.number, LABELS.waiting, cwd);
          } else {
            continue;
          }
        }

        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "fix" });
        log(jobName, retryModel ? `retrying fix for issue #${issue.number}` : `starting fix for issue #${issue.number}`);
        fixIssue(issue.number, config, cwd, false, retryModel).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Check waiting issues for human replies — only fetch full data for updated ones
      const waitingIssues = byLabel(LABELS.waiting);
      const updatedWaiting = waitingIssues.filter((i) => issueLastUpdated.get(i.number) !== i.updatedAt);
      for (const i of waitingIssues) issueLastUpdated.set(i.number, i.updatedAt);
      for (const num of issueLastUpdated.keys()) {
        if (!waitingIssues.some((i) => i.number === num)) issueLastUpdated.delete(num);
      }
      const waitingWithComments = await Promise.all(updatedWaiting.map((i) => getIssue(i.number, cwd)));
      const answeredNums = findAnsweredIssues(waitingWithComments, "🤖 **flogvit-coder**");
      for (const num of answeredNums) {
        const waitingIssue = waitingIssues.find((i) => i.number === num)!;
        const jobName = `retriage-${num}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: waitingIssue.title, startedAt: Date.now(), stage: "triage" });
        log(jobName, `re-triaging answered issue #${num}`);
        (async () => {
          await removeLabel(num, LABELS.waiting, cwd);
          await addLabel(num, LABELS.needsTriage, cwd);
        })().then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Retry changes-requested and failed PRs
      const retryPRs = allOpenPRs.filter((pr) =>
        pr.labels.includes(LABELS.changesRequested) || pr.labels.includes(LABELS.failed)
      );
      for (const pr of retryPRs) {
        if (pr.labels.includes(LABELS.inProgress)) continue;
        if (pr.labels.includes(LABELS.approved)) continue;
        const issueNum = parsePRIssueNumber(pr.body);
        if (!issueNum) continue;
        const state = await loadState(stateDir, repoName, issueNum);
        const prFixAttempts = state?.prFixAttempts ?? 0;
        if (prFixAttempts >= 3) {
          log(`fix-pr-${pr.number}`, `prFixAttempts exhausted, skipping`);
          continue;
        }
        const jobName = `fix-pr-${pr.number}`;
        if (activeJobs.has(jobName)) continue;
        const model = prFixAttempts >= 1 ? "opus" : undefined;
        activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage: "fix-pr" });
        log(jobName, `fixing PR #${pr.number} (attempt ${prFixAttempts + 1})`);
        fixPR(pr.number, config, cwd, false, model).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => {
          activeJobs.delete(jobName);
          log(jobName, `error: ${String(err).slice(0, 60)}`);
        });
      }

      // Dispatch pipeline stages
      const nextQueue: typeof queue = [];
      for (const stage of PIPELINE_STAGES) {
        for (const pr of prsByLabel(STAGE_LABELS[stage])) {
          if (pr.labels.includes(LABELS.inProgress)) continue;
          const jobName = `${stage}-${pr.number}`;
          if (activeJobs.has(jobName)) continue;
          nextQueue.push({ stage, prTitle: pr.title, prNumber: pr.number });
          activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage });
          log(jobName, `starting ${stage} for PR #${pr.number}`);
          let stagePromise: Promise<{ success: boolean }> = Promise.resolve({ success: false });
          switch (stage) {
            case "verify": stagePromise = verifyPR(pr.number, config, cwd); break;
            case "review": stagePromise = reviewPR(pr.number, config, cwd); break;
            case "audit": stagePromise = auditPR(pr.number, config, cwd); break;
            case "merge": stagePromise = mergeRun([], config, cwd).then(() => ({ success: true })); break;
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

  // On startup, remove orphaned in-progress labels (no active jobs in this session)
  const startupIssues = await listOpenIssues(cwd);
  const startupPRs = await listOpenPRs(cwd);
  for (const issue of startupIssues) {
    if (issue.labels.includes(LABELS.inProgress)) {
      log(`startup`, `removing orphaned in-progress from issue #${issue.number}`);
      await removeLabel(issue.number, LABELS.inProgress, cwd).catch(() => {});
    }
  }
  for (const pr of startupPRs) {
    if (pr.labels.includes(LABELS.inProgress)) {
      log(`startup`, `removing orphaned in-progress from PR #${pr.number}`);
      await removePRLabel(pr.number, LABELS.inProgress, cwd).catch(() => {});
    }
  }

  // Poll immediately, then every 60 seconds
  await poll();
  const pollInterval = setInterval(poll, 60_000);

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
