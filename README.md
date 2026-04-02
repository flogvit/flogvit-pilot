# flogvit-pilot

CLI tool that orchestrates AI coding agents to automate software engineering tasks. Point it at a GitHub repo and let it fix issues, review code, generate tests, and more.

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) and/or [Aider](https://aider.chat/) (`aider`)

## Install

```bash
bun install
bun link
```

## Usage

```bash
flogvit-pilot <command> [options]
```

### Commands

#### Automation (run via `watch` or manually)

| Command | Description |
|---------|-------------|
| `init` | Set up flogvit-pilot in current repo |
| `watch` | Autonomous dispatch loop — picks up labeled issues and PRs |
| `triage <#>` | Evaluate an issue and assign action label |
| `split-issue <#>` | Split a broad issue into focused sub-issues, or route to plan/autofix (opus) |
| `plan-issue <#>` | Generate an implementation plan for a complex issue |
| `fix-issue <#>` | Fix a GitHub issue and create PR (unattended) |
| `fix-issues` | Fix all issues labeled `autofix` |
| `fix-pr <#>` | Fix a PR after review or audit failure (unattended) |
| `verify <#>` | Run tests/lint on a PR → advance to `needs-review` |
| `review-pr <#>` | AI code review of a PR → advance to `needs-audit` |
| `audit-pr <#>` | Security audit of a PR → advance to `approved` |
| `merge` | Merge all approved PRs |
| `add-issue <title> [body]` | Create a GitHub issue with optional label flags |
| `import-plan <file>` | Import a plan file as GitHub issues under a milestone |
| `develop` | One-shot supervisor: scan error logs and take action |
| `kickoff <desc>` | Plan a full project → milestones + issues from a description |

#### Interactive

| Command | Description |
|---------|-------------|
| `work <#>` | Interactive Claude Code session on an issue or existing PR |
| `tail [#]` | Live-stream output of a running background job |

#### One-off tasks

| Command | Description |
|---------|-------------|
| `review` | Code review → GitHub issues |
| `audit` | Security audit → GitHub issues |
| `health` | Repo health report |
| `implement <#>` | Implement a feature issue |
| `update-deps` | Update dependencies |
| `migrate <desc>` | Run a migration |
| `refactor <desc>` | Refactor code |
| `explain` | Generate architecture overview |
| `changelog` | Generate changelog |
| `test-gen` | Generate missing tests |
| `pr-review <#>` | Review a pull request |

### `watch` flags

```
--live               Run continuously (poll every 60s) instead of a single cron pass
--supervisor         Monitor error logs after each poll and take GitHub actions automatically
--self-improve       Like --supervisor, but also fixes flogvit-pilot source when bugs are found
--jobs <n>           Override max concurrent jobs (default: config max_concurrent_jobs or 3)
--repos <paths>      Comma-separated list of repo paths to watch
```

### `add-issue` flags

```bash
flogvit-pilot add-issue "Title" "Optional body" [--autofix] [--label <name>]
```

Adds `needs-triage` if no label is given.

### `import-plan` flags

```bash
flogvit-pilot import-plan <plan-file> [--autofix] [--dry-run]
```

Parses `### Task N:` sections from a Markdown plan file, creates a GitHub milestone from the `# Title`, and opens one issue per task. With `--autofix` each issue gets the `autofix` label; otherwise `needs-triage`.

### Interactive workflow

`work` detects automatically whether an issue already has an open PR and adapts accordingly:

```bash
flogvit-pilot work 18   # No PR yet → creates branch, opens Claude, creates PR when done
flogvit-pilot work 18   # PR exists → checks out existing branch, opens Claude, pushes when done
```

`tail` streams the output of a running background job:

```bash
flogvit-pilot tail      # List all active jobs
flogvit-pilot tail 18   # Stream output of the job working on issue #18
```

### `kickoff`

Takes a high-level project description, analyses the codebase, and creates a phased plan with GitHub milestones and issues:

```bash
# Manual mode — creates issues with needs-triage, you review before starting
flogvit-pilot kickoff "Build a REST API with user auth, CRUD endpoints, and rate limiting"

# Auto mode — creates issues with autofix, watch picks them up immediately
flogvit-pilot kickoff --auto "Add dark mode support with system preference detection"
```

The AI will:
1. Analyse the repo and understand existing patterns
2. Generate a phased plan with milestones
3. Self-review the plan for gaps and ordering issues
4. Create a parent tracking issue, milestones, and sub-issues with proper dependencies

### Milestones

`kickoff` and `import-plan` create GitHub milestones to group related issues into phases. Milestones provide progress tracking in GitHub — you can see completion percentage per phase.

Issues within a milestone can have `Depends-On: #N` to control execution order. Cross-milestone dependencies are implicit: all issues in phase N+1 wait for phase N to complete.

### Label state machine

`watch` drives issues and PRs through a pipeline via GitHub labels:

```
Issues:   needs-triage → autofix → [fix-issue] → PR created
                       → needs-split → [split-issue] → sub-issues (autofix) or needs-plan
                                                                    ↓
                                       needs-plan → [plan-issue] → sub-issues (autofix)
                                                                    ↓
PRs:      needs-verify → needs-review → needs-audit → approved → merged
```

Labels used (all prefixed `flogvit-pilot:`):

| Label | Meaning |
|-------|---------|
| `needs-triage` | New issue, awaiting evaluation |
| `needs-split` | Issue may be too broad — split-issue will decide |
| `needs-plan` | Too complex to split simply — needs a full implementation plan |
| `autofix` | Ready to be fixed automatically |
| `in-progress` | Job currently running |
| `waiting` | Blocked — waiting for human input |
| `blocked` | Depends on another open issue |
| `ignore` | Skip this issue or PR entirely |
| `needs-verify` | PR needs test/lint run |
| `needs-review` | PR needs AI code review |
| `needs-audit` | PR needs security audit |
| `approved` | PR approved, ready to merge |

### Global options

```
--tool <name>    Override AI tool (claude, aider)
--verbose, -v    Show full AI output
--confirm        Ask for confirmation before acting
```

## Configuration

TOML config loaded from `.flogvit-pilot/config.toml` (repo) or `~/.flogvit-pilot/config.toml` (global). A default global config is created automatically on first run.

```toml
[defaults]
tool = "claude"
max_concurrent_jobs = 3
# fallback_api_key = "sk-ant-..."  # used on rate limit if set

[tools.claude]
model = "claude-opus-4-6[1m]"
max-turns = 50
allowed-tools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]

# Per-command overrides
[commands.triage]
max_turns = 5

[commands.plan-issue]
max_turns = 20

# Watch / live mode settings
[watch]
poll_interval_s = 60           # seconds between polls
supervisor_cooldown_s = 300    # seconds between supervisor runs
max_fix_attempts = 3           # max retries for fix-issue
max_pr_fix_attempts = 3        # max retries for fix-pr
# retry_model = "opus"         # model override for retries (default: use tools.claude.model)

# Rate limit retry delays (minutes)
[rate_limit]
retry_delays_m = [5, 10, 20]
```

## Development

```bash
bun test                    # Run tests
flogvit-pilot --help        # Show available commands
```
