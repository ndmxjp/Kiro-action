import { describe, expect, test } from "bun:test";
import {
  buildAgentConfig,
  grantedShellCommands,
  hasUnscopedShell,
  shellPatternToRegex,
  type BuildAgentConfigParams,
} from "../src/kiro/agent-config";
import { parseAdditionalPermissions } from "../src/github/token";

const mcpServers = {
  github_comment: { command: "bun", args: ["run", "server.ts"] },
};

function config(overrides: Partial<BuildAgentConfigParams> = {}) {
  return buildAgentConfig({
    mode: "tag",
    mcpServers,
    extraTools: "",
    extraShellCommands: "",
    model: "",
    systemPrompt: "be helpful",
    ...overrides,
  });
}

/**
 * Runs `body` with RUNNER_TEMP set to `value`, or unset when that is undefined.
 *
 * The write policy is derived from RUNNER_TEMP, and a GitHub runner always sets
 * it while a developer's shell does not — so a test that leaves it to the
 * environment passes locally and fails in CI.
 */
function withRunnerTemp<T>(value: string | undefined, body: () => T): T {
  const previous = process.env.RUNNER_TEMP;
  if (value === undefined) {
    delete process.env.RUNNER_TEMP;
  } else {
    process.env.RUNNER_TEMP = value;
  }
  try {
    return body();
  } finally {
    if (previous === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = previous;
    }
  }
}

describe("buildAgentConfig, classic-engine fields", () => {
  test("grants the MCP servers it was given, and never merges repo MCP config", () => {
    // Both engines read `mcpServers` from the profile (v3 measured on 2.29.1),
    // so mcp.json is never merged: the checkout's copy is attacker-controlled.
    const built = config();

    expect(built.tools).toContain("@github_comment");
    expect(built.allowedTools).toContain("@github_comment");
    expect(built.includeMcpJson).toBe(false);
    expect(built.mcpServers).toBe(mcpServers);
  });

  test("leaves write and shell untrusted, which is what makes scoping apply", () => {
    // Measured: trusting a tool overrides its toolsSettings, and the CLI warns
    // "You have trusted execute_bash tool, which overrides the toolsSettings".
    const built = config();

    expect(built.tools).toContain("fs_write");
    expect(built.tools).toContain("execute_bash");
    expect(built.allowedTools).not.toContain("fs_write");
    expect(built.allowedTools).not.toContain("execute_bash");
    expect(hasUnscopedShell(built)).toBe(false);
  });

  test("confines writes to the checkout and the runner paths a run needs", () => {
    // The agent is asked to leave its commit message under RUNNER_TEMP, and to
    // read CI logs downloaded there, so those paths have to be allowed too —
    // otherwise the instruction is one the tool policy refuses.
    const write = withRunnerTemp(
      "/tmp/runner",
      () => config().toolsSettings?.write,
    );

    expect(write).toEqual({
      allowedPaths: [
        "./**",
        "/tmp/runner/kiro-*",
        "/tmp/runner/github-ci-logs/**",
      ],
    });
  });

  test("confines writes to the checkout when there is no runner temp", () => {
    const write = withRunnerTemp(
      undefined,
      () => config().toolsSettings?.write,
    );

    expect(write).toEqual({ allowedPaths: ["./**"] });
  });

  test("allows read-only git and denies the dangerous commands", () => {
    const shell = config().toolsSettings?.shell;

    expect(shell?.allowedCommands).toContain("git status( .*)?");
    expect(shell?.allowedCommands).toContain("git diff( .*)?");
    expect(shell?.denyByDefault).toBe(true);
    expect(shell?.deniedCommands).toContain("curl( .*)?");
    // The push URL carries the token, and the wrapper exists to stop arbitrary
    // push arguments.
    expect(shell?.deniedCommands).toContain("git push( .*)?");
    expect(shell?.deniedCommands).toContain("git config( .*)?");
  });

  test("honours allowed_shell_commands, translated to the regex form", () => {
    const shell = config({
      extraShellCommands: "bun test *, bun run build",
    }).toolsSettings?.shell;

    expect(shell?.allowedCommands).toContain("bun test .*");
    expect(shell?.allowedCommands).toContain("bun run build");
  });

  test("carries both schemas, so one profile serves either engine", () => {
    // kiro-cli 2.18.1's classic engine dropped a profile that carried
    // `permissions`; `kiro-cli agent upgrade` now writes exactly this dual shape
    // and it loaded on both engines on 2.29.1. The two blocks must describe the
    // same policy.
    const built = config({ extraShellCommands: "bun test *" });

    expect(built.toolsSettings.shell?.allowedCommands).toContain("bun test .*");
    const allow = built.permissions.rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "allow",
    );
    expect(allow?.match).toContain("bun test *");
  });

  test("still hands over an unrestricted shell if a workflow insists", () => {
    const built = config({ extraTools: "execute_bash" });

    expect(hasUnscopedShell(built)).toBe(true);
  });
});

