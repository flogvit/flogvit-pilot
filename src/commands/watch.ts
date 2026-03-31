import { $ } from "bun";
import { resolve, basename } from "path";
import { homedir } from "os";
import { readdir, rm } from "fs/promises";
import type { Config } from "../lib/config";
import { resolveToolForCommand } from "../lib/config";
import { listOpenIssues, listOpenPRs, getIssue, removeLabel, addLabel, addPRLabel, removePRLabel, parseDependsOn, LABELS } from "../lib/github";
import { loadState, saveState } from "../lib/state";
import { triageIssue } from "./triage";
import { planIssue } from "./plan-issue";
import { fixPR, parsePRIssueNumber } from "./fix-pr";
import { fixIssue } from "./fix-issue";
import { verifyPR } from "./verify";
import { reviewPR } from "./review-pr";
import { auditPR } from "./audit-pr";
import { run as mergeRun } from "./merge";
import { worktreesBaseDir } from "../lib/worktree";
import { PIPELINE_STAGES, STAGE_LABELS } from "../lib/pipeline";
import { findAnsweredIssues } from "./watch-helpers";
import { scanNewErrorLogs, runSupervisor, findSourceRoot } from "./develop";

export { findAnsweredIssues } from "./watch-helpers";

function checkDeps(body: string, openNums: Set<number>): number[] {
  return parseDependsOn(body).filter((n) => openNums.has(n));
}

/**
 * Priority score for issue-based jobs — lower = higher priority.
 * Triage is exempt from the concurrency cap and is not scored here.
 */
function issuePriority(labels: string[]): number {
  let score = 100;
  if (labels.includes("priority:high")) score -= 30;
  else if (labels.includes("priority:medium")) score -= 20;
  else if (labels.includes("priority:low")) score -= 10;
  if (labels.includes("bug")) score -= 20;
  else if (labels.includes("enhancement")) score -= 10;
  return score;
}

function sortByPriority<T extends { labels: string[] }>(items: T[]): T[] {
  return [...items].sort((a, b) => issuePriority(a.labels) - issuePriority(b.labels));
}

