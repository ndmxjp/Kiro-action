import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runKiro } from "../src/kiro/run";
import type { McpServers } from "../src/mcp/prepare-mcp-config";

/**
 * Exercises the ACP client path with a stand-in for `kiro-cli acp`. The fake is a
 * shell script that speaks the same JSON-RPC-over-stdio the real CLI does: it
 * reads request lines on stdin and emits scripted response and notification lines
 * on stdout. This keeps the tests hermetic — no network, no real kiro-cli.
 *
 * The fake dispatches on the request method rather than on ids, so it does not
 * depend on the client's id numbering. Every helper below composes one such
 * script.
 */
function fakeAcpCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kiro-acp-test-"));
  const path = join(dir, "fake-acp.sh");
  // The loop reads each request line and reacts. `printf` writes single lines so
  // the client's line-buffered reader sees one JSON object per line.
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function paths() {
  const dir = mkdtempSync(join(tmpdir(), "kiro-acp-io-"));
  return {
    promptFile: join(dir, "prompt.txt"),
    outputFile: join(dir, "output.txt"),
  };
}

const base = {
  kiroCommand: "unused",
  agentName: "kiro-action",
  engine: "v3" as const,
  prompt: "do the thing",
  effort: "",
  requireMcpStartup: true,
  trustAllTools: false,
  extraArgs: [],
  outputFormat: "acp" as const,
};

const commentServer: McpServers = {
  github_comment: {
    command: "bun",
    args: ["run", "server.ts"],
    env: { GITHUB_TOKEN: "x" },
  },
};

/**
 * A fake that answers each request and, when it sees session/prompt, streams a
 * couple of chunks and a runFinished before exiting. `$STATUS` controls whether
 * the server ever reaches `connected`.
 */
function scriptedAcp({
  status,
  chunk,
  exitAfter = true,
}: {
  status: "connected" | "connecting-only";
  chunk: string;
  exitAfter?: boolean;
}): string {
  const emitConnected =
    status === "connected"
      ? `printf '%s\\n' '{"jsonrpc":"2.0","method":"_kiro/mcp/status","params":{"serverName":"github_comment","status":"connected","toolCount":1}}'`
      : `: # never reaches connected`;

  const tail = exitAfter ? "exit 0" : "sleep 600";

  // Read requests line by line. For each, look at the method and respond.
  return `
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{}}}'
      ;;
    *'"method":"session/new"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"sess-1"}}'
      printf '%s\\n' '{"jsonrpc":"2.0","method":"_kiro/mcp/status","params":{"serverName":"github_comment","status":"connecting"}}'
      ${emitConnected}
      ;;
    *'"method":"session/prompt"'*)
      printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"${chunk}"}}}}'
      printf '%s\\n' '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"shell","rawInput":{"command":"git status"}}}}'
      printf '%s\\n' '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}'
      ${tail}
      ;;
  esac
done
`;
}

