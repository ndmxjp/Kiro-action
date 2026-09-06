#!/usr/bin/env bun

/**
 * MCP stdio server exposing one tool: post an inline review comment on a line
 * of this pull request's diff.
 *
 * Deliberately narrow, following upstream's github-inline-comment-server: it
 * wraps `pulls.createReviewComment` and nothing else, so the agent gets inline
 * comments without ever being handed the review API, which is what could
 * approve or request changes on a PR.
 *
 * Upstream also buffers comments to a file and classifies them after the run,
 * because its subagents inherit the tool and post probe comments when they hit
 * unrelated errors. This action has no subagents, so the buffering is not
 * ported; the per-run cap in inline-comment.ts is the spam control instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";
import {
  createInlineComment,
  InlineCommentBudget,
  MAX_INLINE_COMMENTS_PER_RUN,
} from "../github/operations/comments/inline-comment";
import { redactAllSecrets, sanitizeContent } from "../github/utils/sanitizer";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_OWNER = process.env.REPO_OWNER;
const REPO_NAME = process.env.REPO_NAME;
const PR_NUMBER = process.env.PR_NUMBER;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  console.error(
    "[GitHub Inline Comment Server] Error: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, and PR_NUMBER environment variables are required",
  );
  process.exit(1);
}

const pullNumber = parseInt(PR_NUMBER, 10);
if (!Number.isInteger(pullNumber) || pullNumber < 1) {
  console.error(
    `[GitHub Inline Comment Server] Error: PR_NUMBER must be a positive integer, got "${PR_NUMBER}"`,
  );
  process.exit(1);
}

const budget = new InlineCommentBudget();

const server = new McpServer({
  name: "GitHub Inline Comment Server",
  version: "0.0.1",
});

server.tool(
  "create_inline_comment",
  `Post a review comment on a specific line, or range of lines, in a file of this pull request. ` +
    `The line must be part of the PR diff (added, removed, or shown as context) or GitHub rejects it. ` +
    `A \`\`\`suggestion block in the body replaces the ENTIRE line range. ` +
    `At most ${MAX_INLINE_COMMENTS_PER_RUN} per run; summarise anything else in the tracking comment.`,
  {
    path: z
      .string()
      .describe("File path relative to the repository root, e.g. src/index.ts"),
    body: z.string().describe("Comment text, GitHub Markdown"),
    line: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Line to comment on; for a range, the last line"),
    startLine: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("First line of a multi-line range (then `line` is the last)"),
    side: z
      .enum(["LEFT", "RIGHT"])
      .default("RIGHT")
      .describe("RIGHT for the new code (default), LEFT for the old code"),
    commit_id: z
      .string()
      .optional()
      .describe("Commit SHA to anchor on; defaults to the PR head"),
  },
  async ({ path, body, line, startLine, side, commit_id }) => {
    try {
      budget.take();

      const octokit = new Octokit({
        auth: GITHUB_TOKEN,
        baseUrl: GITHUB_API_URL,
      });

      const result = await createInlineComment(
        octokit,
        {
          path,
          // Model-authored, and one more channel humans read: same treatment as
          // the tracking comment. Sanitised for hidden-instruction channels the
          // agent may have quoted from untrusted content, then redacted because
          // the agent runs with KIRO_API_KEY in its environment.
          body: redactAllSecrets(sanitizeContent(body)),
          line,
          startLine,
          side,
          commitId: commit_id,
        },
        { owner: REPO_OWNER!, repo: REPO_NAME!, pullNumber },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { ...result, remaining: budget.remaining },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Error: ${errorMessage}` }],
        error: errorMessage,
        isError: true,
      };
    }
  },
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.on("exit", () => {
    server.close();
  });
}

runServer().catch(() => {
  process.exit(1);
});
