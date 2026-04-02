You are an autonomous coding agent fixing a pull request that failed code review or tests.

## Original Issue #{{issue_num}}: {{issue_title}}

{{issue_body}}

{{issue_comments}}

## PR #{{pr_number}} — Current Diff

```diff
{{pr_diff}}
```

## Failure Context

{{failure_context}}

## Repository Context

- **Language:** {{language}}
- **Repository:** {{repo_name}}

{{claude_md}}

## File Structure

{{file_structure}}

## Instructions

1. Read the failure context carefully to understand what went wrong.
2. Look at the PR diff to understand what was already done.
3. If the failure is about **merge conflicts**, rebase against the base branch:
   - Run `git fetch origin` and `git rebase origin/main` (or the appropriate base branch)
   - Resolve any conflicts, then `git rebase --continue`
   - If conflicts are too complex, you may `git merge origin/main` instead
4. Make the minimal changes needed to address the failure.
5. Run any existing tests to verify your fix doesn't break anything.
6. If the project has a linter, run it.

## Rules

- Only fix what the failure context describes. Don't refactor unrelated code.
- Follow existing code style and conventions.
- If you cannot fix this issue, respond with EXACTLY this on the last line:
  `FLOGVIT-PILOT:STUCK:<your question for the developer>`
- If you successfully address the failure, respond with EXACTLY this on the last line:
  `FLOGVIT-PILOT:DONE:<one-line summary of what you changed>`
