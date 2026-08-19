---
inclusion: always
---

# What this project is

A GitHub Action that runs the Kiro CLI on issues and pull requests. Someone mentions `@kiro` in a comment; the action reads the thread, works in a branch, and reports back by editing a single tracking comment.

It is a port of [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) (MIT) to the Kiro CLI, and it exists to carry over that project's hardening rather than to be the most convenient wrapper. The Kiro project publishes its own action at [kirodotdev-labs/kiro-action](https://github.com/kirodotdev-labs/kiro-action); this one is deliberately the more locked-down alternative.

**This project is unofficial.** It is not affiliated with, sponsored by, or endorsed by Amazon Web Services. "Kiro" and "Amazon Web Services" are trademarks of Amazon.com, Inc. or its affiliates. That disclaimer appears in the README, in `action.yml`'s description, and in release notes; keep it in all three when editing any of them.

## Who it is for, and what that implies

Repository maintainers who want an agent on their issues and pull requests, including on **public** repositories where anyone can write the text that drives the model. Every design decision follows from that last part: the input is untrusted, so capability is granted narrowly and explicitly, and a feature that cannot be scoped is not shipped.

When a change would trade safety for convenience, the answer here has consistently been to keep the limit and document the friction instead.

## The two modes

- **Tag mode** — a human wrote the trigger phrase, added the trigger label, or assigned the trigger user. The action posts a tracking comment, creates a branch (issues, closed PRs) or checks out the PR branch, builds a prompt from the whole thread, and reports everything through that one comment.
- **Agent mode** — the workflow supplied a `prompt`. No tracking comment, no branch creation: the workflow decides what happens. This is the path for scheduled jobs and `workflow_dispatch`.

The mode is detected from the event and the inputs; there is nothing for a user to configure.

## Deliberate limitations

These are decisions, not gaps to be closed opportunistically:

- The agent cannot open, approve, or merge a pull request, and cannot submit a formal review. A run hands back a pre-filled "Create a PR" link so a human takes the last step.
- The agent cannot commit or push. It edits files; the action commits.
- The agent posts exactly one comment.
- It cannot touch `.github/workflows`.
- Only actors with write access to the repository can trigger a run.
