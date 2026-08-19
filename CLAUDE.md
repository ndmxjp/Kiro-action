# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An unofficial GitHub Action that runs the [Kiro CLI](https://kiro.dev) on issues and pull requests — a port of [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) to a different CLI, carrying over its hardening. It is a **composite** action whose TypeScript runs from source under Bun: no build step, no `dist/`, nothing generated to commit. A bundle was tried and deliberately reverted (`315f7d1`).

## Commands

```sh
bun install --frozen-lockfile
bun run typecheck          # tsc --noEmit
bun run format:check       # prettier --check .   (bun run format to write)
bun test
bun test test/commit.test.ts                        # one file
bun test --test-name-pattern "confines writes"      # one test by name
bash -n scripts/git-push.sh                         # CI lints the push wrapper too
```

`.github/workflows/ci.yml` runs the install, typecheck, format check, full test run, and the wrapper lint, on Bun 1.3.14. If `bun` is not on `PATH`, `npx -y bun …` runs that same pinned version.

## Architecture

`action.yml` (composite) installs Bun, runs `bun install --production` in the action directory, then executes `src/entrypoints/main.ts` → `src/entrypoints/run.ts`.

**Inputs cross the boundary as environment variables only.** `action.yml` maps each input into the `env:` block of the run step, and `src/github/context.ts` parses them into `context.inputs`. Adding an input therefore means three edits: the `inputs:` declaration, the `env:` mapping, and the `context.ts` field. A few are read straight from `process.env` in `run.ts` instead (`KIRO_ARGS`, `TIMEOUT_MINUTES`, `DISPLAY_REPORT`).

`run.ts` is the whole flow, in order: parse context → `detectMode` → `setupGitHubToken` → `checkWritePermissions` → `checkContainsTrigger` → `prepareTagMode`/`prepareAgentMode` → `installKiroCli` → `restoreConfigFromBase` (pull requests only) → `snapshotWorkingTree` → `runKiro` → `commitAndPush` (tag mode only) → tracking-comment update in `finally`.

**Two modes** (`src/modes/detector.ts`): _tag_ is the human path (trigger phrase, label, or assignee) and owns a tracking comment plus a branch; _agent_ is the automation path, selected by the workflow supplying `prompt`, and creates neither. `track_progress` forces tag mode.

### How the CLI is controlled

This is the part that needs reading several files to understand, and where the non-obvious constraints live. `docs/security.md` is the authority; it records what was measured rather than assumed.

- **There is no `--mcp-config` or `--allowedTools` flag on `kiro-cli`.** Everything is expressed as a generated agent profile written to `~/.kiro/agents/kiro-action.json` (`src/kiro/agent-config.ts`) — never into the checkout's `.kiro/`, which is attacker-controlled on a pull request and would also be swept into the commit.
- **The two engines take mutually exclusive schemas.** v2 uses `toolsSettings`, v3 uses `permissions.rules`. Emit one or the other, never both: handing v2 a config carrying `permissions` makes it drop the config entirely.
- **`fs_write` and `execute_bash` are listed in `tools` but deliberately absent from `allowedTools`.** Trusting a tool overrides the settings that scope it ("You have trusted execute_bash tool, which overrides the toolsSettings"). Adding them there looks like a fix and silently removes all shell and path scoping.
- **v3 ignores `mcpServers` declared in an agent profile**, so on v3 they go to `~/.kiro/settings/mcp.json` with `includeMcpJson` (`src/kiro/mcp-json.ts`). Upstream: kirodotdev/Kiro#10876.
- **The CLI is spawned detached, and the run resolves on `exit` rather than `close`.** v3 leaks a KAS server as a grandchild that holds the pipes; without the process group and the explicit pipe teardown the action finishes its work and then hangs. Upstream: kirodotdev/Kiro#10877.
- **The agent never commits.** `git push`, `git config`, and `git remote` are denied (the push URL carries the token, and `git push --receive-pack=…` is RCE). `src/git/commit.ts` stages only paths whose content changed after `snapshotWorkingTree`, so the action's own `bun install` and the config restore stay out of the commit. The message comes from a file under `$RUNNER_TEMP`, which is why the write policy allows `$RUNNER_TEMP/kiro-*` as well as `./**`.

The action supplies its own MCP servers (`src/mcp/prepare-mcp-config.ts`): `github_comment`, the only channel through which progress is reported, and `github_ci`, added on pull requests when a probe call confirms `actions: read`.

Prompt construction lives in `src/create-prompt/index.ts` (`buildSystemPrompt`, `createTagPrompt`); GitHub data is fetched and formatted in `src/github/data/`.

### Security invariants

Changing any of these means re-reading `docs/security.md` and updating it:

- Only actors with write access run anything; bots need `allowed_bots`.
- Comment and issue content is pinned to trigger time, then stripped of hidden-instruction channels (`src/github/utils/sanitizer.ts`).
- On a pull request, the config paths the CLI executes are **deleted first and fetched from the base branch afterwards** (`src/github/operations/restore-config.ts`) — the order matters, because a hostile `.gitmodules` present during a `git fetch` can reach attacker-chosen remotes.
- CLI output is redacted (patterns plus the literal values of known secrets) before it reaches the execution file, the step summary, or the tracking comment. GitHub's log masking does not cover any of those.

## Conventions

- **Claims about CLI behaviour are measured.** `.github/workflows/kiro-perm-probe.yml` is the probe harness that runs the CLI across a configuration matrix, and `docs/security.md` records the results as tables. If you change tool gating, re-measure it or say plainly that you did not.
- **Comments explain why, with the evidence.** Match the surrounding density; the codebase is unusually comment-heavy on purpose, and the comments name what was tested.
- **Commit messages are prose.** Imperative subject, then paragraphs on what was wrong, why it mattered, and how the change was verified. Read `git log` before writing one.
- **Tests** use `bun:test` only. Process-lifecycle behaviour is tested against a fake CLI shell script (`test/kiro-run-lifecycle.test.ts`) rather than mocks. Anything whose behaviour depends on the environment must pin it — see `withRunnerTemp` in `test/agent-config.test.ts`; a test that reads the ambient `RUNNER_TEMP` passes locally and fails on a runner. `test/action-manifest.test.ts` guards against manifest mistakes that only surface when a runner loads `action.yml`.
- **Docs are part of the change.** An input's behaviour is described in four places: its `action.yml` description, the README table, `docs/configuration.md`, and `docs/security.md` where it affects the threat model. Stale input descriptions have already shipped twice.

## Repository workflow

- `main` is protected by a ruleset: pull request required (0 approvals), the CI job `check` must pass, no force pushes or deletions. Repository admins can bypass it, but the intent is that changes land through a PR.
- Tags: `v0` is a moving major tag; `vX.Y.Z` are immutable. `package.json`'s `version` tracks the released tag (the package is `private: true` and never published to a registry).
- The Marketplace listing is named "Kiro CLI Action" because "Kiro Action" belongs to the Kiro project's own action. Keep the unaffiliated-with-AWS disclaimer in the README, the `action.yml` description, and release notes.
