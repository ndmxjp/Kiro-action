import * as core from "@actions/core";
import { spawn, type ChildProcess } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { redactAllSecrets } from "../github/utils/sanitizer";
import type { McpServers } from "../mcp/prepare-mcp-config";

/**
 * Per-argument size limit on Linux (MAX_ARG_STRLEN, 32 pages). A prompt built
 * from a large PR can exceed it, so anything close to the limit is handed over
 * as a file instead of as an argv element.
 */
const MAX_INLINE_PROMPT_BYTES = 96 * 1024;

/** Cap on how much CLI output is retained for the execution log. */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

/**
 * How long to wait for every MCP server this action provides to report
 * `connected` over `_kiro/mcp/status` before giving up. This replaces
 * `--require-mcp-startup`, which the CLI does not enforce on v3 (a run whose
 * github_comment server lost the startup race would otherwise exit 0 and report
 * nothing, the worst failure mode this action can have). On timeout the run is
 * failed loudly and mapped to `mcp_startup_failure`, so the entrypoint's
 * existing exit-code-3 handling applies.
 */
const MCP_CONNECT_TIMEOUT_MS = 120_000;

/**
 * CSI and OSC escape sequences, plus the single-character escapes the CLI's
 * progress rendering emits (cursor hide/show, colour resets).
 */
const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

/**
 * Removes terminal control sequences from captured output.
 *
 * `NO_COLOR`, `KIRO_LOG_NO_COLOR`, and `TERM=dumb` are all set for the child
 * process, and the CLI still emits colour and cursor-control sequences (verified
 * on a real run: 59 escape bytes in a 958-byte log). They make the execution
 * file and the job summary hard to read, so strip them at capture time.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export type KiroExitReason = "success" | "failure" | "mcp_startup_failure";

export type KiroRunResult = {
  exitCode: number;
  reason: KiroExitReason;
  /** Path to the captured, redacted CLI output. */
  outputFile: string;
  durationMs: number;
  timedOut: boolean;
};

/**
 * "text" keeps the committed `chat --no-interactive` invocation byte-for-byte.
 * "acp" selects the in-action progress renderer built on a minimal ACP client
 * (see runKiroAcp). Opt-in until the CLI's ACP surface is measured in CI across
 * both engines; the default must stay "text".
 */
export type KiroOutputFormat = "text" | "acp";

export type RunKiroParams = {
  kiroCommand: string;
  agentName: string;
  /** "v3" adds --v3, selecting the KAS agent engine. */
  engine: "v2" | "v3";
  /**
   * Treat this many seconds of silence as the run having finished — a safety net
   * for a CLI that stalls without exiting. Not the mechanism that ends a normal
   * v3 run: there the CLI exits by itself and it is the KAS server it leaves
   * behind that has to be cleaned up (see below).
   */
  idleTimeoutSeconds?: number;
  prompt: string;
  promptFile: string;
  outputFile: string;
  effort: string;
  requireMcpStartup: boolean;
  trustAllTools: boolean;
  extraArgs: string[];
  timeoutMinutes?: number;
  /**
   * Which surface to drive the CLI through. Defaults to "text" (the committed
   * `chat --no-interactive` path). "acp" selects the ACP client path.
   */
  outputFormat?: KiroOutputFormat;
  /**
   * MCP servers this action provides. Only used by the ACP path, which passes
   * them directly in `session/new` rather than through an agent profile or
   * `~/.kiro/settings/mcp.json`. The text path continues to source them from the
   * generated agent config, so this is ignored there.
   */
  mcpServers?: McpServers;
};

export async function runKiro(params: RunKiroParams): Promise<KiroRunResult> {
  if (params.outputFormat === "acp") {
    return runKiroAcp(params);
  }
  return runKiroText(params);
}

/**
 * The committed path: `kiro-cli chat --no-interactive [--v3] --agent <name> …`,
 * capturing stdout/stderr as text. Unchanged by the ACP work — the default input
 * value keeps this invocation byte-for-byte identical.
 */
