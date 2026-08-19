---
inclusion: always
---

# Stack and tooling

TypeScript on Bun, packaged as a **composite** GitHub Action. `action.yml` installs Bun, runs `bun install --production` in the action directory, and executes `src/entrypoints/main.ts` directly.

**There is no build step, and nothing generated is committed.** No `dist/`, no bundler. This was tried and reverted (`315f7d1`): bundling was measured as saving about 2.9 s of startup, at the cost of a committed artifact that can go stale, and running from source is what the upstream action does. Do not reintroduce a build step, and do not add a CI check for a stale bundle.

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

CI (`.github/workflows/ci.yml`) runs the install, typecheck, format check, full test run, and the wrapper lint. Bun is pinned to 1.3.14 in both `action.yml` and CI; keep the two in step. If `bun` is missing from a machine, `npx -y bun …` runs the same pinned version.

## Dependencies, and what they are for

`@actions/core` and `@actions/github` for the runner interface, `@octokit/rest` plus `@octokit/graphql` for the API, `@modelcontextprotocol/sdk` for the two MCP servers this action ships, `zod` for validating their tool inputs, and `shell-quote` for splitting the `kiro_args` input into argv. Prefer these over adding anything new; the dependency tree is installed on every run, so its size is a runtime cost.

`bun.lock` is committed and `--frozen-lockfile` is used everywhere. It is excluded from prettier (`.prettierignore`) because it is generated.

## Runtime assumptions

- The action runs on `ubuntu-latest` in practice. Paths under `$RUNNER_TEMP` are used for the prompt file, the captured CLI output, and the agent's commit message.
- Code is entered through `src/entrypoints/main.ts` rather than an `import.meta.main` guard (`f8b71f3`), so nothing depends on how the file was invoked.
- `oven-sh/setup-bun` is pinned by commit SHA, not by tag, because this action runs with the caller's token in scope. Its cache is disabled deliberately — the save step is not ref-aware, so repeat runs on one ref hit a 409 and `@actions/cache` burns 20–30 s retrying.

## Style

Prettier with default settings decides formatting; there is no ESLint. `tsc --noEmit` with `strict` is the only static analysis, so lean on the type system rather than on runtime checks for shape errors.
