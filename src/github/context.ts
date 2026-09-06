import * as github from "@actions/github";
import type {
  IssuesEvent,
  IssuesAssignedEvent,
  IssueCommentEvent,
  PullRequestEvent,
  PullRequestReviewEvent,
  PullRequestReviewCommentEvent,
  WorkflowRunEvent,
} from "@octokit/webhooks-types";
import {
  DEFAULT_BOT_ID,
  DEFAULT_BOT_LOGIN,
  DEFAULT_BRANCH_PREFIX,
  DEFAULT_TRIGGER_PHRASE,
} from "./constants";

// Custom types for GitHub Actions events that aren't webhooks
export type WorkflowDispatchEvent = {
  action?: never;
  inputs?: Record<string, unknown>;
  ref?: string;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
  };
  workflow: string;
};

export type RepositoryDispatchEvent = {
  action: string;
  client_payload?: Record<string, unknown>;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
  sender: {
    login: string;
  };
};

export type ScheduleEvent = {
  action?: never;
  schedule?: string;
  repository: {
    name: string;
    owner: {
      login: string;
    };
  };
};

const ENTITY_EVENT_NAMES = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
] as const;

const AUTOMATION_EVENT_NAMES = [
  "workflow_dispatch",
  "repository_dispatch",
  "schedule",
  "workflow_run",
] as const;

type EntityEventName = (typeof ENTITY_EVENT_NAMES)[number];
type AutomationEventName = (typeof AUTOMATION_EVENT_NAMES)[number];

export type ActionInputs = {
  prompt: string;
  triggerPhrase: string;
  assigneeTrigger: string;
  labelTrigger: string;
  baseBranch?: string;
  branchPrefix: string;
  branchNameTemplate?: string;
  botId: string;
  botName: string;
  allowedBots: string;
  trackProgress: boolean;
  /**
   * Pull requests only: adds the github_inline_comment MCP server, whose single
   * tool posts review comments on diff lines. Off by default because it turns
   * one writable channel into many, and a conversational run has no use for it.
   */
  useInlineComments: boolean;
  includeCommentsByActor: string;
  excludeCommentsByActor: string;
  customInstructions: string;
  /** Kiro CLI `--effort` value; empty means "let the CLI decide". */
  effort: string;
  /** Model id written into the generated Kiro agent config; empty means default. */
  model: string;
  /** Extra Kiro tool names granted to the agent (comma separated). */
  allowedTools: string;
  /** Extra shell command patterns granted to the agent (comma separated). */
  allowedShellCommands: string;
  /**
   * Agent Skills to install into the run, newline separated. Each entry is
   * `owner/repo@<sha>[/path]` or an `https://…git` URL optionally `#<sha>`. A
   * commit SHA is required: a moving ref is code that can change under you (the
   * same reason setup-bun is SHA-pinned in action.yml). Each is cloned into
   * ~/.kiro/skills/ before the CLI starts; see src/kiro/skills.ts.
   */
  skills: string;
  /** Escape hatch: pass `--trust-all-tools` to the Kiro CLI. */
  trustAllTools: boolean;
  /**
   * Markdown or HTML shown next to "Kiro is working…" while the run is in
   * progress. Empty falls back to an emoji.
   */
  workingIndicator: string;
  /**
   * Which Kiro agent engine to run: "v2" (the CLI default) or "v3". v3 enforces
   * capability rules but ignores agent-declared MCP servers, so tag mode loses
   * its reporting channel there. See docs/security.md.
   */
  agentEngine: "v2" | "v3";
};

// Common fields shared by all context types
type BaseContext = {
  runId: string;
  eventAction?: string;
  repository: {
    owner: string;
    repo: string;
    full_name: string;
    default_branch?: string;
  };
  actor: string;
  inputs: ActionInputs;
};

// Context for entity-based events (issues, PRs, comments)
export type ParsedGitHubContext = BaseContext & {
  eventName: EntityEventName;
  payload:
    | IssuesEvent
    | IssueCommentEvent
    | PullRequestEvent
    | PullRequestReviewEvent
    | PullRequestReviewCommentEvent;
  entityNumber: number;
  isPR: boolean;
};

// Context for automation events (workflow_dispatch, repository_dispatch, schedule, workflow_run)
export type AutomationContext = BaseContext & {
  eventName: AutomationEventName;
  payload:
    | WorkflowDispatchEvent
    | RepositoryDispatchEvent
    | ScheduleEvent
    | WorkflowRunEvent;
};

export type GitHubContext = ParsedGitHubContext | AutomationContext;