async function runKiroText(params: RunKiroParams): Promise<KiroRunResult> {
  const {
    kiroCommand,
    agentName,
    engine,
    idleTimeoutSeconds,
    prompt,
    promptFile,
    outputFile,
    effort,
    requireMcpStartup,
    trustAllTools,
    extraArgs,
    timeoutMinutes,
  } = params;

  const message = await resolvePromptArgument(prompt, promptFile);

  const args = [
    "chat",
    "--no-interactive",
    ...(engine === "v3" ? ["--v3"] : []),
    "--agent",
    agentName,
    ...(requireMcpStartup ? ["--require-mcp-startup"] : []),
    ...(effort ? ["--effort", effort] : []),
    ...(trustAllTools ? ["--trust-all-tools"] : []),
    ...extraArgs,
    message,
  ];

  core.info(
    `Running: ${kiroCommand} ${args
      .slice(0, args.length - 1)
      .join(" ")} <prompt>`,
  );

  const startedAt = Date.now();

  // No shell: the prompt and every argument are passed straight to the binary,
  // so nothing in them can be reinterpreted as a shell command.
  // detached puts the CLI in its own process group, so the whole group can be
  // signalled at once. That matters because on v3 the CLI starts a KAS server as
  // a grandchild which outlives it: measured, the CLI printed its answer and
  // exited, and the server stayed up holding stdout. Signalling the CLI alone
  // does nothing (it is already gone), and leaving the group alive keeps this
  // process from exiting.
  const child = spawn(kiroCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });

  const captured: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let lastOutputAt = Date.now();

  const capture = (chunk: Buffer) => {
    if (capturedBytes < MAX_CAPTURED_BYTES) {
      captured.push(chunk);
      capturedBytes += chunk.byteLength;
    } else if (!truncated) {
      truncated = true;
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    lastOutputAt = Date.now();
    capture(chunk);
    process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    lastOutputAt = Date.now();
    capture(chunk);
    process.stderr.write(chunk);
  });

  const lifecycle = manageChildLifecycle(child, {
    timeoutMinutes,
    idleTimeoutSeconds,
    getLastOutputAt: () => lastOutputAt,
  });

  const { exitCode, timedOut, finishedByIdle } = await lifecycle;

  const durationMs = Date.now() - startedAt;

  let output = Buffer.concat(captured).toString("utf8");
  if (truncated) {
    output += "\n[output truncated by kiro-action: size limit reached]\n";
  }
  if (timedOut) {
    output += `\n[kiro-action: terminated after the ${timeoutMinutes} minute timeout]\n`;
  }
  if (finishedByIdle) {
    output += `\n[kiro-action: no output for ${idleTimeoutSeconds}s, so the CLI was shut down; the v3 engine does not exit on its own in headless mode]\n`;
  }

  await mkdir(dirname(outputFile), { recursive: true });
  // The log is written to disk and surfaced in the step summary, neither of
  // which is covered by GitHub's log masking, so redact before persisting.
  // Escape sequences are stripped as well: they survive NO_COLOR and make both
  // the file and the summary unreadable.
  await writeFile(outputFile, redactAllSecrets(stripAnsi(output)), "utf8");

  return {
    exitCode,
    // A run shut down after it went quiet had already produced its answer, so the
    // signal we sent must not be reported as the CLI failing.
    reason: finishedByIdle && !timedOut ? "success" : exitReason(exitCode),
    outputFile,
    durationMs,
    timedOut,
  };
}

/**
 * The ACP path: `kiro-cli acp --agent-engine <engine> --auth-method cli --agent
 * <name>`, driven as a minimal JSON-RPC-over-stdio client. Opt-in behind
 * `output_format: acp`.
 *
 * Why ACP rather than `--output-format stream-json`: ACP is the only surface
 * that reports MCP connection state (`_kiro/mcp/status`). v3 starts the turn
 * without waiting for MCP servers to connect and does not enforce
 * `--require-mcp-startup`, so a client that needs github_comment connected has to
 * watch that state itself. stream-json is the read-only projection of the same
 * events and omits it.
 *
 * Divergence from the text/v3 path, deliberately confined to this path: the MCP
 * servers are passed directly in `session/new.mcpServers`, so the ACP path does
 * NOT write `~/.kiro/settings/mcp.json` and does NOT rely on `includeMcpJson`.
 * The checkout's `.kiro/settings/mcp.json` is therefore never merged — one
 * attack surface gone. The existing chat/v3 path (mcp-json.ts + includeMcpJson in
 * agent-config.ts) is left untouched.
 */
