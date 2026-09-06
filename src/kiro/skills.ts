import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Installs Agent Skills into a run, the closest port of upstream
 * claude-code-action's plugins (kiro-action#16). A skill is a folder with a
 * SKILL.md (frontmatter name/description plus instructions) following the
 * agentskills.io layout; the CLI loads them from ~/.kiro/skills/ via the
 * `resources` line the agent config now carries.
 *
 * This module is deliberately dependency-free — it imports only Node built-ins,
 * never @actions/core or any npm package. That is what lets its bun:test run
 * offline in a sandbox where the npm registry is unreachable, and it mirrors
 * src/kiro/install.ts, which shells out to install the CLI the same way.
 * Logging therefore goes through console.log / console.warn rather than core.
 *
 * The security posture is the same one the rest of the action follows and is
 * spelled out in docs/security.md and .kiro/steering/security-invariants.md:
 *
 *   - Skills are installed under $HOME (~/.kiro/skills/<name>/), NEVER into the
 *     checkout. On a pull request the checkout is attacker-controlled and is
 *     swept into the commit this action makes; a skill written there would be
 *     both tamperable and committed.
 *   - Only the skill folder's own content is installed, not the whole clone: the
 *     resolved skill folder (the repo root, or `subpath` within it) is copied
 *     flat into ~/.kiro/skills/<name>/, and the clone's `.git/` and any unrelated
 *     sibling files are left behind. This is both what makes a subpath skill's
 *     SKILL.md land where the loader glob finds it and what keeps repo files the
 *     author did not intend as a skill from becoming prompt content. See
 *     {@link installSkill} for the full reasoning.
 *   - Only https:// clone URLs are accepted; http:// is rejected so a pinned SHA
 *     is never fetched over plaintext transport.
 *   - A commit SHA is REQUIRED. A moving ref (branch or tag) is code that can
 *     change under you between the review and the run — the same reason
 *     action.yml pins setup-bun by SHA. Only a pinned commit is reproducible.
 *   - git is invoked with an ARGS ARRAY via execFileSync, never a shell string.
 *     `git` with attacker-influenced arguments is remote code execution (see the
 *     deny-list rationale in src/kiro/agent-config.ts), so the name is validated
 *     to a tight allow-list before it is ever passed to a process.
 *   - Fetching happens here, in the action, BEFORE the CLI starts. The agent
 *     itself never gets network access for this.
 */

/**
 * A single parsed skills entry. `source` is the git URL to clone; `name` is the
 * folder it lands in under ~/.kiro/skills/ and the value SKILL.md's frontmatter
 * must match; `sha` is the required pinned commit; `subpath`, when present,
 * points at the skill folder inside a larger repository.
 */
export type SkillEntry = {
  source: string;
  name: string;
  sha: string;
  subpath?: string;
};

/**
 * Only these characters are allowed in a skill name, matching upstream
 * install-plugins.ts. Everything a shell would treat specially (spaces, `;`,
 * `|`, `$`, backticks, quotes, redirects, globs) is therefore rejected, as is
 * anything outside the printable ASCII identifier set.
 */
const ALLOWED_NAME = /^[A-Za-z0-9@._/-]+$/;

/**
 * A commit SHA is a hex string. Git's default is 40 hex chars (SHA-1) and 64
 * for SHA-256; we accept the whole range git itself produces (7..64) so an
 * abbreviated-but-unambiguous commit is allowed, while a branch or tag name —
 * which contains letters outside [a-f] or is otherwise non-hex — is not.
 */
const SHA = /^[0-9a-f]{7,64}$/;

/**
 * Splits the raw `skills` input into trimmed, non-blank lines.
 *
 * The input is newline-separated so a workflow can list one skill per line in a
 * YAML block scalar; blank lines and surrounding whitespace are noise from that
 * formatting, not entries.
 */
