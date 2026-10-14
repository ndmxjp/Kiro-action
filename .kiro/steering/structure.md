---
inclusion: always
---

# Layout and control flow

```
action.yml                 the manifest: inputs, and the composite steps that run them
src/entrypoints/           main.ts -> run.ts (the whole flow), update-comment-link.ts
src/modes/                 detector.ts picks tag vs agent; tag/ and agent/ prepare each
src/kiro/                  install, generated agent config, skills install, the CLI child process
src/github/                api/, data/ (fetch + format), operations/ (branch, comments,
                           config restore), validation/ (actor, permissions, trigger), utils/
src/mcp/                   the two MCP servers this action provides, and their assembly
src/create-prompt/         system prompt and tag-mode prompt construction
src/git/commit.ts          staging, committing, and pushing what the agent changed
scripts/git-push.sh        hardened push wrapper, for the opt-in unrestricted-shell case
test/                      bun:test, one file per unit
docs/                      configuration.md, security.md, faq.md
```

`src/entrypoints/run.ts` is the place to start reading. The order there is: parse context → `detectMode` → `setupGitHubToken` → `checkWritePermissions` → `checkContainsTrigger` → prepare the mode → `installKiroCli` → `restoreConfigFromBase` (pull requests only) → `snapshotWorkingTree` → `runKiro` → `commitAndPush` (tag mode only) → update the tracking comment in `finally`.

## Inputs cross the boundary as environment variables

An input is not read from `action.yml` at runtime. The manifest maps each one into the `env:` block of the run step, and `src/github/context.ts` parses them into `context.inputs`. **Adding an input means three edits**: the `inputs:` declaration, the `env:` mapping, and the `context.ts` field. A few values are read straight from `process.env` in `run.ts` instead (`KIRO_ARGS`, `TIMEOUT_MINUTES`, `DISPLAY_REPORT`).

## How the CLI is actually controlled

This is where the non-obvious constraints live. `docs/security.md` is the authority and records what was measured rather than assumed.

- **The Kiro CLI has no `--mcp-config` and no `--allowedTools` flag.** Everything is expressed as a generated agent profile written to `~/.kiro/agents/kiro-action.json` by `src/kiro/agent-config.ts`. It is written to the home directory, never into the checkout's `.kiro/`, which is attacker-controlled on a pull request and would also be swept into the commit.
- **The profile carries both permission schemas.** The classic engine reads `toolsSettings`, v3 reads `permissions.rules`, and `buildAgentConfig` emits both with the same policy — the shape `kiro-cli agent upgrade` itself writes. On kiro-cli 2.18.1 the classic engine dropped a profile that carried `permissions`, which is why they used to be mutually exclusive; measured loading on both engines on 2.29.1. Change one block and you must change the other.
- **`fs_write` and `execute_bash` appear in `tools` but are deliberately absent from `allowedTools`.** Trusting a tool overrides the settings that scope it; the CLI says so out loud ("You have trusted execute_bash tool, which overrides the toolsSettings"). Moving them into `allowedTools` looks like a fix for a permission error and silently removes all path and command scoping.
- **Both engines read `mcpServers` from the profile; `includeMcpJson` stays false.** On 2.18.1 v3 ignored the profile's servers (kirodotdev/Kiro#10876) and the action wrote them to `~/.kiro/settings/mcp.json` as a detour; measured gone on 2.29.1, and the detour was removed so the checkout's mcp.json is never merged on any engine. v3 also needs a `skill` allow rule before an installed skill can be activated.
- **The CLI child is spawned detached, and the run resolves on `exit`, not `close`.** On kiro-cli 2.18.1, v3 answered, exited, and left a KAS server as a grandchild holding the output pipes, so waiting for `close` never returned. The process group is signalled and the pipes are destroyed explicitly. Fixed upstream in 2.21.1 (kirodotdev/Kiro#10877); the handling stays as a guard against a regression or a pinned older CLI.
- **The agent never commits.** `src/git/commit.ts` stages only the paths whose contents changed after `snapshotWorkingTree`, so the action's own `bun install` and the pull-request config restore stay out of the agent's commit. The commit message is read from a file under `$RUNNER_TEMP`, which is why the write policy allows `$RUNNER_TEMP/kiro-*` in addition to `./**`.

## The MCP servers this action provides

`src/mcp/prepare-mcp-config.ts` assembles them:

- `github_comment` — updates the tracking comment. In tag mode this is the **only** channel through which the agent reports anything, so a failure to start it is fatal (`--require-mcp-startup`, exit code 3).
- `github_ci` — reads workflow runs and job logs on a pull request. Added only when a probe API call confirms the workflow token carries `actions: read`; otherwise it is skipped with a warning.

- `github_inline_comment` — posts review comments on lines of the PR diff. Only when a workflow opts in with `use_inline_comments`; wraps `pulls.createReviewComment` alone, never the review API, so approving stays impossible; capped at 20 per run (`src/github/operations/comments/inline-comment.ts`).

All three are launched as `bun` subprocesses with the same flags the entrypoint uses, so they read their runtime config from the action directory rather than from the untrusted working directory.
