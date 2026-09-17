export type GitHubDecision = { ok: true; note: string } | { ok: false; message: string };

export declare function decideGitHubMerge(pr: string, query?: (args: string[]) => unknown): GitHubDecision;
