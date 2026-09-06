import * as core from "@actions/core";
import { checkHumanActor } from "../../github/validation/actor";
import { createInitialComment } from "../../github/operations/comments/create-initial";
import { updateTrackingComment } from "../../github/operations/comments/update-with-branch";
import { setupBranch, type BranchInfo } from "../../github/operations/branch";
import { configureGitAuth } from "../../github/operations/git-config";
import { prepareMcpServers } from "../../mcp/prepare-mcp-config";
import {
  fetchGitHubData,
  resolveTriggerTimestamp,
  extractOriginalTitle,
  extractOriginalBody,
} from "../../github/data/fetcher";
import { buildSystemPrompt, createTagPrompt } from "../../create-prompt";
import { isEntityContext, type GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import {
  buildAgentConfig,
  grantedShellCommands,
  writeAgentConfig,
} from "../../kiro/agent-config";
import { writeUserMcpJson } from "../../kiro/mcp-json";

export type PreparedRun = {
  commentId?: number;
  branchInfo: BranchInfo;
  prompt: string;
  agentPath: string;
  hasMcpServers: boolean;
  /** `Co-authored-by:` trailer for the commit this action makes. */
  coAuthorLine?: string;
};

/**
 * Prepares a tag-mode run: the path taken when a human mentions the trigger
 * phrase, labels an issue, or assigns it. Creates the tracking comment, sets up
 * a branch, and builds the prompt from the issue/PR context.
 */
export async function prepareTagMode({
  context,
  octokit,
  githubToken,
  commitMessageFile,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  /** Where the agent is asked to leave its commit message. */
  commitMessageFile: string;
}): Promise<PreparedRun> {
  if (!isEntityContext(context)) {
    throw new Error("Tag mode requires an issue or pull request context");
  }

  await checkHumanActor(octokit.rest, context);

  const commentData = await createInitialComment(octokit.rest, context);
  const commentId = commentData.id;

  const triggerTime = await resolveTriggerTimestamp(context, octokit);
  const originalTitle = extractOriginalTitle(context);
  const originalBody = extractOriginalBody(context);

  const githubData = await fetchGitHubData({
    octokits: octokit,
    repository: `${context.repository.owner}/${context.repository.repo}`,
    prNumber: context.entityNumber.toString(),
    isPR: context.isPR,
    triggerUsername: context.actor,
    triggerTime,
    originalTitle,
    originalBody,
    includeCommentsByActor: context.inputs.includeCommentsByActor,
    excludeCommentsByActor: context.inputs.excludeCommentsByActor,
  });

  const branchInfo = await setupBranch(octokit, githubData, context);

  await configureGitAuth(githubToken, context, {
    login: context.inputs.botName,
    id: parseInt(context.inputs.botId, 10),
  });

  if (branchInfo.kiroBranch) {
    // Show the branch in the tracking comment right away, so a reader can
    // follow along before anything is pushed.
    try {
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        branchInfo.kiroBranch,
      );
    } catch (error) {
      console.warn("Could not add the branch link to the comment:", error);
    }
  }

  const mcpServers = await prepareMcpServers({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    kiroCommentId: commentId.toString(),
    mode: "tag",
    context,
  });

  // The v3 engine ignores MCP servers declared inside an agent profile, so they
  // have to go through the user-scoped mcp.json instead, which it does read.
  if (context.inputs.agentEngine === "v3") {
    core.warning(
      "agent_engine: v3 is early access. Its MCP support goes through " +
        "~/.kiro/settings/mcp.json rather than the agent profile, and it also " +
        "merges the checkout's .kiro/settings/mcp.json.",
    );
    if (Object.keys(mcpServers).length > 0) {
      await writeUserMcpJson(mcpServers);
    }
  }

  const shellCommands = grantedShellCommands(
    context.inputs.allowedShellCommands,
  );

  const agentConfig = buildAgentConfig({
    mode: "tag",
    engine: context.inputs.agentEngine,
    mcpServers,
    extraTools: context.inputs.allowedTools,
    extraShellCommands: context.inputs.allowedShellCommands,
    model: context.inputs.model,
    systemPrompt: buildSystemPrompt("tag", shellCommands),
  });
  const agentPath = await writeAgentConfig(agentConfig);

  const { prompt, coAuthorLine } = createTagPrompt(
    commentId,
    branchInfo.baseBranch,
    branchInfo.kiroBranch,
    githubData,
    context,
    Boolean(mcpServers.github_ci),
    Boolean(mcpServers.github_inline_comment),
    commitMessageFile,
  );

  return {
    commentId,
    branchInfo,
    prompt,
    agentPath,
    hasMcpServers: Object.keys(mcpServers).length > 0,
    coAuthorLine,
  };
}
