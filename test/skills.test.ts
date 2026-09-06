import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSkill,
  parseSkillEntry,
  parseSkillsInput,
  readSkillName,
  requireSha,
  validateSkillEntry,
  validateSkillName,
  type SkillEntry,
} from "../src/kiro/skills";

// A real 40-char hex commit id, used wherever a pinned SHA is needed.
const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("parseSkillsInput", () => {
  test("splits on newlines and trims each entry", () => {
    expect(parseSkillsInput("a/b@1234567\n  c/d@abcdef0  ")).toEqual([
      "a/b@1234567",
      "c/d@abcdef0",
    ]);
  });

  test("drops blank and whitespace-only lines", () => {
    expect(parseSkillsInput("\n a/b@1234567 \n\n   \n")).toEqual([
      "a/b@1234567",
    ]);
  });

  test("returns nothing for an empty or whitespace input", () => {
    expect(parseSkillsInput("")).toEqual([]);
    expect(parseSkillsInput("   \n  \n")).toEqual([]);
  });
});

describe("parseSkillEntry", () => {
  test("expands the owner/repo@sha shorthand to a github clone url", () => {
    const entry = parseSkillEntry(`acme/skills@${SHA}`);
    expect(entry).toEqual({
      source: "https://github.com/acme/skills.git",
      name: "skills",
      sha: SHA,
    });
  });

  test("takes the name from the subpath when one is given", () => {
    const entry = parseSkillEntry(`acme/monorepo@${SHA}/skills/reviewer`);
    expect(entry).toEqual({
      source: "https://github.com/acme/monorepo.git",
      name: "reviewer",
      sha: SHA,
      subpath: "skills/reviewer",
    });
  });

  test("rejects an http:// url as a plaintext-transport downgrade", () => {
    expect(() =>
      parseSkillEntry(`http://example.com/acme/skills.git#${SHA}`),
    ).toThrow(/http:\/\/|https:\/\/ is allowed/);
  });

  test("parses an https url with a #sha fragment", () => {
    const entry = parseSkillEntry(`https://example.com/acme/skills.git#${SHA}`);
    expect(entry).toEqual({
      source: "https://example.com/acme/skills.git",
      name: "skills",
      sha: SHA,
    });
  });

  test("parses an https url with no fragment as having no sha", () => {
    const entry = parseSkillEntry("https://example.com/acme/skills.git");
    expect(entry.source).toBe("https://example.com/acme/skills.git");
    expect(entry.name).toBe("skills");
    expect(entry.sha).toBe("");
  });

  test("treats an owner/repo with no @ as having no sha", () => {
    const entry = parseSkillEntry("acme/skills");
    expect(entry.sha).toBe("");
    expect(entry.name).toBe("skills");
  });
});

describe("validateSkillName", () => {
  test("accepts valid names in the allowed character set", () => {
    for (const name of ["skills", "code-reviewer", "acme/skills", "a.b_c@1"]) {
      expect(() => validateSkillName(name)).not.toThrow();
    }
  });

  test("rejects a name containing a `..` path segment", () => {
    expect(() => validateSkillName("../etc")).toThrow(/\.\./);
    expect(() => validateSkillName("a/../b")).toThrow(/\.\./);
  });

  test("rejects shell metacharacters", () => {
    for (const name of [
      "a;b",
      "a|b",
      "a$b",
      "a`b`",
      "a b",
      "a&b",
      "a>b",
      "a(b)",
      "a'b'",
      'a"b"',
    ]) {
      expect(() => validateSkillName(name)).toThrow();
    }
  });

  test("rejects non-normalised / unexpected Unicode", () => {
    // A precomposed "é" is NFC; the same glyph as "e" + combining acute is not,
    // so it must be rejected as non-normalised.
    const combining = "e\u0301"; // e + U+0301 COMBINING ACUTE ACCENT
    expect(combining.normalize("NFC")).not.toBe(combining);
    expect(() => validateSkillName(combining)).toThrow(/NFC/);

    // A fullwidth digit looks like an ASCII "1" but is not in the allow-list.
    expect(() => validateSkillName("skill\uFF11")).toThrow();
  });

  test("rejects an empty name", () => {
    expect(() => validateSkillName("")).toThrow();
  });
});

describe("requireSha", () => {
  const entry = (sha: string): SkillEntry => ({
    source: "https://github.com/acme/skills.git",
    name: "skills",
    sha,
  });

  test("accepts an entry pinned to a hex sha", () => {
    expect(() => requireSha(entry(SHA))).not.toThrow();
    // An abbreviated but valid hex commit is fine too.
    expect(() => requireSha(entry("1234567"))).not.toThrow();
  });

  test("rejects an entry with no sha", () => {
    expect(() => requireSha(entry(""))).toThrow(/required/);
  });

  test("rejects a moving ref (branch or tag name) as a sha", () => {
    expect(() => requireSha(entry("main"))).toThrow();
    expect(() => requireSha(entry("v1.2.3"))).toThrow();
    // Too short to be a git abbreviation, and not all-hex.
    expect(() => requireSha(entry("release"))).toThrow();
  });
});