async function runKiroAcp(params: RunKiroParams): Promise<KiroRunResult> {
  const {
    kiroCommand,
    agentName,
    engine,
    idleTimeoutSeconds,
    prompt,
    promptFile,
    outputFile,
    trustAllTools,
    extraArgs,
    timeoutMinutes,
    mcpServers = {},
    requireMcpStartup,
  } = params;

  // The prompt still needs writing to disk (large prompts are referenced by
  // path), and the return value is what goes into the session/prompt text.
  const message = await resolvePromptArgument(prompt, promptFile);

  const args = [
    "acp",
    "--agent-engine",
    engine,
    // Suppresses the v3 host-mediated auth request (_kiro/auth/getAccessToken),
    // which this non-interactive client cannot answer.
    "--auth-method",
    "cli",
    "--agent",
    agentName,
    ...(trustAllTools ? ["--trust-all-tools"] : []),
    ...extraArgs,
  ];

  core.info(`Running: ${kiroCommand} ${args.join(" ")} (ACP)`);

  const startedAt = Date.now();

  const child = spawn(kiroCommand, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
    detached: true,
  });

  // Raw JSONL capture and the human-readable rendered log are accumulated
  // separately: both are persisted, and both are redacted before they are.
  const rawLines: string[] = [];
  const rendered: string[] = [];
  let renderedBytes = 0;
  let truncated = false;
  let finalText: string | undefined;
  let lastOutputAt = Date.now();

  const appendRendered = (line: string) => {
    if (renderedBytes < MAX_CAPTURED_BYTES) {
      rendered.push(line);
      renderedBytes += Buffer.byteLength(line, "utf8");
    } else if (!truncated) {
      truncated = true;
    }
  };

  // The servers this run must see connected before it is safe to prompt. In tag
  // mode github_comment is here, so its failure to connect fails the run.
  const requiredServers = new Set(Object.keys(mcpServers));
  const connectedServers = new Set<string>();

  const client = new AcpClient(child);

  // Deny any permission request. The issue found session/request_permission never
  // arrived under an fs_read + mcp-allow profile and marks it unverified; deny is
  // the safe default and is logged so a real occurrence is visible.
  client.onRequest("session/request_permission", (rpcParams) => {
    core.warning(
      `ACP: denying an unexpected session/request_permission: ${JSON.stringify(
        rpcParams,
      )}`,
    );
    appendRendered(
      `[kiro-action: denied a permission request: ${JSON.stringify(rpcParams)}]\n`,
    );
    // The ACP "cancelled"/deny outcome: no option selected.
    return { outcome: { outcome: "cancelled" } };
  });

  // v3 sends this before anything else unless --auth-method cli suppresses it.
  // Answer defensively in case a build still emits it.
  client.onRequest("_kiro/auth/getAccessToken", () => {
    core.warning(
      "ACP: received _kiro/auth/getAccessToken despite --auth-method cli; returning no token",
    );
    return {};
  });

  client.onNotification("_kiro/mcp/status", (rpcParams) => {
    const record = rpcParams as {
      serverName?: string;
      name?: string;
      status?: string;
    };
    const name = record.serverName ?? record.name;
    const status = record.status;
    if (name) {
      appendRendered(`[mcp] ${name}: ${status}\n`);
      if (status === "connected") {
        connectedServers.add(name);
      }
    }
  });

  client.onNotification("session/update", (rpcParams) => {
    const update = (rpcParams as { update?: SessionUpdate }).update;
    const line = renderSessionUpdate(update);
    if (line) {
      appendRendered(line);
    }
    const chunkText = messageChunkText(update);
    if (chunkText !== undefined) {
      // The running answer is the concatenation of the agent message chunks;
      // runFinished.finalText (below) supersedes it when present.
      finalText = (finalText ?? "") + chunkText;
    }
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    lastOutputAt = Date.now();
    for (const line of client.feed(chunk)) {
      rawLines.push(line);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    // ACP puts logs on stderr; mirror them so the job log still shows them, but
    // do not treat them as protocol.
    lastOutputAt = Date.now();
    process.stderr.write(chunk);
  });

  // Track exit independently of the lifecycle promise: the connect wait and the
  // prompt request both have to give up the moment the child goes away (killed by
  // the idle net or the hard timeout), instead of blocking on their own timeout.
  let childExited = false;
  child.on("exit", () => {
    childExited = true;
  });

  const lifecycle = manageChildLifecycle(child, {
    timeoutMinutes,
    idleTimeoutSeconds,
    getLastOutputAt: () => lastOutputAt,
  });

  let mcpTimedOut = false;
  let protocolError: string | undefined;

  // Drive the protocol. Any failure here (including the MCP-connect timeout) is
  // caught: the child still has to be reaped by the lifecycle below, and the
  // captured output still has to be written.
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });

    const session = (await client.request("session/new", {
      cwd: process.cwd(),
      mcpServers: toAcpMcpServers(mcpServers),
    })) as { sessionId?: string };
    const sessionId = session?.sessionId;

    // Wait for every provided server to report connected. requireMcpStartup
    // carries hasMcpServers from the entrypoint; when there is nothing to wait
    // for, skip straight to the prompt.
    if (requiredServers.size > 0 && requireMcpStartup) {
      const connected = await waitForConnected(
        requiredServers,
        connectedServers,
        MCP_CONNECT_TIMEOUT_MS,
        () => childExited,
      );
      if (!connected) {
        mcpTimedOut = true;
        const missing = [...requiredServers].filter(
          (name) => !connectedServers.has(name),
        );
        appendRendered(
          `[kiro-action: MCP servers did not connect within ${
            MCP_CONNECT_TIMEOUT_MS / 1000
          }s: ${missing.join(", ")}]\n`,
        );
        throw new Error(
          `MCP servers never reported connected: ${missing.join(", ")}`,
        );
      }
    }

    await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: message }],
    });
  } catch (error) {
    if (!mcpTimedOut) {
      protocolError = error instanceof Error ? error.message : String(error);
      appendRendered(`[kiro-action: ACP error: ${protocolError}]\n`);
    }
  } finally {
    // Once the prompt turn is answered (or has failed), end the child so the
    // lifecycle resolves. The CLI may not exit on its own on v3, exactly as the
    // text path found; terminating the group covers that.
    client.terminate();
  }

  const { exitCode, timedOut, finishedByIdle } = await lifecycle;

  const durationMs = Date.now() - startedAt;

  // Rendered log: the human-readable projection, ending with the final answer.
  let renderedLog = rendered.join("");
  if (finalText !== undefined && finalText.length > 0) {
    renderedLog += `\n=== Final answer ===\n${finalText}\n`;
  }
  if (truncated) {
    renderedLog += "\n[output truncated by kiro-action: size limit reached]\n";
  }
  if (timedOut) {
    renderedLog += `\n[kiro-action: terminated after the ${timeoutMinutes} minute timeout]\n`;
  }
  if (finishedByIdle) {
    renderedLog += `\n[kiro-action: no output for ${idleTimeoutSeconds}s, so the CLI was shut down; the v3 engine does not exit on its own in headless mode]\n`;
  }

  // The execution file is the rendered log followed by the raw JSONL capture, so
  // a reader gets the answer first and the full protocol trace after. BOTH pass
  // through redactAllSecrets(stripAnsi(...)) before anything is persisted: the
  // process holds KIRO_API_KEY and neither the file nor the summary is covered by
  // GitHub's log masking.
  const rawCapture =
    rawLines.length > 0
      ? `\n=== Raw ACP stream (JSONL) ===\n${rawLines.join("\n")}\n`
      : "";
  const output = renderedLog + rawCapture;

  await mkdir(dirname(outputFile), { recursive: true });
  await writeFile(outputFile, redactAllSecrets(stripAnsi(output)), "utf8");

  // A never-connecting MCP server maps to mcp_startup_failure, so the
  // entrypoint's existing exit-code-3 handling and messaging apply. This is what
  // replaces --require-mcp-startup, which v3 does not enforce.
  let reason: KiroExitReason;
  if (mcpTimedOut) {
    reason = "mcp_startup_failure";
  } else if (finishedByIdle && !timedOut) {
    reason = "success";
  } else if (protocolError) {
    reason = "failure";
  } else {
    reason = exitReason(exitCode);
  }

  return {
    exitCode: mcpTimedOut ? 3 : exitCode,
    reason,
    outputFile,
    durationMs,
    timedOut,
  };
}

