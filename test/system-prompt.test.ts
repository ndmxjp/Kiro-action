import { describe, expect, test } from "bun:test";
import {
  buildSystemPrompt,
  inlineCommentInstructions,
} from "../src/create-prompt";

describe("inline-comment instructions", () => {
  test("agent mode gets them in the system prompt only when asked", () => {
    const without = buildSystemPrompt("agent", ["git status …"]);
    const withTool = buildSystemPrompt("agent", ["git status …"], {
      inlineComments: true,
    });

    expect(without).not.toContain("create_inline_comment");
    expect(withTool).toContain("create_inline_comment");
    // No tracking comment in agent mode, so the verdict must not be sent there.
    expect(withTool).toContain("final answer");
    expect(withTool).not.toContain("tracking comment");
  });

  test("tag mode keeps them out of the system prompt (the task prompt has them)", () => {
    const prompt = buildSystemPrompt("tag", ["git status …"], {
      inlineComments: true,
    });

    expect(prompt).not.toContain("create_inline_comment");
  });

  test("the two variants differ only in where the summary goes", () => {
    const a = inlineCommentInstructions("tracking").split("\n");
    const b = inlineCommentInstructions("final-answer").split("\n");

    expect(a.length).toBe(b.length);
    const differing = a.filter((line: string, i: number) => line !== b[i]);
    expect(differing.length).toBe(1);
    expect(differing[0]).toContain("tracking comment");
  });

  test("both variants say what the tool cannot do", () => {
    for (const variant of ["tracking", "final-answer"] as const) {
      expect(inlineCommentInstructions(variant)).toContain(
        "does not let you approve",
      );
    }
  });
});