describe("shellPatternToRegex", () => {
  test("turns a glob into an anchored-regex equivalent", () => {
    expect(shellPatternToRegex("bun test *")).toBe("bun test .*");
  });

  test("escapes regex metacharacters that appear in real commands", () => {
    expect(shellPatternToRegex("npm run build:prod")).toBe(
      "npm run build:prod",
    );
    expect(shellPatternToRegex("grep -E (a|b) *")).toBe(
      "grep -E \\(a\\|b\\) .*",
    );
  });

  test("does not add its own anchors, which the CLI supplies", () => {
    const pattern = shellPatternToRegex("git status *");
    expect(pattern.startsWith("^")).toBe(false);
    expect(pattern.endsWith("$")).toBe(false);
  });
});

describe("grantedShellCommands", () => {
  test("always includes the read-only git set", () => {
    expect(grantedShellCommands("")).toContain("git status …");
  });

  test("appends what the workflow allowed, for the prompt to quote", () => {
    expect(grantedShellCommands("bun test *")).toContain("bun test *");
  });
});

describe("buildAgentConfig, v3 permission rules", () => {
  test("allows this action's own MCP servers", () => {
    const rules = config().permissions.rules;
    const mcp = rules.find((rule) => rule.capability === "mcp");

    expect(mcp).toEqual({
      capability: "mcp",
      match: ["github_comment/*"],
      effect: "allow",
    });
  });

  test("adds no mcp rule when there are no servers", () => {
    const rules = config({ mcpServers: {} }).permissions.rules;

    expect(rules.some((rule) => rule.capability === "mcp")).toBe(false);
  });

  test("confines writes to the checkout and the runner paths a run needs", () => {
    const writeRule = (runnerTemp: string | undefined) =>
      withRunnerTemp(runnerTemp, () =>
        config().permissions.rules.find(
          (rule) => rule.capability === "fs_write",
        ),
      );

    expect(writeRule("/tmp/runner")).toEqual({
      capability: "fs_write",
      match: ["./**", "/tmp/runner/kiro-*", "/tmp/runner/github-ci-logs/**"],
      effect: "allow",
    });

    expect(writeRule(undefined)).toEqual({
      capability: "fs_write",
      match: ["./**"],
      effect: "allow",
    });
  });

  test("honours allowed_shell_commands and grants the shell tool", () => {
    const built = config({
      extraShellCommands: "bun test *, git add *",
    });
    const rules = built.permissions.rules;
    const allow = rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "allow",
    );

    expect(allow?.match).toContain("bun test *");
    expect(allow?.match).toContain("git add *");
    expect(allow?.match).toContain("git status *");
    // On v3 the rules do the scoping, so the tool still is not trusted outright.
    expect(hasUnscopedShell(built)).toBe(false);
  });

  test("allows the read-only git set even with nothing configured", () => {
    const rules = config().permissions.rules;
    const allow = rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "allow",
    );

    expect(allow?.match).toContain("git status");
    expect(allow?.match).toContain("git status *");
    expect(allow?.match).toContain("git diff *");
  });

  test("always denies the dangerous commands, since deny outranks allow", () => {
    const rules = config({ extraShellCommands: "bash *" }).permissions.rules;
    const deny = rules.find(
      (rule) => rule.capability === "shell" && rule.effect === "deny",
    );

    expect(deny?.match).toContain("curl *");
    expect(deny?.match).toContain("sudo *");
    expect(deny?.match).toContain("rm -rf *");
    expect(deny?.match).toContain("git push *");
  });
});

describe("installed skills", () => {
  test("are listed as a resource only when something was installed", () => {
    expect(config({ hasSkills: true }).resources).toEqual([
      "skill://~/.kiro/skills/*/SKILL.md",
    ]);
    expect("resources" in config()).toBe(false);
  });

  test("get a skill capability rule, which v3 needs to activate them", () => {
    // Measured on 2.29.1: the skill was listed from `resources`, but loading it
    // (`disclose_context`) was refused until a `skill` allow rule existed.
    const skill = (rules: { capability: string; effect: string }[]) =>
      rules.find((rule) => rule.capability === "skill");

    expect(skill(config({ hasSkills: true }).permissions.rules)).toEqual({
      capability: "skill",
      effect: "allow",
    });
    expect(skill(config().permissions.rules)).toBeUndefined();
  });
});

describe("the model input", () => {
  test("records the model in the agent config", () => {
    // The model goes through the agent profile rather than a CLI flag, so it is
    // set the same way whichever engine runs the profile.
    expect(config({ model: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
  });

  test("omits the key entirely when nothing is configured", () => {
    // Absent, not null or empty: the CLI picks its own default only when the
    // field is missing, and an empty string would be a model name it cannot
    // resolve.
    const built = config({ model: "" });

    expect(built.model).toBeUndefined();
    expect("model" in built).toBe(false);
    expect(JSON.parse(JSON.stringify(built))).not.toHaveProperty("model");
  });
});

describe("parseAdditionalPermissions", () => {
  test("returns the defaults when nothing is configured", () => {
    expect(parseAdditionalPermissions(undefined)).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
    });
  });

  test("merges configured permissions over the defaults", () => {
    expect(parseAdditionalPermissions("actions: read\ncontents: read")).toEqual(
      {
        contents: "read",
        pull_requests: "write",
        issues: "write",
        actions: "read",
      },
    );
  });

  test("ignores malformed lines", () => {
    expect(parseAdditionalPermissions("nonsense\n\nactions: read")).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      actions: "read",
    });
  });
});