describe("runKiro ACP path", () => {
  test("waits for connected, then renders the streamed answer into outputFile", async () => {
    const { promptFile, outputFile } = paths();

    const result = await runKiro({
      ...base,
      kiroCommand: fakeAcpCli(
        scriptedAcp({ status: "connected", chunk: "the final answer" }),
      ),
      promptFile,
      outputFile,
      mcpServers: commentServer,
      idleTimeoutSeconds: 5,
    });

    expect(result.reason).toBe("success");
    const output = readFileSync(outputFile, "utf8");
    expect(output).toContain("the final answer");
    // The tool call is rendered into the human-readable log.
    expect(output).toContain("git status");
    // The raw JSONL capture is persisted too.
    expect(output).toContain('"sessionUpdate":"agent_message_chunk"');
  });

  test("fails loudly and maps to mcp_startup_failure when a server never connects", async () => {
    const { promptFile, outputFile } = paths();
    const startedAt = Date.now();

    // Shorten the wait by relying on the idle-timeout net rather than the full
    // MCP-connect timeout: the fake stalls (never connects, never exits), and the
    // client should still resolve. We assert the reason maps correctly by using a
    // fake that connects nothing but exits on its own after the prompt is never
    // sent — instead, drive the mcp timeout directly with a short-lived fake.
    const result = await runKiro({
      ...base,
      kiroCommand: fakeAcpCli(
        // Answers initialize + session/new, emits only "connecting", then idles.
        // The client waits for connected, times out, and terminates the group.
        scriptedAcp({
          status: "connecting-only",
          chunk: "unused",
          exitAfter: false,
        }),
      ),
      promptFile,
      outputFile,
      mcpServers: commentServer,
      // The idle net ends the child; the MCP-connect wait is what sets the
      // reason. Keep the test bounded.
      idleTimeoutSeconds: 2,
      timeoutMinutes: 20 / 60,
    });

    expect(Date.now() - startedAt).toBeLessThan(60_000);
    expect(result.reason).toBe("mcp_startup_failure");
    expect(readFileSync(outputFile, "utf8")).toContain("did not connect");
  }, 70_000);

  test("redacts a planted secret from both the rendered log and the raw JSONL", async () => {
    const { promptFile, outputFile } = paths();

    const result = await runKiro({
      ...base,
      kiroCommand: fakeAcpCli(
        scriptedAcp({
          status: "connected",
          chunk: "leaking ksk_abcdef0123456789 now",
        }),
      ),
      promptFile,
      outputFile,
      mcpServers: commentServer,
      idleTimeoutSeconds: 5,
    });

    expect(result.reason).toBe("success");
    const output = readFileSync(outputFile, "utf8");
    expect(output).not.toContain("ksk_abcdef0123456789");
    expect(output).toContain("[REDACTED_API_KEY]");
  });

  test("returns promptly when the fake leaves a background child holding the pipes", async () => {
    const { promptFile, outputFile } = paths();
    const startedAt = Date.now();

    // The KAS-leak shape: a background child inherits stdout and outlives the
    // parent. Resolving on "exit" (not "close") is what keeps this from hanging.
    const leaky = `
sleep 600 &
${scriptedAcp({ status: "connected", chunk: "answered then leaked" })}
`;

    const result = await runKiro({
      ...base,
      kiroCommand: fakeAcpCli(leaky),
      promptFile,
      outputFile,
      mcpServers: commentServer,
    });

    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(result.reason).toBe("success");
    expect(readFileSync(outputFile, "utf8")).toContain("answered then leaked");
  });

  test("does not wait for MCP when there are no servers to wait for", async () => {
    const { promptFile, outputFile } = paths();

    const result = await runKiro({
      ...base,
      kiroCommand: fakeAcpCli(
        scriptedAcp({ status: "connecting-only", chunk: "answer with no mcp" }),
      ),
      promptFile,
      outputFile,
      // No servers provided, so the connect wait is skipped entirely.
      mcpServers: {},
      requireMcpStartup: false,
      idleTimeoutSeconds: 5,
    });

    expect(result.reason).toBe("success");
    expect(readFileSync(outputFile, "utf8")).toContain("answer with no mcp");
  });
});

describe("runKiro default (text) path", () => {
  test("the default output_format is the current chat invocation, not acp", async () => {
    const { promptFile, outputFile } = paths();

    // The fake echoes its own argv, so what the CLI would have received lands in
    // the captured output. No outputFormat is set, so the text path is taken.
    const dir = mkdtempSync(join(tmpdir(), "kiro-acp-argv-"));
    const cli = join(dir, "fake.sh");
    writeFileSync(cli, '#!/bin/sh\necho "argv: $@"\nexit 0\n');
    chmodSync(cli, 0o755);

    const result = await runKiro({
      kiroCommand: cli,
      agentName: "kiro-action",
      engine: "v3",
      prompt: "do the thing",
      promptFile,
      outputFile,
      effort: "",
      requireMcpStartup: false,
      trustAllTools: false,
      extraArgs: [],
    });

    const output = readFileSync(outputFile, "utf8");
    expect(result.reason).toBe("success");
    expect(output).toContain("chat --no-interactive");
    expect(output).not.toContain("acp");
  });
});
