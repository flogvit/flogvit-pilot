# flogvit-coder — Design Spec

## Overview

A CLI tool that orchestrates AI coding agents to autonomously review code, fix issues, implement features, and maintain repositories. Built with Bun, designed to be repo-agnostic and composable in the Unix tradition.

**Core principles:**
- Fully autonomous — communicates via GitHub Issues when it needs human input
- Pluggable AI backends — swap between `claude`, `aider`, or future tools
- Cheap by default — no tokens spent unless there's work to do
- Local execution — full access to local tools (Playwright, test runners, etc.)

## Project Structure

```
flogvit-coder/
  src/
    cli.ts                        # Entry point, command dispatcher
    lib/
      config.ts                   # Global + per-repo config, merged with CLI flags
      tool-runner.ts              # Abstraction over AI tools (claude, aider, etc.)
      github.ts                   # Wrapper around gh CLI
      logger.ts                   # Terminal summary + file-based detailed logs
      template.ts                 # Read .md templates, replace {{variables}}
      state.ts                    # Serialize/restore paused work context
    commands/
      review.ts / review.md       # Code review → GitHub issues
      audit.ts / audit.md         # Security audit → GitHub issues
      health.ts / health.md       # Repo health report → terminal
      fix-issue.ts / fix-issue.md # Fix single issue → branch + PR
      fix-issues.ts               # Fix all autofix-labeled issues (uses fix-issue)
      implement.ts / implement.md # Implement feature issue → branch + PR
      update-deps.ts / update-deps.md   # Update dependencies → branch + PR
      migrate.ts / migrate.md     # Migration → branch + PR
      refactor.ts / refactor.md   # Refactoring → branch + PR
      explain.ts / explain.md     # Architecture overview → terminal/file
      changelog.ts / changelog.md # Changelog from git log → terminal/file
      test-gen.ts / test-gen.md   # Generate tests → branch + PR
      verify.ts / verify.md       # Run tests + lint + Playwright → terminal report
      triage.ts / triage.md       # Triage new issues → labels + comments
      pr-review.ts / pr-review.md # Review PR → review comments
      watch.ts                    # Meta-command: cheap checks, triggers other commands
      init.ts                     # Set up .flogvit-coder/ and labels in a repo
  package.json
```

## CLI Interface

```bash
# Installation
cd flogvit-coder
bun link    # Makes 'flogvit-coder' available globally

# Prerequisites: bun, gh (authenticated), at least one AI tool (claude/aider)

# First run in a repo
cd my-project
flogvit-coder init          # Creates .flogvit-coder/, sets up labels

# Manual usage
flogvit-coder review
flogvit-coder fix-issue 42
flogvit-coder fix-issue 42 --tool aider --verbose
flogvit-coder implement 17
flogvit-coder pr-review 55

# Automated (cron)
flogvit-coder watch         # Check for autofix issues, check waiting issues
flogvit-coder watch --repos ~/projects/culling,~/projects/photo-suite
```

## Configuration

### Hierarchy (lowest to highest priority)

1. Built-in defaults
2. `~/.flogvit-coder/config.toml` — global defaults
3. `.flogvit-coder/config.toml` — per-repo overrides
4. CLI flags — `--tool`, `--model`, `--verbose`, `--confirm`

### Config Example (`~/.flogvit-coder/config.toml`)

```toml
[defaults]
tool = "claude"

[tools.claude]
max-turns = 50
allowed-tools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]

[tools.aider]
model = "claude-sonnet-4-20250514"

[commands.review]
tool = "claude"

[commands.fix-issue]
tool = "aider"
```

### Prompt Hierarchy

1. `src/commands/<command>.md` — built-in default prompt
2. `.flogvit-coder/prompts/<command>.md` — per-repo override

Prompts use `{{variable}}` templating for dynamic content like `{{issue_title}}`, `{{issue_body}}`, `{{repo_context}}`, `{{language}}`.

## Tool Runner Abstraction

```typescript
interface ToolRunner {
  name: string
  run(opts: {
    prompt: string
    cwd: string
    allowedTools?: string[]
    maxTurns?: number
  }): Promise<ToolResult>
}

interface ToolResult {
  success: boolean
  output: string    // Full output (saved to log)
  summary: string   // Short summary (shown in terminal)
}
```

**Implementations:**
- `claude.ts` — runs `claude -p "..." --allowedTools "..." --max-turns N`
- `aider.ts` — runs `aider --message "..." --yes-always --no-git`
- Future tools added as new files implementing the same interface

## Command Lifecycle

Every command follows the same pattern:

1. Parse args and config
2. Gather context (gh issues, git status, file structure, etc.)
3. Read .md template, fill in variables
4. Call tool runner with the composed prompt
5. Parse result
6. Handle output (create issue, create PR, comment, log)

### Example: `flogvit-coder fix-issue 42`