describe("validateSkillEntry", () => {
  test("accepts a fully valid pinned entry", () => {
    const entry = parseSkillEntry(`acme/skills@${SHA}`);
    expect(() => validateSkillEntry(entry)).not.toThrow();
  });

  test("rejects a pinned entry whose subpath escapes with `..`", () => {
    const entry: SkillEntry = {
      source: "https://github.com/acme/skills.git",
      name: "skills",
      sha: SHA,
      subpath: "../../etc",
    };
    expect(() => validateSkillEntry(entry)).toThrow(/\.\./);
  });

  test("rejects a valid name that is not pinned", () => {
    const entry = parseSkillEntry("acme/skills");
    expect(() => validateSkillEntry(entry)).toThrow(/required/);
  });
});

describe("readSkillName", () => {
  test("reads the name from a frontmatter block", () => {
    expect(readSkillName("---\nname: reviewer\ndescription: x\n---\nbody")).toBe(
      "reviewer",
    );
  });

  test("strips surrounding quotes", () => {
    expect(readSkillName('---\nname: "reviewer"\n---\n')).toBe("reviewer");
  });

  test("returns undefined when there is no frontmatter or no name", () => {
    expect(readSkillName("no frontmatter here")).toBeUndefined();
    expect(readSkillName("---\ndescription: x\n---\n")).toBeUndefined();
  });
});

/**
 * installSkill against a LOCAL git repository, never the network. The remote is
 * a bare repo we build in a temp dir, and HOME is pointed at another temp dir so
 * the clone lands under a throwaway ~/.kiro/skills — the same reason
 * test/agent-config.test.ts pins RUNNER_TEMP with withRunnerTemp.
 */
describe("installSkill against a local fixture", () => {
  let workspace: string;
  let remote: string;
  let fixtureSha: string;
  let previousHome: string | undefined;

  function git(args: string[], cwd: string): string {
    return execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    })
      .toString()
      .trim();
  }

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "skills-test-"));

    // Build a source repo that is a monorepo: a top-level SKILL.md named
    // "widget", a subpath skill at skills/reviewer named "reviewer", and an
    // unrelated sibling file that must NOT be copied into a subpath install.
    const src = join(workspace, "src");
    mkdirSync(src, { recursive: true });
    git(["init", "-q", "-b", "main"], src);
    writeFileSync(
      join(src, "SKILL.md"),
      "---\nname: widget\ndescription: a test skill\n---\nDo the thing.\n",
    );
    writeFileSync(join(src, "README.md"), "unrelated repo file\n");
    const reviewer = join(src, "skills", "reviewer");
    mkdirSync(reviewer, { recursive: true });
    writeFileSync(
      join(reviewer, "SKILL.md"),
      "---\nname: reviewer\ndescription: a nested skill\n---\nReview it.\n",
    );
    writeFileSync(join(reviewer, "extra.md"), "reviewer helper\n");
    git(["add", "."], src);
    git(["commit", "-q", "-m", "add skill"], src);
    fixtureSha = git(["rev-parse", "HEAD"], src);

    // A bare clone is the "remote" installSkill will clone and fetch from.
    remote = join(workspace, "remote.git");
    git(["clone", "-q", "--bare", src, remote], workspace);

    previousHome = process.env.HOME;
    process.env.HOME = join(workspace, "home");
    mkdirSync(process.env.HOME, { recursive: true });
  });

  afterAll(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(workspace, { recursive: true, force: true });
  });

  test("clones, checks out the sha, and verifies SKILL.md name matches", () => {
    const skillDir = installSkill({
      source: remote,
      name: "widget",
      sha: fixtureSha,
    });
    expect(skillDir).toBe(join(homedir(), ".kiro", "skills", "widget"));
    expect(skillDir.startsWith(homedir())).toBe(true);
    // SKILL.md must sit exactly one level down, where the loader glob
    // `skill://~/.kiro/skills/*/SKILL.md` matches it.
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    // The clone's `.git/` must not be copied into the installed skill folder.
    expect(existsSync(join(skillDir, ".git"))).toBe(false);
  });

  test("installs a subpath skill flat so SKILL.md lands where the glob loads it", () => {
    // A subpath entry: only the skills/reviewer folder is a skill. Before the
    // fix this installed to ~/.kiro/skills/reviewer/skills/reviewer/SKILL.md —
    // two levels too deep for the one-level glob — so the skill verified but was
    // never loaded. It must now land at ~/.kiro/skills/reviewer/SKILL.md. This
    // assertion fails if the flat-copy behaviour is reverted.
    const skillDir = installSkill({
      source: remote,
      name: "reviewer",
      sha: fixtureSha,
      subpath: "skills/reviewer",
    });
    expect(skillDir).toBe(join(homedir(), ".kiro", "skills", "reviewer"));
    // SKILL.md is exactly one level down, matching the glob.
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(readSkillName(readFileSync(join(skillDir, "SKILL.md"), "utf8"))).toBe(
      "reviewer",
    );
    // The nested skill's own sibling file comes along...
    expect(existsSync(join(skillDir, "extra.md"))).toBe(true);
    // ...but the repo's unrelated top-level files and the subpath layer do not.
    expect(existsSync(join(skillDir, "README.md"))).toBe(false);
    expect(existsSync(join(skillDir, "skills"))).toBe(false);
    expect(existsSync(join(skillDir, ".git"))).toBe(false);
  });

  test("throws when the frontmatter name does not match the folder", () => {
    expect(() =>
      installSkill({ source: remote, name: "mismatch", sha: fixtureSha }),
    ).toThrow(/must match the folder name/);
  });
});
