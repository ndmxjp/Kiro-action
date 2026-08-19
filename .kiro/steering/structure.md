---
inclusion: always
---

# Layout and control flow

```
action.yml                 the manifest: inputs, and the composite steps that run them
src/entrypoints/           main.ts -> run.ts (the whole flow), update-comment-link.ts
src/modes/                 detector.ts picks tag vs agent; tag/ and agent/ prepare each
src/kiro/                  install, generated agent config, mcp.json, the CLI child process
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
- **The two engines take mutually exclusive schemas.** v2 uses `toolsSettings`; v3 uses `permissions.rules`. Emit one or the other and never both — handing v2 a config that carries `permissions` makes it drop the config entirely and fall back to the user default.
- **`fs_write` and `execute_bash` appear in `tools` but are deliberately absent from `allowedTools`.** Trusting a tool overrides the settings that scope it; the CLI says so out loud ("You have trusted execute_bash tool, which overrides the toolsSettings"). Moving them into `allowedTools` looks like a fix for a permission error and silently removes all path and command scoping.
- **v3 ignores `mcpServers` declared inside an agent profile**, so on v3 the servers are written to `~/.kiro/settings/mcp.json` with `includeMcpJson` (`src/kiro/mcp-json.ts`). Reported upstream as kirodotdev/Kiro#10876.
- **The CLI child is spawned detached, and the run resolves on `exit`, not `close`.** On v3 the CLI answers, exits, and leaves a KAS server as a grandchild holding the output pipes; waiting for `close` never returns. The process group is signalled and the pipes are destroyed explicitly. Reported upstream as kirodotdev/Kiro#10877.
- **The agent never commits.** `src/git/commit.ts` stages only the paths whose contents changed after `snapshotWorkingTree`, so the action's own `bun install` and the pull-request config restore stay out of the agent's commit. The commit message is read from a file under `$RUNNER_TEMP`, which is why the write policy allows `$RUNNER_TEMP/kiro-*` in addition to `./**`.

## The MCP servers this action provides

`src/mcp/prepare-mcp-config.ts` assembles them:

- `github_comment` — updates the tracking comment. In tag mode this is the **only** channel through which the agent reports anything, so a failure to start it is fatal (`--require-mcp-startup`, exit code 3).
- `github_ci` — reads workflow runs and job logs on a pull request. Added only when a probe API call confirms the workflow token carries `actions: read`; otherwise it is skipped with a warning.

Both are launched as `bun` subprocesses with the same flags the entrypoint uses, so they read their runtime config from the action directory rather than from the untrusted working directory.
