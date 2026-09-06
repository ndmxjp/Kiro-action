import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import { KIRO_AGENT_NAME } from "../github/constants";
import type { McpServers } from "../mcp/prepare-mcp-config";
import type { AutoDetectedMode } from "../modes/detector";

/**
 * Hardened push wrapper. Pushing is done by the action itself, so this is only
 * reachable by a workflow that allows it explicitly; it exists because `git push`
 * with arbitrary arguments is remote code execution
 * (`git push --receive-pack='sh -c ...' ext::sh origin`), which is why the deny
 * list below blocks plain `git push`.
 *
 * Normalized with resolve(): `GITHUB_ACTION_PATH` ends in `/.` when the action
 * is used as `uses: ./`, which would otherwise yield a doubled slash.
 */
export const GIT_PUSH_WRAPPER = resolve(
  process.env.GITHUB_ACTION_PATH || ".",
  "scripts/git-push.sh",
);

/**
 * Read-only built-ins. `fs_read` is the canonical CLI 2.x name; the CLI accepts
 * the `read` alias too, but the canonical names are what its own docs use.
 */
const READ_TOOLS = ["fs_read", "grep", "glob"];

/** File-editing built-ins. */
const WRITE_TOOLS = ["fs_write", "code"];

/**
 * The shell tool. Present in `tools` but never in `allowedTools`, which is what
 * makes per-command scoping work.
 *
 * Measured on kiro-cli 2.18.1 in `--no-interactive` mode (see
 * .github/workflows/kiro-perm-probe.yml):
 *
 *   - Trusting a tool *overrides* its `toolsSettings`. Trusting `execute_bash`
 *     ran `curl` despite an `allowedCommands` list, and the CLI says so out loud:
 *     "You have trusted execute_bash tool, which overrides the toolsSettings".
 *     So the tool must stay untrusted for the settings to apply.
 *   - Left untrusted, `toolsSettings.shell` decides: `git status --short` ran and
 *     `curl` was refused, naming the rule it matched ("Blocked patterns:
 *     - curl .*"). Anything neither allowed nor auto-approved is refused with
 *     "non-interactive mode (no user to approve)".
 *
 * The patterns are regular expressions that the CLI anchors with \A and \z, and
 * look-around is not supported. Writing them as "^git status.*$" does not match —
 * that mistake is what made an earlier round of testing conclude, wrongly, that
 * scoping was impossible here.
 */
const SHELL_TOOL = "execute_bash";

/**
 * Read-only git commands the agent may always run, as command prefixes. They are
 * repo-scoped and side-effect free, and they are what lets it inspect a pull
 * request's own diff.
 *
 * Kept as prefixes because the two engines want different notations: v2 takes
 * anchored regexes, v3 takes globs.
 */
const DEFAULT_SHELL_PREFIXES = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git rev-parse",
  "git ls-files",
  "git branch",
];

/**
 * Commands refused regardless of what a workflow allows, since deny is evaluated
 * before allow.
 *
 * `git config` and `git remote` are here because the push URL carries the GitHub
 * token; `git push` because the wrapper script exists precisely to stop arbitrary
 * push arguments.
 */
const DENIED_SHELL_PREFIXES = [
  "curl",
  "wget",
  "sudo",
  "rm -rf",
  "nc",
  "ssh",
  "git push",
  "git config",
  "git remote",
];

/**
 * Translates a user-supplied command pattern into the regex form the CLI wants.
 *
 * The input is documented as glob-like ("bun test *") because that is what the
 * v3 engine takes; v2 takes anchored regexes, so metacharacters are escaped and
 * only `*` keeps its wildcard meaning.
 */
export function shellPatternToRegex(pattern: string): string {
  return pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
}

/**
 * A command prefix as a v2 regex: the bare command, or the command followed by
 * arguments. Written as `nc( .*)?` rather than `nc.*` so it cannot also match an
 * unrelated command that merely starts with those letters, like `ncdu`.
 */
function prefixToRegex(prefix: string): string {
  return `${shellPatternToRegex(prefix)}( .*)?`;
}

/** The same prefix as v3 globs, which have no alternation. */
function prefixToGlobs(prefix: string): string[] {
  return [prefix, `${prefix} *`];
}

export type ToolsSettings = {
  write?: { allowedPaths?: string[]; deniedPaths?: string[] };
  shell?: {
    allowedCommands?: string[];
    deniedCommands?: string[];
    denyByDefault?: boolean;
  };
};

export type AgentEngine = "v2" | "v3";

export type PermissionRule = {
  capability: string;
  match?: string[];
  effect: "allow" | "deny";
};