export function parseSkillsInput(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Turns one raw entry into a {@link SkillEntry}, distinguishing the two shapes
 * documented in action.yml:
 *
 *   - `owner/repo@<sha>` or `owner/repo@<sha>/path/to/skill` — a GitHub-style
 *     shorthand expanded to an https clone URL.
 *   - `https://…git` optionally followed by `#<sha>` — a full clone URL, with
 *     the pinned commit after the fragment.
 *
 * Parsing only splits the string into its parts; the name and SHA are validated
 * by {@link validateSkillName} and {@link requireSha}, which every caller runs.
 */
export function parseSkillEntry(raw: string): SkillEntry {
  const entry = raw.trim();
  if (!entry) {
    throw new Error("Empty skills entry");
  }

  if (entry.startsWith("http://")) {
    // Reject plaintext transport. The commit SHA pins *what* is cloned, but
    // http:// still fetches it over an unauthenticated, tamperable channel, and
    // action.yml / docs promise https only. Rejecting here keeps the promise
    // rather than silently downgrading; use the https:// form of the same URL.
    throw new Error(
      `Skills entry "${entry}" uses http://; only https:// is allowed ` +
        "(plaintext transport is a downgrade even with a pinned SHA).",
    );
  }

  if (entry.startsWith("https://")) {
    // https URL shape: the commit is after a `#` fragment, e.g.
    // https://github.com/owner/repo.git#<sha>. The name is derived from the
    // final path segment with any `.git` suffix removed.
    const [url, sha = ""] = splitOnce(entry, "#");
    const name = repoNameFromUrl(url);
    return { source: url, name, sha };
  }

  // owner/repo@<sha>[/path] shape. Split off the commit at `@` first, then any
  // trailing subpath after the SHA.
  const [ownerRepo, rest = ""] = splitOnce(entry, "@");
  if (!rest) {
    // No `@` at all: there is no SHA to pin to. Reported clearly rather than
    // silently treating the whole thing as a repo with an empty SHA.
    return {
      source: sourceFromOwnerRepo(ownerRepo),
      name: nameFromOwnerRepo(ownerRepo),
      sha: "",
    };
  }

  // `rest` is `<sha>` or `<sha>/path/to/skill`.
  const slash = rest.indexOf("/");
  const sha = slash === -1 ? rest : rest.slice(0, slash);
  const subpath = slash === -1 ? undefined : rest.slice(slash + 1) || undefined;

  return {
    source: sourceFromOwnerRepo(ownerRepo),
    name: subpath ? lastSegment(subpath) : nameFromOwnerRepo(ownerRepo),
    sha,
    subpath,
  };
}

/**
 * Validates a skill name the way upstream install-plugins.ts does: NFC-normalise
 * it, allow only [A-Za-z0-9@._/-], and reject any `..` path segment.
 *
 * The normalise-then-compare step is the load-bearing part. Two different byte
 * sequences can render as the same string (e.g. a precomposed "é" vs. "e" plus a
 * combining accent, or a fullwidth digit that looks like an ASCII one); an
 * attacker could use that to smuggle a name past a naive character check or to
 * make the on-disk folder differ from what the frontmatter claims. Requiring the
 * NFC form means the exact bytes are what they appear to be, and the allow-list
 * then rejects everything a shell would treat specially. The check runs even
 * though git is called with an args array, as defence in depth and because the
 * name also becomes a filesystem path.
 */
export function validateSkillName(name: string): void {
  if (!name) {
    throw new Error("Skill name is empty");
  }

  // Reject anything that is not already in NFC form. Comparing against the
  // normalised copy catches non-canonical and look-alike Unicode.
  if (name.normalize("NFC") !== name) {
    throw new Error(
      `Skill name is not in Unicode NFC normalised form: "${name}"`,
    );
  }

  if (!ALLOWED_NAME.test(name)) {
    throw new Error(
      `Skill name "${name}" contains characters outside [A-Za-z0-9@._/-]`,
    );
  }

  // A `..` segment would let a name escape ~/.kiro/skills/ when joined into a
  // path. Checked on segment boundaries so a legitimate name like "a..b" — which
  // the character class already permits — is not caught, only a real traversal.
  if (name.split("/").some((segment) => segment === "..")) {
    throw new Error(`Skill name "${name}" contains a ".." path segment`);
  }
}

/**
 * Throws unless the entry is pinned to something that looks like a commit SHA.
 *
 * A branch or tag name is rejected: it is a moving ref, so the code it resolves
 * to can change after a workflow author has reviewed it, exactly what pinning by
 * SHA prevents.
 */
export function requireSha(entry: SkillEntry): void {
  if (!entry.sha) {
    throw new Error(
      `Skills entry "${entry.source}" has no commit SHA; a pinned commit is required ` +
        "(a branch or tag is a moving ref). Use owner/repo@<sha> or <url>#<sha>.",
    );
  }
  if (!SHA.test(entry.sha)) {
    throw new Error(
      `Skills entry "${entry.source}" is pinned to "${entry.sha}", which is not a commit SHA. ` +
        "A branch or tag is a moving ref; use a hex commit id.",
    );
  }
}

/**
 * Validates one entry fully: name rules plus the SHA requirement. Kept separate
 * from installing so every entry can be checked before any clone runs.
 */
export function validateSkillEntry(entry: SkillEntry): void {
  validateSkillName(entry.name);
  if (entry.subpath) {
    // The subpath is joined into a filesystem path too, so hold it to the same
    // rules — a `..` there would escape the clone directory.
    validateSkillName(entry.subpath);
  }
  requireSha(entry);
}

/** The directory skills are installed into, always under $HOME. */
export function skillsRoot(): string {
  return join(homedir(), ".kiro", "skills");
}

/**
 * Reads the `name:` field from a SKILL.md YAML frontmatter block.
 *
 * The frontmatter is the leading `---` fenced block. This is a deliberately
 * small reader — not a full YAML parser, which would be an npm dependency this
 * module must not have — so it handles the flat `key: value` frontmatter the
 * agentskills.io format uses and nothing more. Returns undefined if there is no
 * frontmatter or no name key.
 */
export function readSkillName(skillMd: string): string | undefined {
  const match = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return undefined;
  }
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^name:\s*(.+?)\s*$/);
    if (kv) {
      // Strip a single layer of surrounding quotes, which YAML allows.
      return kv[1]!.replace(/^["']|["']$/g, "");
    }
  }
  return undefined;
}

