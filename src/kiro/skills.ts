import * as core from "@actions/core";
import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { homedir, tmpdir } from "os";
import { basename, join, relative, resolve } from "path";

/**
 * Where the CLI looks for user-scoped skills. Skills are installed here, never
 * into the checkout: on a pull request the checkout is attacker-controlled, and
 * anything written there would also be swept into the agent's commit.
 */
export function skillsDir(): string {
  return join(homedir(), ".kiro", "skills");
}

/** The `resources` entry that makes a custom agent load the installed skills. */
export const SKILLS_RESOURCE = "skill://~/.kiro/skills/*/SKILL.md";

export type SkillSpec = {
  /** Original line, for messages. */
  raw: string;
  /** Clone URL, always https. */
  url: string;
  /** Full 40-hex commit to check out. */
  sha: string;
  /** Directory inside the repository to install from; "" is the root. */
  subdir: string;
};

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const GITHUB_SHORTHAND =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)@([0-9a-fA-F]+)(\/.*)?$/;

/**
 * Parses the `skills` input: one entry per line, either
 *
 *     owner/repo@<sha>[/path/inside]
 *     https://host/path.git#<sha>[/path/inside]
 *
 * A commit SHA is required. A tag or branch is code that can change under a
 * workflow that pins it, which is the same reason action.yml pins setup-bun by
 * commit; the check is strict (40 hex) so an abbreviated SHA cannot be spoofed by
 * a ref of the same shape.
 *
 * Only https is accepted. `git clone` will happily use `ext::` and other
 * transports that execute commands, so the scheme is checked here and enforced
 * again at clone time with `protocol.allow`.
 */
export function parseSkillSpecs(raw: string | undefined): SkillSpec[] {
  if (!raw?.trim()) {
    return [];
  }

  const specs: SkillSpec[] = [];
  for (const rawLine of raw.split("\n")) {
    // Normalise so fullwidth dots and Unicode slashes cannot smuggle a path
    // component past the checks below (same concern upstream documents).
    const line = rawLine.trim().normalize("NFC");
    if (!line) continue;

    if (/[\s\x00-\x1F\x7F]/.test(line)) {
      throw new Error(
        `skills: entry contains whitespace or control characters: ${JSON.stringify(line)}`,
      );
    }

    let url: string;
    let sha: string;
    let subdir: string;

    const shorthand = GITHUB_SHORTHAND.exec(line);
    if (shorthand) {
      const [, owner, repo, ref, path] = shorthand;
      url = `https://github.com/${owner}/${repo!.replace(/\.git$/, "")}.git`;
      sha = ref!;
      subdir = path ?? "";
    } else if (line.startsWith("https://")) {
      const hash = line.indexOf("#");
      if (hash < 0) {
        throw new Error(`skills: a URL entry needs #<commit-sha>: ${line}`);
      }
      url = line.slice(0, hash);
      const rest = line.slice(hash + 1);
      const slash = rest.indexOf("/");
      sha = slash < 0 ? rest : rest.slice(0, slash);
      subdir = slash < 0 ? "" : rest.slice(slash);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`skills: not a valid URL: ${url}`);
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
        throw new Error(`skills: only plain https URLs are accepted: ${url}`);
      }
    } else {
      throw new Error(
        `skills: expected owner/repo@<sha>[/path] or https://…#<sha>[/path], got: ${line}`,
      );
    }

    sha = sha.toLowerCase();
    if (!SHA_PATTERN.test(sha)) {
      throw new Error(
        `skills: a full 40-character commit SHA is required (tags and branches are not accepted): ${line}`,
      );
    }

    subdir = subdir.replace(/^\/+/, "").replace(/\/+$/, "");
    if (subdir.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(
        `skills: path must not contain . or .. segments: ${line}`,
      );
    }

    specs.push({ raw: line, url, sha, subdir });
  }
  return specs;
}