export type KiroAgentConfig = {
  name: string;
  description: string;
  prompt?: string;
  mcpServers: McpServers;
  tools: string[];
  /**
   * Tools usable without approval. In headless mode this is the effective
   * capability list: a tool absent from here cannot run at all.
   */
  allowedTools: string[];
  /**
   * Whether to merge the MCP servers declared in `~/.kiro/settings/mcp.json` and
   * `.kiro/settings/mcp.json`.
   *
   * False on v2, where the servers in `mcpServers` above are honoured directly
   * and merging would also pull in the checkout's copy — attacker-controlled on
   * a pull request, and a way to have arbitrary commands started.
   *
   * True on v3, which ignores `mcpServers` in an agent profile entirely: there
   * the servers are written to the user-scoped mcp.json instead (see
   * src/kiro/mcp-json.ts). The checkout's copy is merged too, which is why
   * restore-config replaces `.kiro/` from the base branch on pull requests.
   */
  includeMcpJson: boolean;
  /**
   * Per-command and per-path limits, honoured by the v2 engine for tools that are
   * *not* in `allowedTools`. Ignored by v3, which uses `permissions` instead.
   */
  toolsSettings?: ToolsSettings;
  /**
   * Capability rules, honoured only by the v3 agent engine. On v2 they are
   * ignored, which is why `allowedTools` above carries the real policy there.
   */
  permissions?: { rules: PermissionRule[] };
  model?: string;
};

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Paths outside the checkout that a run genuinely needs, all under the runner's
 * temp directory: the prompt file when it is too large to pass as an argument,
 * the CI logs the github_ci server downloads for the agent to read, and the file
 * the agent is asked to leave its commit message in. Everything else outside the
 * checkout stays refused.
 */
function runnerTempPaths(): string[] {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) {
    return [];
  }
  return [`${runnerTemp}/kiro-*`, `${runnerTemp}/github-ci-logs/**`];
}

export type BuildAgentConfigParams = {
  mode: AutoDetectedMode;
  engine: AgentEngine;
  mcpServers: McpServers;
  /** Comma-separated extra tool names from the `allowed_tools` input. */
  extraTools: string;
  /** Comma-separated shell patterns from `allowed_shell_commands`. */
  extraShellCommands: string;
  model: string;
  systemPrompt: string;
  /**
   * Emit BOTH the classic block (toolsSettings) AND the derived permissions
   * block in one profile, regardless of engine, instead of one schema per
   * engine.
   *
   * Off by default, so the committed behaviour is unchanged: v2 gets
   * toolsSettings only, v3 gets permissions only. The dual-block shape is the
   * source-derived target described below, but it is NOT YET MEASURED on
   * 2.21.1 in this repo's probe, so it stays off until
   * .github/workflows/kiro-perm-probe.yml confirms it.
   *
   * Source pointers (kiro-cli main / 2.21.1, from the issue follow-up comment):
   *   - `to_v3_compatible_str_pretty` (cli/agent/mod.rs:618-629): KAS ignores a
   *     config that carries the classic-only trust fields (allowedTools,
   *     toolsSettings) without a `permissions` block. This is the silent drop
   *     seen in kirodotdev/Kiro#10733, and it is INTENDED, not a bug.
   *   - `agent::agent_config::migration::migrate::upgrade_agent_config` derives
   *     the `permissions` block and V3 tool tags from the classic fields WHILE
   *     PRESERVING them, so both blocks in one profile is the intended
   *     dual-engine shape.
   *   - The classic engine uses `is_kas_only_agent_config` to detect KAS-only
   *     configs rather than hard-rejecting a dual-block one.
   *
   * The historical 2.18.1 measurement (v2 dropped a permissions-carrying
   * config) is why this is gated rather than flipped: the dual-block shape is
   * the MIGRATED shape (classic + derived permissions), which the source says
   * is accepted, and that has to be re-measured on 2.21.1 before it becomes the
   * default.
   */
  emitDualSchema?: boolean;
};

export function buildAgentConfig({
  mode,
  engine,
  mcpServers,
  extraTools,
  extraShellCommands,
  model,
  systemPrompt,
  emitDualSchema = false,
}: BuildAgentConfigParams): KiroAgentConfig {
  // `@server` grants every tool exposed by that MCP server. Verified on v2:
  // with `allowedTools: ["@probe"]` the server's tool was callable headlessly.
  const mcpToolNames = Object.keys(mcpServers).map((name) => `@${name}`);
  const extra = parseList(extraTools);
  const shellPatterns = parseList(extraShellCommands);

  // Available to the model, but scoped: the write tool by path and the shell tool
  // by command. Both are deliberately absent from `allowedTools` below, because
  // trusting a tool overrides the very settings that scope it.
  const tools = [
    ...READ_TOOLS,
    ...WRITE_TOOLS,
    SHELL_TOOL,
    ...mcpToolNames,
    ...extra,
  ];

  // Trusted outright: reading and searching, which are side-effect free, plus
  // this action's own MCP servers, whose tools do exactly one thing each.
  const trusted = [...READ_TOOLS, ...mcpToolNames, ...extra];

  // Both blocks are derived the same way whatever the emission choice, so the
  // dual-block path can never carry rules that disagree with the single-schema
  // path: the classic toolsSettings and the v3 permissions.rules are the two
  // renderings of one policy.
  const toolsSettings = buildV2ToolsSettings(shellPatterns);
  const permissions = {
    rules: buildV3Rules(shellPatterns, Object.keys(mcpServers)),
  };

  // Emission. The default is unchanged: one schema per engine (v2 ->
  // toolsSettings, v3 -> permissions), because the dual-block shape below is
  // source-derived and NOT YET MEASURED on 2.21.1 here (see emitDualSchema).
  // The dual-block path writes BOTH blocks in one profile so a single profile
  // works on both engines, which is the migrated shape the source describes.
  const schema = emitDualSchema
    ? { toolsSettings, permissions }
    : engine === "v3"
      ? { permissions }
      : { toolsSettings };

  return {
    name: KIRO_AGENT_NAME,
    description: `GitHub Actions agent (${mode} mode) created by kiro-action`,
    prompt: systemPrompt,
    mcpServers,
    tools: dedupe(tools),
    allowedTools: dedupe(trusted),
    includeMcpJson: engine === "v3",
    ...schema,
    ...(model ? { model } : {}),
  };
}

