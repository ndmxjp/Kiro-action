import { describe, expect, test } from "bun:test";
import {
  buildReviewCommentParams,
  InlineCommentBudget,
  MAX_INLINE_COMMENTS_PER_RUN,
} from "../src/github/operations/comments/inline-comment";

const target = {
  owner: "o",
  repo: "r",
  pullNumber: 7,
  headSha: "abc123",
};

describe("buildReviewCommentParams", () => {
  test("anchors a single line on the PR head by default", () => {
    const params = buildReviewCommentParams(
      { path: "src/a.ts", body: "nit", line: 12, side: "RIGHT" },
      target,
    );

    expect(params).toEqual({
      owner: "o",
      repo: "r",
      pull_number: 7,
      commit_id: "abc123",
      path: "src/a.ts",
      body: "nit",
      side: "RIGHT",
      line: 12,
    });
    // No range fields: GitHub rejects start_line when it equals line.
    expect("start_line" in params).toBe(false);
  });

  test("emits a range with start_side matching side", () => {
    const params = buildReviewCommentParams(
      { path: "a", body: "b", startLine: 3, line: 9, side: "LEFT" },
      target,
    );

    expect(params.start_line).toBe(3);
    expect(params.line).toBe(9);
    expect(params.start_side).toBe("LEFT");
  });

  test("collapses a range whose ends coincide to a single line", () => {
    const params = buildReviewCommentParams(
      { path: "a", body: "b", startLine: 5, line: 5, side: "RIGHT" },
      target,
    );

    expect(params.line).toBe(5);
    expect(params.start_line).toBeUndefined();
  });

  test("treats a lone startLine as the line, rather than failing", () => {
    const params = buildReviewCommentParams(
      { path: "a", body: "b", startLine: 4, side: "RIGHT" },
      target,
    );

    expect(params.line).toBe(4);
    expect(params.start_line).toBeUndefined();
  });

  test("prefers an explicit commit id over the head", () => {
    const params = buildReviewCommentParams(
      { path: "a", body: "b", line: 1, side: "RIGHT", commitId: "fff" },
      target,
    );

    expect(params.commit_id).toBe("fff");
  });

  test("rejects an inverted range with a message naming both numbers", () => {
    expect(() =>
      buildReviewCommentParams(
        { path: "a", body: "b", startLine: 9, line: 3, side: "RIGHT" },
        target,
      ),
    ).toThrow("startLine (9) must not be after line (3)");
  });

  test("rejects a comment with no anchor at all", () => {
    expect(() =>
      buildReviewCommentParams({ path: "a", body: "b", side: "RIGHT" }, target),
    ).toThrow("Provide line");
  });

  test("rejects an empty body, which sanitisation can produce", () => {
    // A body that was nothing but an HTML comment sanitises to "", and posting
    // that would leave an empty review comment on someone's diff.
    expect(() =>
      buildReviewCommentParams(
        { path: "a", body: "   ", line: 1, side: "RIGHT" },
        target,
      ),
    ).toThrow("body is empty");
  });

  test("rejects non-positive and fractional lines", () => {
    for (const line of [0, -1, 2.5]) {
      expect(() =>
        buildReviewCommentParams(
          { path: "a", body: "b", line, side: "RIGHT" },
          target,
        ),
      ).toThrow("positive integer");
    }
  });
});

describe("InlineCommentBudget", () => {
  test("allows exactly the cap, then refuses with the tracking-comment hint", () => {
    const budget = new InlineCommentBudget();

    for (let i = 0; i < MAX_INLINE_COMMENTS_PER_RUN; i++) {
      budget.take();
    }
    expect(budget.remaining).toBe(0);
    expect(() => budget.take()).toThrow("tracking comment");
  });

  test("reports what is left, so the agent can plan", () => {
    const budget = new InlineCommentBudget(3);

    budget.take();
    expect(budget.remaining).toBe(2);
  });

  test("the default cap is the documented number", () => {
    // The prompt and the docs quote this value; the test pins it so a change
    // here is a deliberate change there too.
    expect(MAX_INLINE_COMMENTS_PER_RUN).toBe(20);
  });
});