type LifecycleResult = {
  exitCode: number;
  timedOut: boolean;
  finishedByIdle: boolean;
};

/**
 * The process lifecycle shared by both paths, and the reason this action is safe
 * to run on v3 (Kiro#10877): the child is spawned detached so the whole process
 * group can be signalled; the run resolves on `exit`, not `close`, because a
 * surviving KAS grandchild holds the pipes open and `close` never fires; after
 * exit the group is signalled (SIGTERM then SIGKILL) and the stdio streams are
 * destroyed and unref'd so a leaked server cannot keep this process alive.
 * timeoutMinutes is a hard kill; idleTimeoutSeconds is the v3 safety net for a
 * CLI that answers and then never exits.
 */
function manageChildLifecycle(
  child: ChildProcess,
  opts: {
    timeoutMinutes?: number;
    idleTimeoutSeconds?: number;
    getLastOutputAt: () => number;
  },
): Promise<LifecycleResult> {
  const { timeoutMinutes, idleTimeoutSeconds, getLastOutputAt } = opts;

  let timedOut = false;
  let finishedByIdle = false;
  const timeouts: Array<ReturnType<typeof setTimeout>> = [];
  let idlePoll: ReturnType<typeof setInterval> | undefined;

  /** Signals the whole process group, so a grandchild cannot outlive the CLI. */
  const terminate = () => {
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone, or the group no longer exists.
      }
    };
    signalGroup("SIGTERM");
    timeouts.push(setTimeout(() => signalGroup("SIGKILL"), 10_000));
  };

  if (timeoutMinutes && timeoutMinutes > 0) {
    timeouts.push(
      setTimeout(() => {
        timedOut = true;
        core.warning(
          `Kiro CLI exceeded the ${timeoutMinutes} minute timeout; terminating it`,
        );
        terminate();
      }, timeoutMinutes * 60_000),
    );
  }

  if (idleTimeoutSeconds && idleTimeoutSeconds > 0) {
    const idleMs = idleTimeoutSeconds * 1000;
    idlePoll = setInterval(() => {
      if (Date.now() - getLastOutputAt() < idleMs) {
        return;
      }
      finishedByIdle = true;
      core.info(
        `Kiro CLI produced no output for ${idleTimeoutSeconds}s; treating the run as finished and shutting it down.`,
      );
      terminate();
    }, 1_000);
  }

  // Resolve on "exit" rather than "close": "close" additionally waits for the
  // stdio streams to end, and a surviving grandchild keeps them open forever.
  return new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // A signal death reports code === null; surface it as a failure unless the
      // signal was ours after the run had already finished.
      resolve(code ?? (signal ? 1 : 0));
    });
  })
    .finally(() => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
      if (idlePoll) {
        clearInterval(idlePoll);
      }
    })
    .then(async (exitCode) => {
      // Give output still in flight a moment to arrive: "exit" can fire before
      // the pipes have been drained.
      await new Promise((resolve) => setTimeout(resolve, 250));

      // Reap anything the CLI left behind, then let go of the pipes. Without this
      // the surviving KAS server keeps the stdio streams open, and an open stream
      // keeps this process alive: the action would finish all of its work and
      // then hang until the job timed out, which is exactly what happened before
      // this was here.
      terminate();
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.unref();

      return { exitCode, timedOut, finishedByIdle };
    });
}

