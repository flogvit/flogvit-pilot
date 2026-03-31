# flogvit-coder

CLI tool that orchestrates AI coding agents to automate software engineering tasks. Point it at a GitHub repo and let it fix issues, review code, generate tests, and more.

## Requirements

- [Bun](https://bun.sh)
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) and/or [Aider](https://aider.chat/) (`aider`)

## Install

```bash
bun install
```

## Usage

```bash
bun run src/cli.ts <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | Set up flogvit-coder in current repo |
| `fix-issue <#>` | Fix a GitHub issue and create PR |
| `fix-issues` | Fix all issues labeled `autofix` |
| `watch` | Check for new work (cron-friendly) |
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
| `verify` | Run tests + lint + Playwright |
| `triage` | Triage and label new issues |
| `pr-review <#>` | Review a pull request |

### Global options

```
--tool <name>    Override AI tool (claude, aider)
--verbose, -v    Show full AI output
--confirm        Ask for confirmation before acting
```

## Configuration

TOML config loaded from `.flogvit-coder/config.toml` (repo) or `~/.flogvit-coder/config.toml` (global).

```toml
[defaults]
tool = "claude"

[tools.claude]
max-turns = 50
model = "claude-sonnet-4-6"
allowed-tools = ["Bash", "Read", "Edit", "Write", "Glob", "Grep"]

[tools.aider]
model = "claude-sonnet-4-6"

[commands.fix-issue]
tool = "claude"
retry_model = "claude-sonnet-4-6"
```

## Development

```bash
bun test          # Run tests
bun run src/cli.ts --help
```