/**
 * Per-tool limits for the v2 engine, which enforces them for untrusted tools.
 *
 * Measured: with the write tool untrusted and `allowedPaths: ["./**"]`, a write
 * inside the checkout succeeded and one to /tmp was refused; with the shell tool
 * untrusted, `git status --short` and `git add` ran while `curl` was refused by
 * name. `denyByDefault` makes anything unlisted a refusal rather than a prompt,
 * which in headless mode is the same outcome but a clearer one.
 */
export function buildV2ToolsSettings(shellPatterns: string[]): ToolsSettings {
  return {
    // Confine writes to the checkout. Without this the agent could write to
    // $HOME, and from there to its own configuration.
    write: { allowedPaths: ["./**", ...runnerTempPaths()] },
    shell: {
      allowedCommands: [
        ...DEFAULT_SHELL_PREFIXES.map(prefixToRegex),
        ...shellPatterns.map(shellPatternToRegex),
      ],
      deniedCommands: DENIED_SHELL_PREFIXES.map(prefixToRegex),
      denyByDefault: true,
    },
  };
}

/**
 * Capability rules for the v3 engine, which — unlike v2 — enforces them.
 *
 * Measured on the v3 engine: `fs_write` scoped to `./**` blocked a write to
 * /tmp, a `shell` allow rule covered `git add`/`git commit` (neither is a v3
 * default), and a `shell` deny rule blocked `curl`, naming the agent profile as
 * its source.
 */
export function buildV3Rules(
  shellPatterns: string[],
  mcpServerNames: string[],
): PermissionRule[] {
  const rules: PermissionRule[] = [
    { capability: "fs_read", effect: "allow" },
    // Confine writes to the checkout. Without this the agent could write to
    // $HOME, which is how it would reach its own permission files.
    {
      capability: "fs_write",
      match: ["./**", ...runnerTempPaths()],
      effect: "allow",
    },
  ];

  // Only this action's own servers. Without the rule the tool call falls through
  // to an approval prompt, which is a denial in headless mode.
  if (mcpServerNames.length > 0) {
    rules.push({
      capability: "mcp",
      match: mcpServerNames.map((name) => `${name}/*`),
      effect: "allow",
    });
  }

  rules.push({
    capability: "shell",
    match: [...DEFAULT_SHELL_PREFIXES.flatMap(prefixToGlobs), ...shellPatterns],
    effect: "allow",
  });

  // Deny wins over allow in every scope, so these hold even if a workflow
  // allows a broad pattern such as "bash *".
  rules.push({
    capability: "shell",
    match: DENIED_SHELL_PREFIXES.flatMap(prefixToGlobs),
    effect: "deny",
  });

  return rules;
}

/**
 * The shell commands the agent will be able to run, for the prompt to quote.
 * Empty is impossible — the read-only git set is always granted.
 */
export function grantedShellCommands(extraShellCommands: string): string[] {
  return [
    ...DEFAULT_SHELL_PREFIXES.map((prefix) => `${prefix} …`),
    ...parseList(extraShellCommands),
  ];
}

/**
 * Whether the agent was handed an unrestricted shell, which only happens when a
 * workflow names the tool in `allowed_tools` and so bypasses the scoping.
 */
export function hasUnscopedShell(config: KiroAgentConfig): boolean {
  return config.allowedTools.some(
    (tool) => tool === SHELL_TOOL || tool === "shell",
  );
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

/**
 * Writes the agent config where the CLI looks up global agents.
 *
 * Deliberately *not* written into the repository's `.kiro/agents/`: that
 * directory lives inside the checked-out (untrusted) working tree, and a file
 * there would also be swept up by the `git add -A` this action makes later.
 */
export async function writeAgentConfig(
  config: KiroAgentConfig,
): Promise<string> {
  const agentDir = join(homedir(), ".kiro", "agents");
  await mkdir(agentDir, { recursive: true });

  const agentPath = join(agentDir, `${config.name}.json`);
  await writeFile(agentPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  console.log(`Wrote Kiro agent config to ${agentPath}`);
  return agentPath;
}
