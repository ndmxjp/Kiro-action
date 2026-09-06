import * as core from "@actions/core";
import { spawn } from "child_process";
import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import { redactAllSecrets } from "../github/utils/sanitizer";

/**
 * Per-argument size limit on Linux (MAX_ARG_STRLEN, 32 pages). A prompt built
 * from a large PR can exceed it, so anything close to the limit is handed over
 * as a file instead of as an argv element.
 */
const MAX_INLINE_PROMPT_BYTES = 96 * 1024;

/** Cap on how much CLI output is retained for the execution log. */
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

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

export type RunKiroParams = {
  kiroCommand: string;
  agentName: string;
  /**
   * Which agent engine to select, passed through verbatim as `--agent-engine
   * <engine>`.
   *
   * Passed explicitly rather than left to the CLI default because the default is
   * not what the flag's help text suggests: on kiro-cli 2.21.1
   * `default_engine_choice` (chat/mod.rs:700) returns V1 for a bare
   * `--no-interactive` / non-tty run unless a rollout feature is on, while
   * `--help` advertises v2. So a bare invocation ran on V1, which meant
   * `agent_engine: v2` in this action actually selected V1 in CLI terms. Naming
   * the engine removes the ambiguity, and stream-json (the follow-up on
   * kirodotdev/Kiro#5423) only runs on v2 or v3, so it has to be explicit anyway.
   * Source-derived from the issue comment's reading of kiro-cli main; the bare
   * run's effective engine is being confirmed by the new round in
   * .github/workflows/kiro-perm-probe.yml.
   *
   * 2.21.1 accepts `--agent-engine <v1|v2|v3>` alongside the older `--v3`
   * spelling; `--agent-engine` is preferred because it names every engine, not
   * only v3.
   */
  engine: "v2" | "v3";
  /**
   * Treat this many seconds of silence as the run having finished — a safety net
   * for a CLI that stalls without exiting. Not the mechanism that ends a normal
   * run on any engine; it exists because kiro-cli 2.18.1's v3 engine left a KAS
   * server behind that held the pipes (kirodotdev/Kiro#10877), and a run that
   * has gone quiet is the only signal this process would have had. Fixed in
   * 2.21.1 (kiro-team/kiro-cli#4293), kept as a guard against a regression.
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
};

export async function runKiro(params: RunKiroParams): Promise<KiroRunResult> {
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
    // Name the engine outright: a bare --no-interactive run selects V1 (see the
    // engine doc on RunKiroParams), so relying on the default would have run on
    // an engine no one asked for. `--agent-engine` is the 2.21.1 spelling that
    // covers v1/v2/v3; the older `--v3` only names one of them.
    "--agent-engine",
    engine,
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
  // signalled at once. That mattered on kiro-cli 2.18.1, whose v3 engine started
  // a KAS server as a grandchild that outlived it: measured, the CLI printed its
  // answer and exited, and the server stayed up holding stdout. Signalling the
  // CLI alone did nothing (it was already gone), and leaving the group alive kept
  // this process from exiting. 2.21.1 fixed the leak (kirodotdev/Kiro#10877;
  // measured here: --no-interactive --v3 exits in ~10 s with nothing left
  // behind). The group handling stays because it is cheap, harmless on a fixed
  // CLI, and the only defence if the leak comes back or an older CLI is pinned.
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

  child.stdout.on("data", (chunk: Buffer) => {
    lastOutputAt = Date.now();
    capture(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    lastOutputAt = Date.now();
    capture(chunk);
    process.stderr.write(chunk);
  });

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
      if (Date.now() - lastOutputAt < idleMs) {
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
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      // A signal death reports code === null; surface it as a failure unless the
      // signal was ours after the run had already finished.
      resolve(code ?? (signal ? 1 : 0));
    });
  }).finally(() => {
    for (const timeout of timeouts) {
      clearTimeout(timeout);
    }
    if (idlePoll) {
      clearInterval(idlePoll);
    }
  });

  // Give output still in flight a moment to arrive: "exit" can fire before the
  // pipes have been drained.
  await new Promise((resolve) => setTimeout(resolve, 250));

  // Reap anything the CLI left behind, then let go of the pipes. On 2.18.1's v3
  // the surviving KAS server kept the stdio streams open, and an open stream
  // keeps this process alive: the action finished all of its work and then hung
  // until the job timed out, which is exactly what happened before this was
  // here. Harmless when there is nothing to reap.
  terminate();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();

  const durationMs = Date.now() - startedAt;

  let output = Buffer.concat(captured).toString("utf8");
  if (truncated) {
    output += "\n[output truncated by kiro-action: size limit reached]\n";
  }
  if (timedOut) {
    output += `\n[kiro-action: terminated after the ${timeoutMinutes} minute timeout]\n`;
  }
  if (finishedByIdle) {
    output += `\n[kiro-action: no output for ${idleTimeoutSeconds}s, so the CLI was shut down; this is a safety net for a CLI that stalls after answering]\n`;
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
