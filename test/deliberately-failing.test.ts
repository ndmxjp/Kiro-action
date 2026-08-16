import { describe, expect, test } from "bun:test";

/**
 * Fails on purpose, so the pull request under test has a red check for the
 * github_ci MCP tools to report on. Delete along with the test PR.
 */
describe("deliberately failing check", () => {
  test("the branch prefix is spelled kiro/", () => {
    expect("claude/").toBe("kiro/");
  });
});