export type DiscoveredSkill = {
  /** Directory holding SKILL.md. */
  dir: string;
  /** Frontmatter `name`, which Kiro requires to match the install folder. */
  name: string;
};

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Reads the `name` out of a SKILL.md frontmatter block. */
export function readSkillName(skillMd: string, fallback: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  const frontmatter = match?.[1] ?? "";
  const nameLine = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter);
  const name = (nameLine?.[1] ?? fallback).trim();
  if (!SKILL_NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      `skill name must be lowercase letters, digits and hyphens (max 64), got ${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * Finds the skills in a checked-out directory. Two shapes are recognised:
 *
 *   - a Kiro skill: the directory itself holds SKILL.md;
 *   - a Claude Code plugin: skills live under `skills/` (or wherever
 *     `.claude-plugin/plugin.json` points its `skills` field), one directory per
 *     skill. Both formats follow the Agent Skills standard, which is why a
 *     plugin's skills work in Kiro unchanged.
 *
 * Everything else a plugin may carry is deliberately not installed, and the
 * caller is told what was skipped: hooks and .mcp.json would bypass this
 * action's control over what the CLI executes, bin/ would widen the shell, and
 * commands/ and agents/ are Claude-specific formats.
 */
export function discoverSkills(root: string): {
  skills: DiscoveredSkill[];
  ignored: string[];
} {
  const rootSkill = join(root, "SKILL.md");
  if (existsSync(rootSkill)) {
    return {
      skills: [
        {
          dir: root,
          name: readSkillName(readFileSync(rootSkill, "utf8"), basename(root)),
        },
      ],
      ignored: [],
    };
  }

  let skillsPath = "skills";
  const manifestPath = join(root, ".claude-plugin", "plugin.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      skills?: unknown;
    };
    if (typeof manifest.skills === "string") {
      skillsPath = manifest.skills;
    }
  }
  const skillsRoot = resolve(root, skillsPath);
  if (
    relative(root, skillsRoot).startsWith("..") ||
    !relative(root, skillsRoot)
  ) {
    throw new Error(
      `plugin.json "skills" must point inside the plugin, got ${skillsPath}`,
    );
  }

  const skills: DiscoveredSkill[] = [];
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot).sort()) {
      const dir = join(skillsRoot, entry);
      const skillMd = join(dir, "SKILL.md");
      if (statSync(dir).isDirectory() && existsSync(skillMd)) {
        skills.push({
          dir,
          name: readSkillName(readFileSync(skillMd, "utf8"), entry),
        });
      }
    }
  }

  const ignored = [
    "commands",
    "agents",
    "hooks",
    ".mcp.json",
    "bin",
    ".lsp.json",
  ].filter((name) => existsSync(join(root, name)));

  if (skills.length === 0) {
    throw new Error(
      `no skills found: expected SKILL.md at the root, or ${skillsPath}/*/SKILL.md`,
    );
  }
  return { skills, ignored };
}

/**
 * Rewrites `${CLAUDE_PLUGIN_ROOT}` to the skill's installed path in the
 * skill's markdown, so references to bundled scripts/ keep resolving. Only
 * markdown is touched; a byte-level substitution in scripts or binaries is not
 * something to do blind.
 */
export function rewritePluginRoot(dir: string, installedPath: string): number {
  let rewritten = 0;
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".md")) {
        const before = readFileSync(path, "utf8");
        if (before.includes("${CLAUDE_PLUGIN_ROOT}")) {
          writeFileSync(
            path,
            before.split("${CLAUDE_PLUGIN_ROOT}").join(installedPath),
          );
          rewritten += 1;
        }
      }
    }
  };
  walk(dir);
  return rewritten;
}

export type InstallOptions = {
  /** Where to install; defaults to ~/.kiro/skills. */
  destination?: string;
  /**
   * Git transports to allow. Defaults to https only. Tests pass ["file"] to
   * clone a local fixture; nothing in the action ever does.
   */
  allowedProtocols?: string[];
};

/**
 * Clones each spec at its SHA and installs the skills it contains.
 *
 * Fetching happens here, in the action, before the CLI starts: the agent never
 * gets network access for this. No shell is involved, and git is told which
 * transports it may use, so a URL cannot reach `ext::` or ssh even if the parser
 * were bypassed. GIT_TERMINAL_PROMPT=0 turns a URL that wants credentials into
 * an error instead of a job that hangs until it times out — the failure mode
 * restore-config guards against for .gitmodules.
 */
export function installSkills(
  specs: SkillSpec[],
  options: InstallOptions = {},
): string[] {
  if (specs.length === 0) {
    return [];
  }
  const destination = options.destination ?? skillsDir();
  const protocols = options.allowedProtocols ?? ["https"];
  mkdirSync(destination, { recursive: true });

  const installed: string[] = [];
  for (const spec of specs) {
    const work = mkdtempSync(join(tmpdir(), "kiro-skill-"));
    try {
      const git = (args: string[]) =>
        execFileSync(
          "git",
          [
            "-c",
            "protocol.allow=never",
            ...protocols.flatMap((p) => ["-c", `protocol.${p}.allow=always`]),
            ...args,
          ],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            encoding: "utf8",
          },
        );

      core.info(`Installing skills from ${spec.raw}`);
      git([
        "clone",
        "--quiet",
        "--depth",
        "1",
        "--no-recurse-submodules",
        "--",
        spec.url,
        work,
      ]);
      // A shallow clone only has the default branch; fetch the pinned commit
      // itself, then check it out so the tree is exactly what was named.
      git(["-C", work, "fetch", "--quiet", "--depth", "1", "origin", spec.sha]);
      git(["-C", work, "checkout", "--quiet", "--detach", spec.sha]);

      const root = spec.subdir ? join(work, spec.subdir) : work;
      if (!existsSync(root) || !statSync(root).isDirectory()) {
        throw new Error(
          `skills: ${spec.raw}: path ${spec.subdir} does not exist in the repository`,
        );
      }

      const { skills, ignored } = discoverSkills(root);
      if (ignored.length > 0) {
        core.warning(
          `skills: ${spec.raw} is a Claude Code plugin; only its skills are installed. Ignored: ${ignored.join(", ")}`,
        );
      }

      for (const skill of skills) {
        const target = join(destination, skill.name);
        if (existsSync(target)) {
          throw new Error(
            `skills: ${skill.name} from ${spec.raw} collides with a skill already installed at ${target}`,
          );
        }
        // Copy rather than move so the .git directory stays behind in the
        // temp dir and never lands where the CLI reads.
        cpSync(skill.dir, target, {
          recursive: true,
          filter: (source) => basename(source) !== ".git",
        });
        const rewritten = rewritePluginRoot(target, target);
        core.info(
          `Installed skill ${skill.name} -> ${target}` +
            (rewritten
              ? ` (rewrote \${CLAUDE_PLUGIN_ROOT} in ${rewritten} file(s))`
              : ""),
        );
        installed.push(skill.name);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return installed;
}
