import { describe, expect, test } from "bun:test";
import { checkContainsTrigger } from "../src/github/validation/trigger";
import type { ActionInputs, ParsedGitHubContext } from "../src/github/context";

const inputs: ActionInputs = {
  prompt: "",
  triggerPhrase: "@kiro",
  assigneeTrigger: "",
  labelTrigger: "kiro",
  branchPrefix: "kiro/",
  botId: "41898282",
  botName: "github-actions[bot]",
  allowedBots: "",
  trackProgress: false,
  useInlineComments: false,
  skills: "",
  includeCommentsByActor: "",
  excludeCommentsByActor: "",
  customInstructions: "",
  effort: "",
  model: "",
  allowedTools: "",
  allowedShellCommands: "",
  trustAllTools: false,
  agentEngine: "v2",
  workingIndicator: "",
};

function issueCommentContext(body: string): ParsedGitHubContext {
  return {
    runId: "1",
    eventName: "issue_comment",
    eventAction: "created",
    repository: { owner: "o", repo: "r", full_name: "o/r" },
    actor: "someone",
    inputs,
    entityNumber: 1,
    isPR: false,
    payload: {
      action: "created",
      comment: { body },
      issue: { number: 1 },
    } as unknown as ParsedGitHubContext["payload"],
  };
}

describe("checkContainsTrigger", () => {
  test("matches the trigger phrase as a standalone token", () => {
    expect(checkContainsTrigger(issueCommentContext("@kiro please help"))).toBe(
      true,
    );
  });

  test("matches at the end of a sentence", () => {
    expect(
      checkContainsTrigger(issueCommentContext("can you look, @kiro?")),
    ).toBe(true);
  });

  test("is case insensitive", () => {
    expect(checkContainsTrigger(issueCommentContext("@KIRO hi"))).toBe(true);
  });

  test("does not match a longer word", () => {
    expect(checkContainsTrigger(issueCommentContext("@kirodotdev hi"))).toBe(
      false,
    );
  });

  test("does not match inside an email address", () => {
    expect(checkContainsTrigger(issueCommentContext("mail me@kiro.dev"))).toBe(
      false,
    );
  });

  test("an explicit prompt always triggers", () => {
    const context = issueCommentContext("nothing here");
    context.inputs = { ...inputs, prompt: "do the thing" };
    expect(checkContainsTrigger(context)).toBe(true);
  });

  test("a matching label triggers on a labeled issue", () => {
    const context = issueCommentContext("");
    const labeled = {
      ...context,
      eventName: "issues" as const,
      eventAction: "labeled",
      payload: {
        action: "labeled",
        label: { name: "Kiro" },
        issue: { number: 1, body: "", title: "" },
      } as unknown as ParsedGitHubContext["payload"],
    };
    expect(checkContainsTrigger(labeled)).toBe(true);
  });

  test("a non-matching label does not trigger", () => {
    const context = issueCommentContext("");
    const labeled = {
      ...context,
      eventName: "issues" as const,
      eventAction: "labeled",
      payload: {
        action: "labeled",
        label: { name: "bug" },
        issue: { number: 1, body: "", title: "" },
      } as unknown as ParsedGitHubContext["payload"],
    };
    expect(checkContainsTrigger(labeled)).toBe(false);
  });
});
