#!/usr/bin/env bun

import * as core from "@actions/core";
import { readFile } from "fs/promises";
import { parse as parseShellArgs } from "shell-quote";
import { createOctokit, type Octokits } from "../github/api/client";
import {
  isEntityContext,
  isWorkflowRunEvent,
  parseGitHubContext,
  type GitHubContext,
} from "../github/context";
import { setupGitHubToken } from "../github/token";
import { checkWritePermissions } from "../github/validation/permissions";
import { checkContainsTrigger } from "../github/validation/trigger";
import { validateBranchName } from "../github/operations/branch";
import { restoreConfigFromBase } from "../github/operations/restore-config";
import { redactAllSecrets } from "../github/utils/sanitizer";
import { detectMode } from "../modes/detector";
import { prepareTagMode, type PreparedRun } from "../modes/tag";
import { prepareAgentMode } from "../modes/agent";
import { installKiroCli } from "../kiro/install";
import { prepareKiroEnvironment } from "../kiro/env";
import { runKiro, type KiroRunResult } from "../kiro/run";
import {
  commitAndPush,
  snapshotWorkingTree,
  type CommitAndPushResult,
  type WorkingTreeSnapshot,
} from "../git/commit";
import { KIRO_AGENT_NAME } from "../github/constants";
import { updateCommentLink } from "./update-comment-link";

/** How much of the CLI output to show in the job summary. */
const SUMMARY_LIMIT_BYTES = 60_000;