export function parseGitHubContext(): GitHubContext {
  const context = github.context;

  const commonFields = {
    runId: process.env.GITHUB_RUN_ID!,
    eventAction: context.payload.action,
    repository: {
      owner: context.repo.owner,
      repo: context.repo.repo,
      full_name: `${context.repo.owner}/${context.repo.repo}`,
      default_branch: context.payload.repository?.default_branch,
    },
    actor: context.actor,
    inputs: {
      prompt: process.env.PROMPT || "",
      triggerPhrase: process.env.TRIGGER_PHRASE || DEFAULT_TRIGGER_PHRASE,
      assigneeTrigger: process.env.ASSIGNEE_TRIGGER ?? "",
      labelTrigger: process.env.LABEL_TRIGGER ?? "",
      baseBranch: process.env.BASE_BRANCH || undefined,
      branchPrefix: process.env.BRANCH_PREFIX || DEFAULT_BRANCH_PREFIX,
      branchNameTemplate: process.env.BRANCH_NAME_TEMPLATE || undefined,
      botId: process.env.BOT_ID || String(DEFAULT_BOT_ID),
      botName: process.env.BOT_NAME || DEFAULT_BOT_LOGIN,
      allowedBots: process.env.ALLOWED_BOTS ?? "",
      trackProgress: process.env.TRACK_PROGRESS === "true",
      useInlineComments: process.env.USE_INLINE_COMMENTS === "true",
      includeCommentsByActor: process.env.INCLUDE_COMMENTS_BY_ACTOR ?? "",
      excludeCommentsByActor: process.env.EXCLUDE_COMMENTS_BY_ACTOR ?? "",
      customInstructions: process.env.CUSTOM_INSTRUCTIONS ?? "",
      effort: process.env.KIRO_EFFORT ?? "",
      model: process.env.KIRO_MODEL ?? "",
      allowedTools: process.env.ALLOWED_TOOLS ?? "",
      allowedShellCommands: process.env.ALLOWED_SHELL_COMMANDS ?? "",
      skills: process.env.SKILLS ?? "",
      trustAllTools: process.env.TRUST_ALL_TOOLS === "true",
      workingIndicator: process.env.WORKING_INDICATOR ?? "",
      agentEngine: process.env.AGENT_ENGINE === "v3" ? "v3" : "v2",
    } satisfies ActionInputs,
  };

  switch (context.eventName) {
    case "issues": {
      const payload = context.payload as IssuesEvent;
      return {
        ...commonFields,
        eventName: "issues",
        payload,
        entityNumber: payload.issue.number,
        isPR: false,
      };
    }
    case "issue_comment": {
      const payload = context.payload as IssueCommentEvent;
      return {
        ...commonFields,
        eventName: "issue_comment",
        payload,
        entityNumber: payload.issue.number,
        isPR: Boolean(payload.issue.pull_request),
      };
    }
    case "pull_request":
    case "pull_request_target": {
      const payload = context.payload as PullRequestEvent;
      return {
        ...commonFields,
        eventName: "pull_request",
        payload,
        entityNumber: payload.pull_request.number,
        isPR: true,
      };
    }
    case "pull_request_review": {
      const payload = context.payload as PullRequestReviewEvent;
      return {
        ...commonFields,
        eventName: "pull_request_review",
        payload,
        entityNumber: payload.pull_request.number,
        isPR: true,
      };
    }
    case "pull_request_review_comment": {
      const payload = context.payload as PullRequestReviewCommentEvent;
      return {
        ...commonFields,
        eventName: "pull_request_review_comment",
        payload,
        entityNumber: payload.pull_request.number,
        isPR: true,
      };
    }
    case "workflow_dispatch": {
      return {
        ...commonFields,
        eventName: "workflow_dispatch",
        payload: context.payload as unknown as WorkflowDispatchEvent,
      };
    }
    case "repository_dispatch": {
      return {
        ...commonFields,
        eventName: "repository_dispatch",
        payload: context.payload as unknown as RepositoryDispatchEvent,
      };
    }
    case "schedule": {
      return {
        ...commonFields,
        eventName: "schedule",
        payload: context.payload as unknown as ScheduleEvent,
      };
    }
    case "workflow_run": {
      return {
        ...commonFields,
        eventName: "workflow_run",
        payload: context.payload as unknown as WorkflowRunEvent,
      };
    }
    default:
      throw new Error(`Unsupported event type: ${context.eventName}`);
  }
}

export function isIssuesEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssuesEvent } {
  return context.eventName === "issues";
}

export function isIssueCommentEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssueCommentEvent } {
  return context.eventName === "issue_comment";
}

export function isPullRequestEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestEvent } {
  return context.eventName === "pull_request";
}

export function isPullRequestReviewEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestReviewEvent } {
  return context.eventName === "pull_request_review";
}

export function isPullRequestReviewCommentEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: PullRequestReviewCommentEvent } {
  return context.eventName === "pull_request_review_comment";
}

export function isWorkflowRunEvent(
  context: GitHubContext,
): context is AutomationContext & { payload: WorkflowRunEvent } {
  return context.eventName === "workflow_run";
}

export function isIssuesAssignedEvent(
  context: GitHubContext,
): context is ParsedGitHubContext & { payload: IssuesAssignedEvent } {
  return isIssuesEvent(context) && context.eventAction === "assigned";
}

/** Entity contexts carry `entityNumber` and `isPR`. */
export function isEntityContext(
  context: GitHubContext,
): context is ParsedGitHubContext {
  return ENTITY_EVENT_NAMES.includes(context.eventName as EntityEventName);
}

export function isAutomationContext(
  context: GitHubContext,
): context is AutomationContext {
  return AUTOMATION_EVENT_NAMES.includes(
    context.eventName as AutomationEventName,
  );
}