/**
 * Clones and verifies a single skill.
 *
 * The entry MUST already have been validated (see {@link validateSkillEntry});
 * this function assumes the name and SHA are safe and concentrates on the git
 * and filesystem work. It:
 *
 *   1. computes the final target ~/.kiro/skills/<name>/ under $HOME,
 *   2. clones the source into a throwaway staging directory (also under $HOME)
 *      and `git checkout <sha>` (a plain shallow clone lands on the default
 *      branch; the checkout pins the commit, and `git fetch --depth 1 <sha>`
 *      first is what makes an arbitrary commit reachable in a shallow clone),
 *   3. locates the skill folder inside the clone (the repo root, or `subpath`
 *      within it), verifies SKILL.md exists there and that its frontmatter
 *      `name` matches <name>, then copies THAT FOLDER'S CONTENTS — and nothing
 *      else — flat into ~/.kiro/skills/<name>/.
 *
 * Why copy flat rather than clone straight into the target (see kiro-action#16
 * review): the agent config points the CLI at a fixed glob (the SKILLS_RESOURCE
 * in src/kiro/agent-config.ts) whose single wildcard matches exactly one
 * directory level below ~/.kiro/skills. A subpath skill cloned in place would
 * leave its SKILL.md at
 * ~/.kiro/skills/<name>/<subpath>/SKILL.md — one level too deep — so it verified
 * but never loaded. Copying the resolved skill folder to ~/.kiro/skills/<name>/
 * puts SKILL.md exactly where the glob loads it, for both the subpath and the
 * whole-repo case, and matches the frontmatter-name == folder-name check that
 * already assumes the skill folder *is* <name>. It also drops the clone's `.git/`
 * and every unrelated sibling file, so only the skill's own content becomes
 * prompt content rather than the whole repository.
 *
 * git runs via execFileSync with an ARGS ARRAY — never a shell string — so none
 * of the values can be reinterpreted as extra arguments or shell syntax.
 */
