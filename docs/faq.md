# FAQ

## Nothing happened when I commented

Check, in order:

1. Did the job run at all? An `if:` condition on the workflow may have skipped it.
2. The step log prints `No trigger was met for @kiro` when the phrase was not
   matched as a standalone token. `@kirobot` and `me@kiro.dev` do not match.
3. `contains_trigger` is `false` in the outputs when nothing matched.
4. Do you have write access to the repository? Actors without it are rejected.
5. Was the comment written by a bot? Bots need `allowed_bots`.

## Kiro answered but did not push anything

Pushes only happen when the request asks for a code change. If it _was_ a change
request, look for a permission denial in the log: the run only has a fixed list of
shell commands, and anything else is denied silently by the CLI. Grant what you
need with `allowed_shell_commands`.

If the branch was created but nothing was committed to it, the action deletes it
at the end of the run — that is expected.

## Why can't it open a pull request?

Deliberately, for the same reason the upstream action refuses: opening or
approving pull requests from an automated reviewer defeats review. The run posts a
pre-filled "Create a PR" link instead, so a human clicks the last step.

## Why doesn't my push trigger other workflows?

`${{ github.token }}` intentionally does not trigger workflows, to avoid loops.
Pass a PAT or a GitHub App token as `github_token` if you need CI to run on
Kiro's commits.

## The commits say `github-actions[bot]`

That is the identity of the default token. Set `github_token` to a PAT or app
token and set `bot_name`/`bot_id` to that identity.

## Why is the Marketplace listing named differently from the repository?

The listing is "Kiro CLI Action" while the repository is `ndmxjp/Kiro-action`.
Marketplace listing names are a single flat namespace, and "Kiro Action" is already
taken by
[kirodotdev-labs/kiro-action](https://github.com/kirodotdev-labs/kiro-action).
Repository names are per-owner, so the repo keeps its name and
`uses: ndmxjp/Kiro-action@v0` is unaffected.

The name says nothing about who publishes it, so check the listing's description
and this repository's README: this is an unofficial community action, and the Kiro
project's own is the one named "Kiro Action".

## Can I pin the Kiro CLI version?

Not through an input: the install script always fetches the latest release.
Install the version you want in an earlier step and point
`path_to_kiro_cli_executable` at the binary.

## How is this different from claude-code-action?

Same shape, different CLI. Differences that follow from the Kiro CLI's surface:

|                           | claude-code-action                       | this action                                 |
| ------------------------- | ---------------------------------------- | ------------------------------------------- |
| Credential                | Anthropic key, Bedrock, Vertex           | `KIRO_API_KEY` only                         |
| MCP wiring                | `--mcp-config` flag                      | generated agent config at `~/.kiro/agents/` |
| Tool gating               | `--allowedTools` + `acceptEdits`         | agent `allowedTools` + `permissions.rules`  |
| Progress                  | streaming JSON, parsed into the comment  | the `update_kiro_comment` MCP tool          |
| Outputs                   | `structured_output`, turn-by-turn report | captured stdout in `execution_file`         |
| Commit signing            | optional, via the GitHub API             | not supported                               |
| Inline PR review comments | supported                                | not supported                               |

There is no `--output-format json` on `kiro-cli chat`
([kirodotdev/Kiro#5423](https://github.com/kirodotdev/Kiro/issues/5423)), which is
why there is no structured output and no per-turn report: the execution file is
the raw CLI output with secrets redacted.

Bugs found while building this action and reported upstream:
[#10876](https://github.com/kirodotdev/Kiro/issues/10876) (v3 ignores MCP servers
declared in an agent profile) and
[#10877](https://github.com/kirodotdev/Kiro/issues/10877) (v3 leaks a KAS server
per run, which holds the caller's stdout). ANSI escapes in piped
`--no-interactive` output was already reported as
[#8352](https://github.com/kirodotdev/Kiro/issues/8352); this action strips them.

AWS SigV4 / Bedrock-style authentication is not supported.

## Can it read CI failures?

On a pull request, yes, if the job grants `actions: read`. Kiro then has
`get_ci_status`, `get_workflow_run_details`, and `download_job_log`. Without that
permission the CI server is skipped with a warning.

## The run failed with exit code 3

That is the CLI failing to start an MCP server. The action passes
`--require-mcp-startup` so this surfaces instead of silently running without the
comment tool. The captured output (`execution_file`) has the server's stderr.

## It ran for too long

Set `timeout_minutes`. The action terminates the CLI — the whole process group, so
a surviving child cannot keep the job alive — and still updates the tracking
comment with the failure.

On `agent_engine: v3` the CLI leaves a KAS server running after it answers. The
action kills the whole process group and releases the pipes, so that does not stall
the job. If a run ever goes quiet without finishing, 90 seconds of silence is
treated as completion and the execution log says so.

## Where do I report a problem with this action?

Bugs and feature requests go to
[this repository's issues](https://github.com/ndmxjp/Kiro-action/issues). Report a
suspected vulnerability by opening a security advisory on the repository rather
than a public issue.
