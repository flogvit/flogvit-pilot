// src/commands/watch-helpers.ts
export function findAnsweredIssues(
  issues: { number: number; comments: { author: string; body: string; createdAt: string }[] }[],
  botIdentifier: string
): number[] {
  const answered: number[] = [];
  for (const issue of issues) {
    if (issue.comments.length === 0) continue;
    const lastComment = issue.comments[issue.comments.length - 1];
    if (!lastComment.body.includes(botIdentifier)) {
      answered.push(issue.number);
    }
  }
  return answered;
}