async function watchCron(config: Config, cwd: string): Promise<void> {
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");

  // Fetch all open issues and PRs in two calls — filter locally
  const allOpenIssues = await listOpenIssues(cwd);
  const allOpenPRs = await listOpenPRs(cwd);

  const byLabel = (label: string) => allOpenIssues.filter((i) => i.labels.includes(label) && !i.labels.includes(LABELS.ignore));
  const prsByLabel = (label: string) => allOpenPRs.filter((pr) => pr.labels.includes(label) && !pr.labels.includes(LABELS.ignore));
  const inProgressNums = new Set(byLabel(LABELS.inProgress).map((i) => i.number));
  const openIssueNums = new Set(allOpenIssues.map((i) => i.number));

  // 1. Detect unlabeled issues → set needs-triage
  for (const issue of allOpenIssues) {
    if (issue.labels.includes(LABELS.ignore)) continue;
    if (issue.labels.some((l) => hasOurPrefix(l) || ALL_KNOWN_LABELS.has(l as never))) continue;
    console.log(`Found unlabeled issue #${issue.number}: ${issue.title} → needs-triage`);
    await addLabel(issue.number, LABELS.needsTriage, cwd);
  }

  // 2. Detect unlabeled PRs → set needs-verify
  for (const pr of allOpenPRs) {
    if (pr.labels.includes(LABELS.ignore)) continue;
    if (pr.labels.some((l) => hasOurPrefix(l))) continue;
    console.log(`Found unlabeled PR #${pr.number}: ${pr.title} → needs-verify`);
    await addPRLabel(pr.number, LABELS.needsVerify, cwd);
  }

  // 3. Dispatch triage for needs-triage issues
  for (const issue of byLabel(LABELS.needsTriage)) {
    if (inProgressNums.has(issue.number)) continue;
    const blockedBy = checkDeps(issue.body, openIssueNums);
    if (blockedBy.length > 0) {
      if (!issue.labels.includes(LABELS.blocked)) {
        await addLabel(issue.number, LABELS.blocked, cwd);
        console.log(`Issue #${issue.number} blocked by #${blockedBy.join(", #")}`);
      }
      continue;
    }
    if (issue.labels.includes(LABELS.blocked)) {
      await removeLabel(issue.number, LABELS.blocked, cwd);
      console.log(`Issue #${issue.number} unblocked`);
    }
    console.log(`Triaging issue #${issue.number}: ${issue.title}`);
    await triageIssue(issue.number, config, cwd);
  }

  // 4. Dispatch plan-issue for needs-plan issues
  for (const issue of byLabel(LABELS.needsPlan)) {
    if (inProgressNums.has(issue.number)) continue;
    const blockedBy = checkDeps(issue.body, openIssueNums);
    if (blockedBy.length > 0) {
      if (!issue.labels.includes(LABELS.blocked)) {
        await addLabel(issue.number, LABELS.blocked, cwd);
        console.log(`Issue #${issue.number} blocked by #${blockedBy.join(", #")}`);
      }
      continue;
    }
    if (issue.labels.includes(LABELS.blocked)) {
      await removeLabel(issue.number, LABELS.blocked, cwd);
    }
    console.log(`Planning issue #${issue.number}: ${issue.title}`);
    await planIssue(issue.number, config, cwd);
  }

  // 5. Dispatch fix for autofix issues (and retry stuck ones)
  for (const issue of byLabel(LABELS.autofix)) {
    if (inProgressNums.has(issue.number)) continue;
    const blockedBy = checkDeps(issue.body, openIssueNums);
    if (blockedBy.length > 0) {
      if (!issue.labels.includes(LABELS.blocked)) {
        await addLabel(issue.number, LABELS.blocked, cwd);
        console.log(`Issue #${issue.number} blocked by #${blockedBy.join(", #")}`);
      }
      continue;
    }
    if (issue.labels.includes(LABELS.blocked)) {
      await removeLabel(issue.number, LABELS.blocked, cwd);
    }
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

  // 6. Check for answered waiting issues → set needs-triage (reset triageCount so hard limit doesn't block)
  const waitingIssues = byLabel(LABELS.waiting);
  const waitingWithComments = await Promise.all(waitingIssues.map((i) => getIssue(i.number, cwd)));
  const answeredNums = findAnsweredIssues(waitingWithComments, ["🤖 **flogvit-pilot**", "🤖 **flogvit-coder**"]);
  for (const num of answeredNums) {
    console.log(`Issue #${num} has been answered, setting needs-triage...`);
    const existingState = await loadState(stateDir, repoName, num);
    if (existingState) {
      await saveState(stateDir, repoName, num, { ...existingState, triageCount: 0 });
    }
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
  model: string;
}

/** Shorten a full model name to a display token, e.g. "claude-opus-4-5" → "opus" */
function shortModel(model: string | undefined): string {
  if (!model) return "sonnet";
  if (model.includes("opus")) return "opus";
  if (model.includes("haiku")) return "haiku";
  if (model.includes("sonnet")) return "sonnet";
  return model.split("-").pop() ?? model;
}

/** Resolve the effective model for a command, with an optional override (e.g. retry model). */
function jobModel(config: Config, command: string, override?: string): string {
  if (override) return shortModel(override);
  const toolName = resolveToolForCommand(config, command);
  const model = config.tools[toolName]?.model as string | undefined;
  return shortModel(model);
}

const FLOGVIT_LABEL_PREFIXES = ["flogvit-pilot:", "flogvit-coder:"];
const hasOurPrefix = (l: string) => FLOGVIT_LABEL_PREFIXES.some((p) => l.startsWith(p));
const ALL_KNOWN_LABELS = new Set(Object.values(LABELS));

// Cache of last-seen updatedAt per waiting issue — avoids fetching full issue on every poll
const issueLastUpdated = new Map<number, string>();

const activeJobs = new Map<string, ActiveJob>();
const recentLogs: string[] = [];
const MAX_LOGS = 8;

interface SupervisorStatus {
  enabled: boolean;
  selfImprove: boolean;
  lastScanAt: number | null;
  lastSummary: string | null;
  running: boolean;
  cooldownUntil: number;
}
const supervisorStatus: SupervisorStatus = {
  enabled: false,
  selfImprove: false,
  lastScanAt: null,
  lastSummary: null,
  running: false,
  cooldownUntil: 0,
};

function log(jobName: string, msg: string) {
  const time = new Date().toLocaleTimeString("no");
  recentLogs.push(`  ${time}  ${jobName.padEnd(16)}  ${msg}`);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

function renderUI(repoName: string, queue: { stage: string; title: string; number: number; kind: "issue" | "pr" }[]) {
  const now = Date.now();
  console.clear();
  console.log(
    `━━━ flogvit-pilot · ${repoName} ${"━".repeat(Math.max(0, 50 - repoName.length))}  [${new Date().toLocaleTimeString("no")}]\n`
  );

  if (activeJobs.size > 0) {
    console.log("ACTIVE JOBS");
    for (const [name, job] of activeJobs) {
      const elapsed = Math.floor((now - job.startedAt) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      console.log(
        `  ● ${name.padEnd(18)} ${job.stage.padEnd(10)} ${String(m).padStart(1)}m${String(s).padStart(2, "0")}s   ${job.model.padEnd(7)}  ${job.label}`
      );
    }
    console.log();
  }

  if (queue.length > 0) {
    const shown = Math.min(queue.length, 10);
    const header = queue.length > 10 ? `QUEUE  (${shown} of ${queue.length})` : `QUEUE  (${queue.length})`;
    console.log(header);
    for (const item of queue.slice(0, shown)) {
      const ref = `${item.kind === "pr" ? "PR" : "  "} #${String(item.number).padEnd(4)}`;
      console.log(`  → ${item.stage.padEnd(12)} ${ref}  ${item.title}`);
    }
    console.log();
  }

  if (supervisorStatus.enabled) {
    const mode = supervisorStatus.selfImprove ? "supervisor + self-improve" : "supervisor";
    const state = supervisorStatus.running
      ? "● running"
      : supervisorStatus.lastScanAt
      ? `✓ last scan ${Math.floor((now - supervisorStatus.lastScanAt) / 1000)}s ago`
      : "  waiting for first poll";
    const summary = supervisorStatus.lastSummary ? `  ${supervisorStatus.lastSummary}` : "";
    console.log(`SUPERVISOR  [${mode}]`);
    console.log(`  ${state}${summary}`);
    console.log();
  }

  if (recentLogs.length > 0) {
    console.log("RECENT LOG");
    for (const entry of recentLogs) console.log(entry);
  }
}

async function watchLive(config: Config, cwd: string, opts: {
  supervisor: boolean;
  selfImprove: boolean;
  maxJobsOverride?: number;
}): Promise<void> {
  const { supervisor, selfImprove, maxJobsOverride } = opts;
  const repoName = basename(cwd);
  const homeDir = process.env.HOME ?? homedir();
  const stateDir = resolve(homeDir, ".flogvit-pilot", "state");

  let queue: { stage: string; title: string; number: number; kind: "issue" | "pr" }[] = [];
  let running = true;
  // Look back 1 hour on first scan to catch errors that predate this watch session
  let lastLogScanTime = Date.now() - 60 * 60 * 1000;
  let lastSupervisorCompletedAt = 0;
  const SUPERVISOR_COOLDOWN_MS = 5 * 60 * 1000; // don't re-run within 5 minutes of last completion

  // Resolve source root once for self-improve
  const sourceRoot = selfImprove ? (await findSourceRoot() ?? undefined) : undefined;
  if (selfImprove && !sourceRoot) {
    log("startup", "warning: --self-improve requires bun link install of flogvit-pilot");
  }

  // Initialize supervisor status for UI
  supervisorStatus.enabled = supervisor || selfImprove;
  supervisorStatus.selfImprove = selfImprove;
  supervisorStatus.running = false;
  supervisorStatus.lastScanAt = null;
  supervisorStatus.lastSummary = null;

  function onJobError(jobName: string, err: unknown) {
    const msg = String(err);
    activeJobs.delete(jobName);
    log(jobName, `error: ${msg.slice(0, 60)}`);
  }

  const cleanup = () => {
    running = false;
    console.clear();
    console.log("flogvit-pilot: shutting down.");
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

    const pollStart = Date.now();

    try {
      // Fetch all open issues and PRs in two calls — filter locally
      const allOpenIssues = await listOpenIssues(cwd);
      const allOpenPRs = await listOpenPRs(cwd);

      const byLabel = (label: string) => allOpenIssues.filter((i) => i.labels.includes(label) && !i.labels.includes(LABELS.ignore));
      const prsByLabel = (label: string) => allOpenPRs.filter((pr) => pr.labels.includes(label) && !pr.labels.includes(LABELS.ignore));
      const inProgressNums = new Set(byLabel(LABELS.inProgress).map((i) => i.number));
      const openIssueNums = new Set(allOpenIssues.map((i) => i.number));

      // Detect unlabeled issues → set needs-triage
      for (const issue of allOpenIssues) {
        if (issue.labels.includes(LABELS.ignore)) continue;
        if (issue.labels.some((l) => hasOurPrefix(l) || ALL_KNOWN_LABELS.has(l as never))) continue;
        await addLabel(issue.number, LABELS.needsTriage, cwd);
        log(`issue-${issue.number}`, `unlabeled → needs-triage`);
      }

      // Detect unlabeled PRs → set needs-verify
      for (const pr of allOpenPRs) {
        if (pr.labels.includes(LABELS.ignore)) continue;
        if (pr.labels.some((l) => hasOurPrefix(l))) continue;
        await addPRLabel(pr.number, LABELS.needsVerify, cwd);
        log(`pr-${pr.number}`, `unlabeled PR → needs-verify`);
      }

      const maxJobs = maxJobsOverride ?? config.defaults.max_concurrent_jobs ?? 3;

      // TRIAGE — exempt from cap: determines priority of everything else
      for (const issue of byLabel(LABELS.needsTriage)) {
        if (inProgressNums.has(issue.number)) continue;
        const blockedBy = checkDeps(issue.body, openIssueNums);
        if (blockedBy.length > 0) {
          if (!issue.labels.includes(LABELS.blocked)) {
            await addLabel(issue.number, LABELS.blocked, cwd);
            log(`issue-${issue.number}`, `blocked by #${blockedBy.join(", #")}`);
          }
          continue;
        }
        if (issue.labels.includes(LABELS.blocked)) {
          await removeLabel(issue.number, LABELS.blocked, cwd);
          log(`issue-${issue.number}`, `unblocked`);
        }
        const jobName = `triage-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "triage", model: jobModel(config, "triage") });
        log(jobName, `triaging issue #${issue.number}`);
        triageIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => onJobError(jobName, err));
      }

      // Check waiting issues for human replies — exempt from cap, just resets label
      const waitingIssues = byLabel(LABELS.waiting);
      const updatedWaiting = waitingIssues.filter((i) => issueLastUpdated.get(i.number) !== i.updatedAt);
      for (const i of waitingIssues) issueLastUpdated.set(i.number, i.updatedAt);
      for (const num of issueLastUpdated.keys()) {
        if (!waitingIssues.some((i) => i.number === num)) issueLastUpdated.delete(num);
      }
      const waitingWithComments = await Promise.all(updatedWaiting.map((i) => getIssue(i.number, cwd)));
      const answeredNums = findAnsweredIssues(waitingWithComments, ["🤖 **flogvit-pilot**", "🤖 **flogvit-coder**"]);
      for (const num of answeredNums) {
        const waitingIssue = waitingIssues.find((i) => i.number === num)!;
        const jobName = `retriage-${num}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: waitingIssue.title, startedAt: Date.now(), stage: "triage", model: jobModel(config, "triage") });
        log(jobName, `re-triaging answered issue #${num}`);
        (async () => {
          const existingState = await loadState(stateDir, repoName, num);
          if (existingState) {
            await saveState(stateDir, repoName, num, { ...existingState, triageCount: 0 });
          }
          await removeLabel(num, LABELS.waiting, cwd);
          await addLabel(num, LABELS.needsTriage, cwd);
        })().then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => onJobError(jobName, err));
      }

      // PIPELINE STAGES — highest priority among capped jobs (near completion)
      for (const stage of PIPELINE_STAGES) {
        for (const pr of prsByLabel(STAGE_LABELS[stage])) {
          if (activeJobs.size >= maxJobs) break;
          if (pr.labels.includes(LABELS.inProgress)) continue;
          const jobName = `${stage}-${pr.number}`;
          if (activeJobs.has(jobName)) continue;
          activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage, model: jobModel(config, stage) });
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
          }).catch((err) => onJobError(jobName, err));
        }
      }

      // FIX-PR — second priority: changes-requested PRs already in flight
      const retryPRs = allOpenPRs.filter((pr) =>
        pr.labels.includes(LABELS.changesRequested) || pr.labels.includes(LABELS.failed)
      );
      for (const pr of retryPRs) {
        if (activeJobs.size >= maxJobs) break;
        if (pr.labels.includes(LABELS.inProgress)) continue;
        if (pr.labels.includes(LABELS.approved)) continue;
        const issueNum = parsePRIssueNumber(pr.body);
        if (!issueNum) continue;
        const state = await loadState(stateDir, repoName, issueNum);
        const prFixAttempts = state?.prFixAttempts ?? 0;
        if (prFixAttempts >= 3) {
          // Escalate to human — remove failure labels and add waiting
          log(`fix-pr-${pr.number}`, `fix-pr exhausted after ${prFixAttempts} attempts — escalating`);
          await removePRLabel(pr.number, LABELS.changesRequested, cwd).catch(() => {});
          await removePRLabel(pr.number, LABELS.failed, cwd).catch(() => {});
          await addPRLabel(pr.number, LABELS.waiting, cwd).catch(() => {});
          continue;
        }
        const jobName = `fix-pr-${pr.number}`;
        if (activeJobs.has(jobName)) continue;
        const model = prFixAttempts >= 1 ? "opus" : undefined;
        activeJobs.set(jobName, { label: pr.title, startedAt: Date.now(), stage: "fix-pr", model: jobModel(config, "fix-pr", model) });
        log(jobName, `fixing PR #${pr.number} (attempt ${prFixAttempts + 1})`);
        fixPR(pr.number, config, cwd, false, model).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => onJobError(jobName, err));
      }

      // PLAN + FIX — sorted by issue priority (bug > enhancement, high > medium > low)
      for (const issue of sortByPriority(byLabel(LABELS.needsPlan))) {
        if (activeJobs.size >= maxJobs) break;
        if (inProgressNums.has(issue.number)) continue;
        const blockedBy = checkDeps(issue.body, openIssueNums);
        if (blockedBy.length > 0) {
          if (!issue.labels.includes(LABELS.blocked)) {
            await addLabel(issue.number, LABELS.blocked, cwd);
            log(`issue-${issue.number}`, `blocked by #${blockedBy.join(", #")}`);
          }
          continue;
        }
        if (issue.labels.includes(LABELS.blocked)) {
          await removeLabel(issue.number, LABELS.blocked, cwd);
          log(`issue-${issue.number}`, `unblocked`);
        }
        const jobName = `plan-${issue.number}`;
        if (activeJobs.has(jobName)) continue;
        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "plan", model: jobModel(config, "plan-issue") });
        log(jobName, `planning issue #${issue.number}`);
        planIssue(issue.number, config, cwd).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => onJobError(jobName, err));
      }

      for (const issue of sortByPriority(byLabel(LABELS.autofix))) {
        if (activeJobs.size >= maxJobs) break;
        if (inProgressNums.has(issue.number)) continue;
        const blockedBy = checkDeps(issue.body, openIssueNums);
        if (blockedBy.length > 0) {
          if (!issue.labels.includes(LABELS.blocked)) {
            await addLabel(issue.number, LABELS.blocked, cwd);
            log(`issue-${issue.number}`, `blocked by #${blockedBy.join(", #")}`);
          }
          continue;
        }
        if (issue.labels.includes(LABELS.blocked)) {
          await removeLabel(issue.number, LABELS.blocked, cwd);
          log(`issue-${issue.number}`, `unblocked`);
        }
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

        activeJobs.set(jobName, { label: issue.title, startedAt: Date.now(), stage: "fix", model: jobModel(config, "fix-issue", retryModel) });
        log(jobName, retryModel ? `retrying fix for issue #${issue.number}` : `starting fix for issue #${issue.number}`);
        fixIssue(issue.number, config, cwd, false, retryModel).then(() => {
          activeJobs.delete(jobName);
          log(jobName, `done`);
        }).catch((err) => onJobError(jobName, err));
      }

      // Rebuild queue: everything pending that isn't already running (capped at 50 for perf)
      const pendingQueue: typeof queue = [];
      for (const stage of PIPELINE_STAGES) {
        for (const pr of prsByLabel(STAGE_LABELS[stage])) {
          if (pr.labels.includes(LABELS.inProgress)) continue;
          if (!activeJobs.has(`${stage}-${pr.number}`)) {
            pendingQueue.push({ stage, title: pr.title, number: pr.number, kind: "pr" });
          }
        }
      }
      for (const pr of allOpenPRs.filter((p) => p.labels.includes(LABELS.changesRequested) || p.labels.includes(LABELS.failed))) {
        if (!pr.labels.includes(LABELS.inProgress) && !pr.labels.includes(LABELS.approved) && !activeJobs.has(`fix-pr-${pr.number}`)) {
          pendingQueue.push({ stage: "fix-pr", title: pr.title, number: pr.number, kind: "pr" });
        }
      }
      for (const issue of sortByPriority(byLabel(LABELS.needsPlan))) {
        if (!inProgressNums.has(issue.number) && !issue.labels.includes(LABELS.blocked) && !activeJobs.has(`plan-${issue.number}`)) {
          pendingQueue.push({ stage: "plan", title: issue.title, number: issue.number, kind: "issue" });
        }
      }
      for (const issue of sortByPriority(byLabel(LABELS.autofix))) {
        if (!inProgressNums.has(issue.number) && !issue.labels.includes(LABELS.blocked) && !activeJobs.has(`fix-${issue.number}`)) {
          pendingQueue.push({ stage: "fix", title: issue.title, number: issue.number, kind: "issue" });
        }
      }
      queue = pendingQueue.slice(0, 50);
    } catch (err) {
      log("poll", `error: ${String(err).slice(0, 80)}`);
    }

    // Supervisor: scan new error logs after each poll cycle
    if ((supervisor || selfImprove) && !supervisorStatus.running) {
      const cooldownRemaining = SUPERVISOR_COOLDOWN_MS - (pollStart - lastSupervisorCompletedAt);
      const since = lastLogScanTime;
      lastLogScanTime = pollStart;
      supervisorStatus.lastScanAt = pollStart;

      if (cooldownRemaining <= 0) {
        const errors = await scanNewErrorLogs(since).catch(() => []);
        if (errors.length > 0) {
          supervisorStatus.running = true;
          activeJobs.set("supervisor", { label: `${errors.length} error(s) in logs`, startedAt: Date.now(), stage: "supervisor", model: "haiku" });
          log("supervisor", `found ${errors.length} new error log(s)`);
          runSupervisor({ targetCwd: cwd, errors, config, selfImprove, sourceRoot }).then(({ summary }) => {
            activeJobs.delete("supervisor");
            supervisorStatus.running = false;
            supervisorStatus.lastSummary = summary;
            lastSupervisorCompletedAt = Date.now();
            log("supervisor", summary);
          }).catch((err) => {
            activeJobs.delete("supervisor");
            supervisorStatus.running = false;
            supervisorStatus.lastSummary = `error: ${String(err).slice(0, 50)}`;
            lastSupervisorCompletedAt = Date.now();
            log("supervisor", `error: ${String(err).slice(0, 60)}`);
          });
        }
      }
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

  // On startup, remove all stale worktrees (no jobs are running yet)
  const wtBase = worktreesBaseDir(homeDir, repoName);
  try {
    const entries = await readdir(wtBase);
    for (const entry of entries) {
      const wtPath = resolve(wtBase, entry);
      log(`startup`, `removing stale worktree ${entry}`);
      await $`git worktree remove ${wtPath} --force`.cwd(cwd).nothrow();
      await rm(wtPath, { recursive: true, force: true }).catch(() => {});
    }
    if (entries.length > 0) {
      await $`git worktree prune`.cwd(cwd).nothrow();
    }
  } catch {
    // worktrees dir doesn't exist yet — that's fine
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

  // --supervisor: monitor logs after every poll and take GitHub actions
  const supervisor = args.includes("--supervisor");

  // --self-improve: addon to --supervisor that also fixes flogvit-pilot source
  const selfImprove = args.includes("--self-improve");

  // --jobs N — override max concurrent jobs (overrides config default)
  const jobsIndex = args.indexOf("--jobs");
  const maxJobsOverride = jobsIndex !== -1 ? parseInt(args[jobsIndex + 1], 10) : undefined;

  const liveOpts = { supervisor: supervisor || selfImprove, selfImprove, maxJobsOverride };

  if (reposValue) {
    const repos = reposValue.split(",").map((r) => r.trim());
    for (const repo of repos) {
      const resolvedPath = resolve(repo);
      console.log(`Checking ${resolvedPath}...`);
      if (live) {
        await watchLive(config, resolvedPath, liveOpts);
      } else {
        await watchCron(config, resolvedPath);
      }
    }
  } else {
    if (live) {
      await watchLive(config, cwd, liveOpts);
    } else {
      await watchCron(config, cwd);
    }
  }
}