export function installSkill(entry: SkillEntry): string {
  validateSkillEntry(entry);

  const target = join(skillsRoot(), entry.name);

  // Clone into a sibling staging directory rather than the target itself, so
  // that only the resolved skill folder's contents, not the whole clone with
  // its .git/, end up under ~/.kiro/skills/<name>/. Both live under $HOME,
  // never the checkout.
  mkdirSync(skillsRoot(), { recursive: true });
  // A fixed prefix (not the name, which may itself contain a slash) keeps the
  // staging directory a single entry directly under the skills root.
  const staging = mkdtempSync(join(skillsRoot(), ".staging-"));

  try {
    console.log(`Installing skill "${entry.name}" from ${entry.source}`);

    git(["clone", "--depth", "1", "--no-tags", entry.source, staging]);
    // Make the pinned commit reachable in the shallow clone, then check it out.
    // `--depth 1` keeps this cheap even for a repository with long history.
    git(["-C", staging, "fetch", "--depth", "1", "origin", entry.sha]);
    git(["-C", staging, "checkout", "--force", entry.sha]);

    const skillDir = entry.subpath ? join(staging, entry.subpath) : staging;
    const skillMdPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      throw new Error(
        `Skill "${entry.name}" has no SKILL.md at ${skillMdPath}. ` +
          "A skill is a folder containing SKILL.md (see agentskills.io).",
      );
    }

    const declaredName = readSkillName(readFileSync(skillMdPath, "utf8"));
    if (declaredName === undefined) {
      throw new Error(
        `Skill "${entry.name}" SKILL.md has no frontmatter "name"; Kiro requires one.`,
      );
    }
    if (declaredName !== entry.name) {
      throw new Error(
        `Skill "${entry.name}" declares name "${declaredName}" in SKILL.md; ` +
          "the frontmatter name must match the folder name Kiro loads it under.",
      );
    }

    // A leftover directory from a previous run would make the copy ambiguous;
    // the action owns everything under ~/.kiro/skills, so replacing it is safe.
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
    }
    // Copy the resolved skill folder's contents flat into the target so
    // SKILL.md lands one level below ~/.kiro/skills, where the loader glob finds
    // it. For a plain entry skillDir is the clone root, which still holds the
    // clone's .git/, so the filter drops it; a subpath skillDir has no .git/ of
    // its own but the filter is harmless there.
    cpSync(skillDir, target, {
      recursive: true,
      filter: (src) => !isGitPath(src, skillDir),
    });

    console.log(`Installed skill "${entry.name}" at ${target}`);
    return target;
  } finally {
    // The staging clone has served its purpose whether install succeeded or
    // threw; never leave it behind under $HOME.
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Parses, validates, and installs every entry in the raw `skills` input.
 *
 * All entries are parsed and validated FIRST, so a typo in the last line fails
 * the run before any clone has touched the disk, rather than leaving a partial
 * set installed.
 */
export function installSkills(raw: string): void {
  const lines = parseSkillsInput(raw);
  if (lines.length === 0) {
    return;
  }

  const entries = lines.map((line) => {
    const entry = parseSkillEntry(line);
    validateSkillEntry(entry);
    return entry;
  });

  console.log(`Installing ${entries.length} skill(s) into ${skillsRoot()}`);
  for (const entry of entries) {
    installSkill(entry);
  }
}

/**
 * Runs git with an args array, throwing on failure.
 *
 * Output is captured and passed through {@link redactEnvSecrets} before it is
 * printed, rather than using `stdio: "inherit"`. Every other CLI-facing output
 * path in this action is redacted, and while a shallow clone of a public repo
 * over the pinned https URL carries no secret in practice, git can echo a remote
 * URL — and a credential helper could fold a token into it — so routing this
 * through the same kind of scrub keeps the asymmetry from becoming a leak. The
 * redactor is deliberately Node-built-in-only (it reads process.env and does
 * simple string replacement) so this module stays dependency-free and its
 * bun:test still runs offline; it does not import the @actions-based
 * redactAllSecrets in src/github/utils/sanitizer.ts for that reason.
 */
function git(args: string[]): void {
  const result = execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    encoding: "utf8",
  });
  const text = redactEnvSecrets(result);
  if (text.trim().length > 0) {
    console.log(text.trimEnd());
  }
}

/**
 * Replaces any environment-variable secret value that appears in `text` with a
 * placeholder. Node-built-in only (no npm deps): it scans process.env for the
 * values of variables whose name looks sensitive (TOKEN/SECRET/KEY/PASSWORD) and
 * masks each occurrence. On a git failure execFileSync throws with stderr on the
 * error, so this only handles the success-path output; the thrown error's text
 * is git's own, which for a pinned public URL likewise carries no secret.
 */
export function redactEnvSecrets(text: string): string {
  let redacted = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 4) {
      continue;
    }
    if (!/TOKEN|SECRET|KEY|PASSWORD|PASSWD/i.test(name)) {
      continue;
    }
    redacted = redacted.split(value).join("***");
  }
  return redacted;
}

/**
 * Whether `src` is the clone's `.git` directory (or something inside it), used to
 * keep git metadata out of the copied skill folder. `root` is the folder being
 * copied; only a top-level `.git` under it is excluded, so a skill that
 * legitimately ships a file whose path contains `.git` elsewhere is unaffected.
 */
function isGitPath(src: string, root: string): boolean {
  const gitDir = join(root, ".git");
  return src === gitDir || src.startsWith(gitDir + "/");
}

/** Splits `value` at the first `separator`; the separator is dropped. */
function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator);
  if (index === -1) {
    return [value];
  }
  return [value.slice(0, index), value.slice(index + separator.length)];
}

function sourceFromOwnerRepo(ownerRepo: string): string {
  return `https://github.com/${ownerRepo}.git`;
}

function nameFromOwnerRepo(ownerRepo: string): string {
  return lastSegment(ownerRepo);
}

function repoNameFromUrl(url: string): string {
  const withoutQuery = splitOnce(url, "?")[0];
  const last = lastSegment(withoutQuery.replace(/\/+$/, ""));
  return last.replace(/\.git$/, "");
}

function lastSegment(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
}