export async function run() {
  const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
  const promptFile = `${runnerTemp}/kiro-prompts/kiro-prompt.txt`;
  const outputFile = `${runnerTemp}/kiro-output/kiro-output.txt`;
  // Outside the workspace on purpose: the agent writes its commit message here,
  // and a path inside the checkout would end up in the commit itself.
  const commitMessageFile = `${runnerTemp}/kiro-commit-message.txt`;

  let context: GitHubContext | undefined;
  let octokit: Octokits | undefined;
  let prepared: PreparedRun | undefined;
  let prepareCompleted = false;
  let prepareError: string | undefined;
  let kiroResult: KiroRunResult | undefined;
  let commitResult: CommitAndPushResult | undefined;
  let containsTrigger = false;

  try {
    // ---- Prepare -------------------------------------------------------
    context = parseGitHubContext();
    const mode = detectMode(context);
    core.info(`Detected mode: ${mode}`);

    const { token: githubToken, source: tokenSource } =
      await setupGitHubToken();
    core.setOutput("token_source", tokenSource);
    core.setOutput("github_token", githubToken);
    process.env.GITHUB_TOKEN = githubToken;
    process.env.GH_TOKEN = githubToken;

    octokit = createOctokit(githubToken);

    if (isEntityContext(context) || isWorkflowRunEvent(context)) {
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
      );
      if (!hasWritePermissions) {
        throw new Error(
          `Actor "${context.actor}" does not have write access to this repository. ` +
            "Only users who can push to the repository may run this action.",
        );
      }
    }

    containsTrigger =
      mode === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : Boolean(context.inputs.prompt);

    core.setOutput("contains_trigger", String(containsTrigger));

    if (!containsTrigger) {
      core.info("No trigger condition was met; nothing to do.");
      return;
    }

    // Fail before posting a tracking comment if the credential is missing.
    prepareKiroEnvironment();

    prepared =
      mode === "tag"
        ? await prepareTagMode({
            context,
            octokit,
            githubToken,
            commitMessageFile,
          })
        : await prepareAgentMode({ context, octokit, githubToken });

    prepareCompleted = true;

    // ---- Run -----------------------------------------------------------
    const kiroCommand = installKiroCli();

    // On a pull request the checkout is attacker-controlled, and the CLI reads
    // agent definitions, MCP config, hooks, and steering files from it. Replace
    // those paths with the reviewed versions from the base branch first.
    if (isEntityContext(context) && context.isPR) {
      const baseRef =
        prepared.branchInfo.baseBranch ||
        (context.payload as { pull_request?: { base?: { ref?: string } } })
          .pull_request?.base?.ref;
      if (baseRef) {
        validateBranchName(baseRef);
        restoreConfigFromBase(baseRef);
      } else {
        core.warning(
          "Could not determine the pull request base branch; skipping config restore",
        );
      }
    }

    // Anything dirty at this point was left by the action itself (its own
    // dependency install when used as `uses: ./`, or the config restore above),
    // and must not end up in the agent's commit.
    let baseline: WorkingTreeSnapshot | undefined;
    if (mode === "tag") {
      baseline = snapshotWorkingTree();
    }

    kiroResult = await runKiro({
      kiroCommand,
      agentName: KIRO_AGENT_NAME,
      engine: context.inputs.agentEngine,
      prompt: prepared.prompt,
      promptFile,
      outputFile,
      effort: context.inputs.effort,
      // On the text path this becomes --require-mcp-startup. On the ACP path it
      // gates whether the run waits for the _kiro/mcp/status "connected" report
      // before prompting (which replaces --require-mcp-startup, unenforced on
      // v3): in tag mode github_comment is mandatory, so hasMcpServers keeps its
      // failure-to-connect fatal.
      requireMcpStartup: prepared.hasMcpServers,
      trustAllTools: context.inputs.trustAllTools,
      extraArgs: parseKiroArgs(process.env.KIRO_ARGS),
      timeoutMinutes: parseTimeout(process.env.TIMEOUT_MINUTES),
      // Only v3 needs this: it finishes its answer and then never exits.
      idleTimeoutSeconds: context.inputs.agentEngine === "v3" ? 90 : undefined,
      outputFormat: context.inputs.outputFormat,
      // The ACP path passes these directly in session/new; the text path ignores
      // them (it sources servers from the generated agent config).
      mcpServers: prepared.mcpServers,
    });

    core.setOutput("execution_file", kiroResult.outputFile);

    // Kiro has no shell in headless mode (tool trust is all-or-nothing there,
    // so allowing `git add` would also allow `curl`), so the action commits and
    // pushes whatever it changed. Only in tag mode: agent-mode workflows decide
    // for themselves what to do with the working tree.
    if (
      mode === "tag" &&
      kiroResult.reason === "success" &&
      isEntityContext(context)
    ) {
      const branch =
        prepared.branchInfo.kiroBranch || prepared.branchInfo.currentBranch;
      validateBranchName(branch);
      commitResult = commitAndPush({
        branch,
        messageFile: commitMessageFile,
        fallbackSubject: `Apply changes from Kiro for ${
          context.isPR ? "PR" : "issue"
        } #${context.entityNumber}`,
        coAuthorLine: prepared.coAuthorLine,
        baseline,
      });
      if (commitResult.changed && !commitResult.pushed) {
        core.warning(
          "Kiro changed files but they could not be pushed; see the log above.",
        );
      }
    }

    if (kiroResult.reason === "mcp_startup_failure") {
      throw new Error(
        "The Kiro CLI could not start its MCP servers (exit code 3). " +
          `See ${kiroResult.outputFile} for details. ` +
          `Agent config: ${prepared.agentPath}`,
      );
    }

    if (kiroResult.reason === "failure") {
      throw new Error(
        `The Kiro CLI exited with code ${kiroResult.exitCode}. ` +
          `See ${kiroResult.outputFile} for details. ` +
          `Agent config: ${prepared.agentPath}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!prepareCompleted) {
      prepareError = message;
    }
    core.setFailed(`Action failed with error: ${redactAllSecrets(message)}`);
  } finally {
    // A run that no trigger matched did not fail; it simply did nothing.
    const succeeded =
      kiroResult?.reason === "success" ||
      (!containsTrigger && prepareError === undefined);
    core.setOutput("conclusion", succeeded ? "success" : "failure");
    if (prepared?.branchInfo.kiroBranch) {
      core.setOutput("branch_name", prepared.branchInfo.kiroBranch);
    }

    if (context && octokit && prepared?.commentId && isEntityContext(context)) {
      try {
        await updateCommentLink({
          commentId: prepared.commentId,
          kiroBranch: prepared.branchInfo.kiroBranch,
          baseBranch:
            prepared.branchInfo.baseBranch ||
            context.repository.default_branch ||
            "main",
          triggerUsername: context.actor,
          context,
          octokit,
          kiroSuccess: kiroResult?.reason === "success",
          durationMs: kiroResult?.durationMs,
          prepareSuccess: prepareCompleted,
          errorDetails: prepareError ?? failureDetails(kiroResult),
        });
      } catch (error) {
        core.warning(`Could not update the tracking comment: ${error}`);
      }
    }

    if (process.env.DISPLAY_REPORT !== "false" && kiroResult) {
      await writeStepSummary(kiroResult.outputFile);
    }
  }
}

function failureDetails(result: KiroRunResult | undefined): string | undefined {
  if (!result || result.reason === "success") {
    return undefined;
  }
  if (result.reason === "mcp_startup_failure") {
    return "The Kiro CLI failed to start its MCP servers (exit code 3).";
  }
  return `The Kiro CLI exited with code ${result.exitCode}.`;
}

/** Splits the `kiro_args` input into argv, without going through a shell. */
export function parseKiroArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return parseShellArgs(raw)
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      // shell-quote returns objects for operators and globs. A glob is a
      // legitimate literal here; an operator (|, &&, >) is not, because these
      // arguments never reach a shell.
      if (typeof entry === "object" && "pattern" in entry) {
        return entry.pattern;
      }
      throw new Error(
        `kiro_args contains a shell operator, which is not supported: ${JSON.stringify(entry)}`,
      );
    })
    .filter((entry) => entry.length > 0);
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    core.warning(`Ignoring invalid timeout_minutes value: "${raw}"`);
    return undefined;
  }
  return minutes;
}

async function writeStepSummary(outputFile: string): Promise<void> {
  try {
    const content = await readFile(outputFile, "utf8");
    const truncated =
      content.length > SUMMARY_LIMIT_BYTES
        ? `${content.slice(-SUMMARY_LIMIT_BYTES)}\n\n[earlier output truncated]`
        : content;

    await core.summary
      .addHeading("Kiro run output", 3)
      .addCodeBlock(truncated, "text")
      .write();
  } catch (error) {
    core.debug(`Could not write the step summary: ${error}`);
  }
}
