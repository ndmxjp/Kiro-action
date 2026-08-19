---
inclusion: always
---

# Security invariants

This action gives a model write access to a repository, driven by text anyone can write. The properties below are the reason it is safe to enable at all. Changing any of them means re-reading `docs/security.md` and updating it in the same change — that document is the authority, and it records evidence rather than intent.

## Do not weaken these

- **The actor gate runs before anything else.** Write or admin permission is required; bots need `allowed_bots`. On `workflow_run` the upstream actor is checked too. Adding the trigger phrase is not authorisation — the commenter's repository permission is.
- **Untrusted content is pinned to trigger time, then stripped.** Comments created or edited at or after the triggering event are dropped, and the title and body come from the webhook payload rather than a later API read, so an attacker cannot edit a comment after an authorised user triggers the run. Hidden-instruction channels (HTML comments, zero-width and bidi characters, image alt text, link titles, `alt`/`title`/`aria-label`/`data-*` attributes) are removed in `src/github/utils/sanitizer.ts`.
- **On a pull request, config the CLI executes is replaced from the base branch** (`src/github/operations/restore-config.ts`): `.kiro/`, `.amazonq/`, `.mcp.json`, `AGENTS.md`, `KIRO.md`, `.gitmodules`, `.ripgreprc`, `.husky/`. They are **deleted first and fetched afterwards**, and that order is load-bearing: a hostile `.gitmodules` present during a `git fetch` can make git contact attacker-chosen remotes and hang the job on a credential prompt.
- **The shell allow list is specific commands; the deny list wins.** Read-only git by default, plus whatever `allowed_shell_commands` adds. `curl`, `wget`, `sudo`, `rm -rf`, `nc`, `ssh`, `git push`, `git config`, and `git remote` are refused regardless. The last three matter because the push URL carries the GitHub token and because `git push --receive-pack='sh -c …' ext::sh origin` is remote code execution — the class of issue behind HackerOne #3556799 against the upstream action.
- **Writes are confined to the checkout**, plus `$RUNNER_TEMP/kiro-*` and the CI log directory the agent is told to read. Without this the agent could write to `$HOME` and reach its own permission files.
- **Output is redacted before it is persisted.** GitHub's log masking does not cover the execution file, the job summary, or the tracking comment, and the agent runs in a process holding `KIRO_API_KEY`. Model-authored text goes through both a pattern redactor (including the `ksk_` prefix Kiro keys use) and a literal-value redactor for known env secrets. This has already been a real defect once.

## When adding capability

Grant specific commands, never interpreters. The allow and deny lists match command text, so a granted command that itself takes arbitrary arguments — `bash -c`, a task runner, a script that shells out — widens the hole as far as that command goes. Remember that whatever a workflow grants, a prompt injection can also reach.

`trust_all_tools: true`, and naming `execute_bash` in `allowed_tools`, both disable the scoping entirely. They are escape hatches for trusted automation, documented as such, and must stay opt-in.

## Claims are measured, not assumed

`.github/workflows/kiro-perm-probe.yml` runs the CLI directly across a matrix of configurations, and `docs/security.md` records the results as tables — which configuration allowed `git status`, which allowed a write to `/tmp`, which allowed `curl`. That harness exists because an earlier round of reasoning about this was wrong: patterns were written pre-anchored (`^git status.*$`), matched nothing, and led to the conclusion that scoping was impossible on the v2 engine.

If you change tool gating, re-measure with that workflow, or state plainly in the change that you did not.
