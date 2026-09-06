import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { GITHUB_API_URL } from "../github/api/config";
import { isEntityContext, type GitHubContext } from "../github/context";
import type { AutoDetectedMode } from "../modes/detector";

export type McpServerConfig = {
  command: string;
  args: string[];
  env?: Record<string, string>;
};

export type McpServers = Record<string, McpServerConfig>;

type PrepareConfigParams = {
  githubToken: string;
  owner: string;
  repo: string;
  kiroCommentId?: string;
  mode: AutoDetectedMode;
  context: GitHubContext;
};

/**
 * Builds the bun invocation for one of this action's own MCP servers. The flags
 * mirror the entrypoint invocation in action.yml so the server process reads its
 * runtime config from the action directory rather than from the (untrusted)
 * working directory.
 */
function bunServerArgs(scriptPath: string): string[] {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  return [
    "--no-env-file",
    `--config=${actionPath}/bunfig.toml`,
    "run",
    `${actionPath}/${scriptPath}`,
  ];
}

function bunCommand(): string {
  return process.env.PATH_TO_BUN_EXECUTABLE || "bun";
}

async function checkActionsReadPermission(
  token: string,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    const client = new Octokit({ auth: token, baseUrl: GITHUB_API_URL });

    // Listing workflow runs requires `actions: read`; per_page=1 keeps it cheap.
    await client.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 1 });

    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message;

    if (status === 403 && message?.includes("Resource not accessible")) {
      return false;
    }

    // Network or other transient errors: log, but treat the server as
    // unavailable rather than failing the run.
    core.debug(`Failed to check actions permission: ${message}`);
    return false;
  }
}

/**
 * Assembles the MCP servers this action provides. Unlike the upstream Claude
 * action there is no `--mcp-config` flag on the Kiro CLI, so the result is
 * embedded in the generated agent config (see src/kiro/agent-config.ts).
 */
export async function prepareMcpServers(
  params: PrepareConfigParams,
): Promise<McpServers> {
  const { githubToken, owner, repo, kiroCommentId, mode, context } = params;

  const servers: McpServers = {};

  // The comment server is what makes progress visible, so it is installed
  // whenever there is a tracking comment to update (tag mode).
  if (kiroCommentId) {
    servers.github_comment = {
      command: bunCommand(),
      args: bunServerArgs("src/mcp/github-comment-server.ts"),
      env: {
        GITHUB_TOKEN: githubToken,
        REPO_OWNER: owner,
        REPO_NAME: repo,
        KIRO_COMMENT_ID: kiroCommentId,
        GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME || "",
        GITHUB_API_URL,
      },
    };
  }

  // Inline review comments are opt-in and only make sense on a pull request,
  // in either mode: a tag-mode review summarises into the tracking comment, an
  // agent-mode review (examples/kiro-review.yml) into its final answer. The
  // server wraps exactly one API call (createReviewComment), so the agent never
  // sees the review API that could approve or request changes. Same token as the
  // comment server: posting a review comment needs `pull-requests: write`, which
  // the action already requires.
  if (
    isEntityContext(context) &&
    context.isPR &&
    context.inputs.useInlineComments
  ) {
    servers.github_inline_comment = {
      command: bunCommand(),
      args: bunServerArgs("src/mcp/github-inline-comment-server.ts"),
      env: {
        GITHUB_TOKEN: githubToken,
        REPO_OWNER: owner,
        REPO_NAME: repo,
        PR_NUMBER: context.entityNumber.toString(),
        GITHUB_API_URL,
      },
    };
  }

  // The CI server needs `actions: read`, which the workflow token carries only
  // when the workflow asks for it. It is only useful on a pull request.
  const workflowToken = process.env.DEFAULT_WORKFLOW_TOKEN;
  const wantsCiServer =
    mode === "tag" && isEntityContext(context) && context.isPR;

  if (wantsCiServer && workflowToken) {
    if (await checkActionsReadPermission(workflowToken, owner, repo)) {
      servers.github_ci = {
        command: bunCommand(),
        args: bunServerArgs("src/mcp/github-actions-server.ts"),
        env: {
          // Deliberately the workflow token, not an app token: this is the
          // identity whose `actions: read` scope was just verified.
          GITHUB_TOKEN: workflowToken,
          REPO_OWNER: owner,
          REPO_NAME: repo,
          PR_NUMBER: context.entityNumber?.toString() || "",
          RUNNER_TEMP: process.env.RUNNER_TEMP || "/tmp",
        },
      };
    } else {
      core.warning(
        "The github_ci MCP server requires 'actions: read' permission. " +
          "Skipping it. To enable CI status checks, add 'actions: read' to your workflow permissions. " +
          "See: https://docs.github.com/en/actions/security-guides/automatic-token-authentication#permissions-for-the-github_token",
      );
    }
  }

  return servers;
}
