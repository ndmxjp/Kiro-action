import { checkHumanActor } from "../../github/validation/actor";
import { configureGitAuth } from "../../github/operations/git-config";
import { prepareMcpServers } from "../../mcp/prepare-mcp-config";
import { buildSystemPrompt } from "../../create-prompt";
import type { GitHubContext } from "../../github/context";
import type { Octokits } from "../../github/api/client";
import {
  buildAgentConfig,
  grantedShellCommands,
  writeAgentConfig,
} from "../../kiro/agent-config";
import { writeUserMcpJson } from "../../kiro/mcp-json";
import type { PreparedRun } from "../tag";

/**
 * Prepares an agent-mode run: the automation path, taken whenever the workflow
 * supplies an explicit `prompt`. There is no tracking comment and no branch
 * creation — the workflow decides what the run should do and where it lands.
 */
export async function prepareAgentMode({
  context,
  octokit,
  githubToken,
  hasSkills = false,
}: {
  context: GitHubContext;
  octokit: Octokits;
  githubToken: string;
  /** Whether the `skills` input installed anything. */
  hasSkills?: boolean;
}): Promise<PreparedRun> {
  // Guards against a bot triggering a run that triggers another run.
  await checkHumanActor(octokit.rest, context);

  try {
    await configureGitAuth(githubToken, context, {
      login: context.inputs.botName,
      id: parseInt(context.inputs.botId, 10),
    });
  } catch (error) {
    // Not fatal: a run that only reads the repository does not need git auth.
    console.error("Failed to configure git authentication:", error);
  }

  const defaultBranch = context.repository.default_branch || "main";
  const baseBranch = context.inputs.baseBranch || defaultBranch;
  const currentBranch =
    process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || defaultBranch;

  const mcpServers = await prepareMcpServers({
    githubToken,
    owner: context.repository.owner,
    repo: context.repository.repo,
    // No tracking comment in agent mode, so no comment server.
    kiroCommentId: undefined,
    mode: "agent",
    context,
  });

  if (
    context.inputs.agentEngine === "v3" &&
    Object.keys(mcpServers).length > 0
  ) {
    await writeUserMcpJson(mcpServers);
  }

  const shellCommands = grantedShellCommands(
    context.inputs.allowedShellCommands,
  );

  const agentConfig = buildAgentConfig({
    mode: "agent",
    engine: context.inputs.agentEngine,
    mcpServers,
    extraTools: context.inputs.allowedTools,
    extraShellCommands: context.inputs.allowedShellCommands,
    model: context.inputs.model,
    systemPrompt: buildSystemPrompt("agent", shellCommands, {
      inlineComments: Boolean(mcpServers.github_inline_comment),
    }),
    hasSkills,
  });
  const agentPath = await writeAgentConfig(agentConfig);

  const prompt =
    context.inputs.prompt ||
    `Repository: ${context.repository.owner}/${context.repository.repo}`;

  return {
    commentId: undefined,
    branchInfo: { baseBranch, currentBranch },
    prompt,
    agentPath,
    hasMcpServers: Object.keys(mcpServers).length > 0,
  };
}
