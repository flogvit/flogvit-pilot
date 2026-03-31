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
| `plan-issue <#>` | Generate an implementation plan for a complex issue |
| `fix-issue <#>` | Fix a GitHub issue and create PR (unattended) |
| `fix-issues` | Fix all issues labeled `autofix` |
| `fix-pr <#>` | Fix a PR after review or audit failure (unattended) |
| `verify <#>` | Run tests/lint on a PR → advance to `needs-review` |
| `review-pr <#>` | AI code review of a PR → advance to `needs-audit` |
| `audit-pr <#>` | Security audit of a PR → advance to `approved` |
| `merge` | Merge all approved PRs |

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

### Label state machine

`watch` drives issues and PRs through a pipeline via GitHub labels:

```
Issues:   needs-triage → autofix / needs-plan → [fix-issue] → PR created
                                                               ↓
PRs:      needs-verify → needs-review → needs-audit → approved → merged
```

Labels used (all prefixed `flogvit-pilot:`):

| Label | Meaning |
|-------|---------|
| `needs-triage` | New issue, awaiting evaluation |
| `needs-plan` | Issue needs an implementation plan before fixing |
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

TOML config loaded from `.flogvit-pilot/config.toml` (repo) or `~/.flogvit-pilot/config.toml` (global).

```toml
[defaults]
tool = "claude"
max_concurrent_jobs = 3          # max parallel jobs in watch (default: 3)
fallback_api_key = "sk-ant-..."  # used on rate limit if set

[tools.claude]
max-turns = 50
model = "claude-sonnet-4-6"
allowed-tools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]

[tools.aider]
model = "claude-sonnet-4-6"

[commands.fix-issue]
tool = "claude"
model = "claude-sonnet-4-6"

[commands.triage]
max-turns = 5
```

## Development

```bash
bun test                    # Run tests
flogvit-pilot --help        # Show available commands
```