1. Fetch issue #42 via `gh issue view 42 --json title,body,labels,comments`
2. Gather repo context (language, file structure, CLAUDE.md, etc.)
3. Read `fix-issue.md`, replace `{{issue_title}}`, `{{issue_body}}`, `{{repo_context}}`
4. Run claude/aider in the repo directory with the composed prompt
5. Check that changes were made (`git diff`)
6. Create branch `flogvit-coder/fix-42`, commit, push, `gh pr create`
7. Comment on issue with link to PR
8. Log everything to `~/.flogvit-coder/logs/`

## Autonomous Operation & State Preservation

### When the agent gets stuck

1. The agent returns without changes or with an error
2. flogvit-coder serializes state to `~/.flogvit-coder/state/<repo>/<issue-num>.json`:
   - Issue data and comments
   - Which command was running
   - Branch name (if work was started)
   - AI's summary of what it did and what it needs answered
   - Partial code lives on the branch
3. Comments on the issue with the question
4. Adds label `flogvit-coder:waiting`

### When an answer arrives

1. `flogvit-coder watch` sees new comment on a `flogvit-coder:waiting` issue
2. Loads state from `~/.flogvit-coder/state/<repo>/<issue-num>.json`
3. Builds new prompt including: original context + what the agent already did + the answer
4. Checks out the branch if it exists
5. Continues the work

### Comment format on issues

```
🤖 **flogvit-coder** — [status]

[message]
```

## GitHub Integration

### Labels (created automatically by `flogvit-coder init`)

| Label | Purpose |
|-------|---------|
| `autofix` | "flogvit-coder, fix this" — trigger for fix-issue |
| `auto-implement` | Trigger for implement |
| `auto-review` | Trigger for pr-review |
| `flogvit-coder:waiting` | Agent is waiting for human answer |
| `flogvit-coder:in-progress` | Agent is currently working on this |
| `flogvit-coder:failed` | Agent could not fix, needs manual help |

### Branch Convention

- `flogvit-coder/fix-<issue-num>` — for fixes
- `flogvit-coder/impl-<issue-num>` — for implementations
- `flogvit-coder/refactor-<description>` — for refactors without an issue

### PR Format

- Title references issue (`Fix #42: thumbnail cache crash`)
- Body: what the agent did, which files changed, which tests ran
- Auto-labeled with `flogvit-coder`
- Never auto-merged — always requires manual review

## Logging

- **Terminal:** Short summary only (e.g., "Created PR #42 for issue #17")
- **File:** Detailed log to `~/.flogvit-coder/logs/<repo>/<timestamp>-<command>.log`
- `--verbose` flag streams full AI output to terminal

## Watch Mode (Cron)

`flogvit-coder watch` is a meta-command that runs cheap checks (no tokens):

1. `gh issue list --label autofix` → new issues to fix? → run `fix-issue`
2. `gh issue list --label flogvit-coder:waiting` → any answered? → resume work
3. If nothing to do, exit silently

**Cron setup:**
```bash
# Every 10 minutes
*/10 * * * * cd ~/projects/culling && flogvit-coder watch

# Or multiple repos
*/10 * * * * flogvit-coder watch --repos ~/projects/culling,~/projects/photo-suite
```

## Commands Overview

### Analysis & Quality
| Command | Input | Output |
|---------|-------|--------|
| `review` | repo | GitHub issues with findings |
| `audit` | repo | GitHub issues for security problems |
| `health` | repo | Terminal report (coverage, deps, CI, tech debt) |

### Fix & Implement
| Command | Input | Output |
|---------|-------|--------|
| `fix-issue <#>` | issue number | Branch + PR |
| `fix-issues` | all `autofix` issues | Branch + PR per issue |
| `implement <#>` | issue number | Branch + PR |

### Maintenance
| Command | Input | Output |
|---------|-------|--------|
| `update-deps` | repo | Branch + PR with updates |
| `migrate <description>` | free text | Branch + PR |
| `refactor <description>` | free text | Branch + PR |

### Documentation
| Command | Input | Output |
|---------|-------|--------|
| `explain` | repo | Terminal output / file |
| `changelog` | repo (git log) | Terminal output / file |

### Testing
| Command | Input | Output |
|---------|-------|--------|
| `test-gen` | repo | Branch + PR with new tests |
| `verify` | repo | Terminal report (tests, lint, Playwright) |

### Workflow
| Command | Input | Output |
|---------|-------|--------|
| `triage` | new issues | Labels + comments on issues |
| `pr-review <#>` | PR number | Review comments on PR |
| `watch` | — | Cheap checks, triggers other commands |

## Future Considerations (not in v1)

- **Parallel execution** with git worktrees for isolation
- **Queue-based** processing for multiple issues
- **Push-based triggers** via GitHub webhooks or GitHub Actions
- **`flogvit-coder install`** helper to set up prerequisites
- **Cost tracking** per command/repo