/**
 * Kiro CLI exit codes: 0 success, 1 failure, 3 MCP server startup failure
 * (only reported when `--require-mcp-startup` is passed).
 */
function exitReason(exitCode: number): KiroExitReason {
  if (exitCode === 0) return "success";
  if (exitCode === 3) return "mcp_startup_failure";
  return "failure";
}

/**
 * Returns the message to pass on the command line. Large prompts are written to
 * a file and replaced with an instruction to read it, since a single argument
 * cannot exceed MAX_ARG_STRLEN.
 */
async function resolvePromptArgument(
  prompt: string,
  promptFile: string,
): Promise<string> {
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, prompt, "utf8");

  if (Buffer.byteLength(prompt, "utf8") <= MAX_INLINE_PROMPT_BYTES) {
    return prompt;
  }

  core.info(
    `Prompt is larger than ${MAX_INLINE_PROMPT_BYTES} bytes; passing it as a file (${promptFile})`,
  );
  return `Your instructions for this run are in the file ${promptFile}. Read that file first with the read tool, then carry out exactly what it says.`;
}

// ---------------------------------------------------------------------------
// Minimal ACP (Agent Client Protocol) client: JSON-RPC 2.0 over the child's
// stdin/stdout, one message per line. Hand-written on purpose — the surface used
// here is tiny (initialize, session/new, session/prompt, plus a handful of
// server-initiated requests and notifications), and pulling in a JSON-RPC
// library would add a dependency the sandbox cannot install.
// ---------------------------------------------------------------------------

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type SessionUpdate = {
  sessionUpdate?: string;
  content?: unknown;
  title?: string;
  status?: string;
  rawInput?: { command?: string };
  text?: string;
};

class AcpClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >();
  private readonly requestHandlers = new Map<
    string,
    (params: unknown) => unknown
  >();
  private readonly notificationHandlers = new Map<
    string,
    (params: unknown) => void
  >();

  constructor(private readonly child: ChildProcess) {}

  onRequest(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Sends a request and resolves with its result (or rejects on an error). */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(payload);
    });
  }

  /**
   * Feeds a stdout chunk into the line buffer, dispatches every complete line,
   * and returns those raw lines so the caller can persist them.
   */
  feed(chunk: Buffer): string[] {
    this.buffer += chunk.toString("utf8");
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        lines.push(line);
        this.dispatch(line);
      }
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  /** Rejects everything still outstanding; called when the child goes away. */
  terminate(): void {
    for (const [, entry] of this.pending) {
      entry.reject(new Error("ACP connection closed before a response arrived"));
    }
    this.pending.clear();
  }

  private dispatch(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      // Not JSON: a stray log line on stdout. Ignore it for protocol purposes;
      // it is still captured in the raw stream by the caller.
      return;
    }

    // A response to one of our requests.
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id as number);
      if (!entry) {
        return;
      }
      this.pending.delete(message.id as number);
      if (message.error) {
        entry.reject(
          new Error(
            `ACP ${message.error.message ?? "error"} (code ${
              message.error.code ?? "?"
            })`,
          ),
        );
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // A server-initiated request: reply with a result keyed by the same id.
    if (message.id !== undefined && message.method !== undefined) {
      const handler = this.requestHandlers.get(message.method);
      const result = handler ? handler(message.params) : {};
      this.send({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    // A notification.
    if (message.method !== undefined) {
      const handler = this.notificationHandlers.get(message.method);
      if (handler) {
        handler(message.params);
      }
    }
  }

  private send(payload: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // The child's stdin is gone; the pending requests will be rejected by
      // terminate().
    }
  }
}

/**
 * Polls until every required server is in the connected set, or the timeout
 * elapses. Returns whether they all connected.
 */
function waitForConnected(
  required: Set<string>,
  connected: Set<string>,
  timeoutMs: number,
  hasExited: () => boolean,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const allConnected = [...required].every((name) => connected.has(name));
      if (allConnected) {
        clearInterval(poll);
        resolve(true);
      } else if (hasExited() || Date.now() >= deadline) {
        // Give up early if the child died (killed by the idle net or the hard
        // timeout): there is nothing left that could report connected.
        clearInterval(poll);
        resolve(false);
      }
    }, 100);
  });
}

/** Renders one session/update event as a human-readable line, if it carries one. */
function renderSessionUpdate(update: SessionUpdate | undefined): string {
  if (!update) {
    return "";
  }
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return textOf(update.content);
    case "agent_thought_chunk": {
      const text = textOf(update.content);
      return text ? `[thinking] ${text}` : "";
    }
    case "tool_call": {
      const title = update.title ?? "tool";
      const command = update.rawInput?.command;
      return `[tool] ${title}${command ? `: ${command}` : ""}\n`;
    }
    case "tool_call_update": {
      const title = update.title ?? "tool";
      const status = update.status ?? "";
      const detail = textOf(update.content);
      const command = update.rawInput?.command;
      return `[tool] ${title} ${status}${command ? ` (${command})` : ""}${
        detail ? `: ${detail}` : ""
      }\n`;
    }
    default:
      return "";
  }
}

/** Returns the streamed text of a message chunk, or undefined for other events. */
function messageChunkText(
  update: SessionUpdate | undefined,
): string | undefined {
  if (!update || update.sessionUpdate !== "agent_message_chunk") {
    return undefined;
  }
  return textOf(update.content);
}

/**
 * Extracts text from an ACP `content` value, which is either a single content
 * block or an array of them. Non-text blocks contribute nothing.
 */
function textOf(content: unknown): string {
  if (content === undefined || content === null) {
    return "";
  }
  const blocks = Array.isArray(content) ? content : [content];
  let text = "";
  for (const block of blocks) {
    if (typeof block === "string") {
      text += block;
      continue;
    }
    if (typeof block === "object") {
      const record = block as {
        type?: string;
        text?: string;
        content?: unknown;
      };
      if (typeof record.text === "string") {
        text += record.text;
      } else if (record.content !== undefined) {
        // Nested { type: "content", content: { type: "text", text } } shape.
        text += textOf(record.content);
      }
    }
  }
  return text;
}

/**
 * Shapes this action's MCP servers into the `session/new.mcpServers` param. The
 * CLI accepts a stdio server passed here with origin "client"; every server this
 * action provides is a stdio `bun` subprocess.
 */
function toAcpMcpServers(servers: McpServers): Array<{
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}> {
  return Object.entries(servers).map(([name, config]) => ({
    name,
    command: config.command,
    args: config.args,
    env: Object.entries(config.env ?? {}).map(([key, value]) => ({
      name: key,
      value,
    })),
  }));
}
