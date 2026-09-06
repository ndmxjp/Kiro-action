import type { Octokit } from "@octokit/rest";

/**
 * How many inline comments one run may post. The tracking comment is a single
 * body the agent rewrites, so it cannot grow without bound; inline comments can,
 * and on a public repository a prompt injection that turns the agent into a
 * comment spammer is a plausible attack. The cap makes the worst case a nuisance
 * rather than a flood. Upstream (claude-code-action) has no cap, which is a
 * deliberate departure.
 */
export const MAX_INLINE_COMMENTS_PER_RUN = 20;

export type InlineCommentInput = {
  path: string;
  body: string;
  /** Line to anchor on, or the end of a multi-line range. */
  line?: number;
  /** Start of a multi-line range; `line` is then the end. */
  startLine?: number;
  side: "LEFT" | "RIGHT";
  commitId?: string;
};

export type ReviewCommentParams = {
  owner: string;
  repo: string;
  pull_number: number;
  commit_id: string;
  path: string;
  body: string;
  side: "LEFT" | "RIGHT";
  line: number;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
};

/**
 * Shapes the request for `pulls.createReviewComment`, and rejects what the API
 * would reject with a less legible error. The line checks matter because the
 * API's own response to a bad anchor is a bare "Validation Failed", which tells
 * the agent nothing about which of its numbers was wrong.
 */
export function buildReviewCommentParams(
  input: InlineCommentInput,
  target: { owner: string; repo: string; pullNumber: number; headSha: string },
): ReviewCommentParams {
  const { path, body, line, startLine, side, commitId } = input;

  if (!path.trim()) {
    throw new Error("path is required");
  }
  if (!body.trim()) {
    throw new Error("body is empty after sanitisation");
  }
  if (line === undefined && startLine === undefined) {
    throw new Error("Provide line (single line) or startLine and line (range)");
  }

  // A range needs both ends; a lone startLine is treated as a single line so a
  // model that reached for the wrong parameter still gets a comment out.
  const end = line ?? startLine!;
  if (!Number.isInteger(end) || end < 1) {
    throw new Error(`line must be a positive integer, got ${end}`);
  }

  const params: ReviewCommentParams = {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    commit_id: commitId || target.headSha,
    path,
    body,
    side,
    line: end,
  };

  if (startLine !== undefined && line !== undefined && startLine !== line) {
    if (!Number.isInteger(startLine) || startLine < 1) {
      throw new Error(`startLine must be a positive integer, got ${startLine}`);
    }
    if (startLine > line) {
      throw new Error(
        `startLine (${startLine}) must not be after line (${line})`,
      );
    }
    params.start_line = startLine;
    params.start_side = side;
  }

  return params;
}

/**
 * Counts what this run has posted, so the cap is enforced before the API call
 * rather than discovered as a mysterious refusal afterwards.
 */
export class InlineCommentBudget {
  private used = 0;

  constructor(private readonly limit = MAX_INLINE_COMMENTS_PER_RUN) {}

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Throws when the next comment would exceed the cap. */
  take(): void {
    if (this.used >= this.limit) {
      throw new Error(
        `This run has already posted ${this.limit} inline comments, which is the limit. ` +
          "Put anything further in the tracking comment instead.",
      );
    }
    this.used += 1;
  }
}

export type CreateInlineCommentResult = {
  id: number;
  html_url: string;
  path: string;
  line: number;
  start_line?: number;
};

/**
 * Resolves the PR head when no commit was named, then posts the comment.
 *
 * Only `createReviewComment` is used — never `createReview`. A review can carry
 * an APPROVE or REQUEST_CHANGES event, and keeping that API out of reach is what
 * stops the agent from approving a pull request, which the prompt promises it
 * cannot do.
 */
export async function createInlineComment(
  octokit: Octokit,
  input: InlineCommentInput,
  target: { owner: string; repo: string; pullNumber: number },
): Promise<CreateInlineCommentResult> {
  let headSha = input.commitId;
  if (!headSha) {
    const pr = await octokit.rest.pulls.get({
      owner: target.owner,
      repo: target.repo,
      pull_number: target.pullNumber,
    });
    headSha = pr.data.head.sha;
  }

  const params = buildReviewCommentParams(input, { ...target, headSha });

  try {
    const response = await octokit.rest.pulls.createReviewComment(params);
    return {
      id: response.data.id,
      html_url: response.data.html_url,
      path: response.data.path,
      line: response.data.line ?? params.line,
      start_line: response.data.start_line ?? undefined,
    };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);
    if (status === 422) {
      // The API's wording for a bad anchor. Say what it usually means, since the
      // agent's only recourse is to pick a line that is actually in the diff.
      throw new Error(
        `${message}. A 422 here almost always means the line is not part of this ` +
          `pull request's diff for ${params.path} (side ${params.side}), or the path is wrong. ` +
          "Only lines the diff adds, removes, or shows as context can carry a comment.",
      );
    }
    throw error;
  }
}
