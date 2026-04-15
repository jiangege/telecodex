import {
  Codex,
  type ApprovalMode,
  type CodexOptions,
  type Input,
  type RunResult,
  type SandboxMode,
  type ThreadEvent,
  type ThreadItem,
  type ThreadOptions,
  type WebSearchMode,
} from "@openai/codex-sdk";
import type { SessionApprovalPolicy, SessionReasoningEffort, SessionSandboxMode, SessionWebSearchMode } from "../config.js";
import type { Logger } from "../runtime/logger.js";

export interface SessionRunProfile {
  sessionKey: string;
  threadId: string | null;
  cwd: string;
  model: string;
  sandboxMode: SessionSandboxMode;
  approvalPolicy: SessionApprovalPolicy;
  reasoningEffort: SessionReasoningEffort | null;
  webSearchMode: SessionWebSearchMode | null;
  networkAccessEnabled: boolean;
  skipGitRepoCheck: boolean;
  additionalDirectories: string[];
  outputSchema: unknown;
}

export interface ActiveRun {
  sessionKey: string;
  startedAt: string;
  threadId: string | null;
  lastEventAt: string;
  lastEventType: ThreadEvent["type"] | null;
  abortController: AbortController;
  promise: Promise<RunResultWithThread>;
}

export interface RunResultWithThread extends RunResult {
  threadId: string;
}

export interface RunCallbacks {
  onEvent?: (event: ThreadEvent) => void | Promise<void>;
  onThreadStarted?: (threadId: string) => void | Promise<void>;
}

export class CodexSdkRuntime {
  private codex: Pick<Codex, "startThread" | "resumeThread">;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private configOverrides: CodexOptions["config"] | undefined;
  private readonly injectedCodex: Pick<Codex, "startThread" | "resumeThread"> | null;

  constructor(private readonly input: { codexBin: string; logger?: Logger; configOverrides?: CodexOptions["config"]; codex?: Pick<Codex, "startThread" | "resumeThread"> }) {
    this.configOverrides = input.configOverrides;
    this.injectedCodex = input.codex ?? null;
    this.codex = input.codex ?? this.createCodex();
  }

  setConfigOverrides(configOverrides: CodexOptions["config"] | undefined): void {
    this.configOverrides = configOverrides;
    if (!this.injectedCodex) {
      this.codex = this.createCodex();
    }
  }

  isRunning(sessionKey: string): boolean {
    return this.activeRuns.has(sessionKey);
  }

  getActiveRun(sessionKey: string): ActiveRun | null {
    return this.activeRuns.get(sessionKey) ?? null;
  }

  interrupt(sessionKey: string): boolean {
    const run = this.activeRuns.get(sessionKey);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  interruptAll(): void {
    for (const run of this.activeRuns.values()) {
      run.abortController.abort();
    }
  }

  private createCodex(): Codex {
    return new Codex({
      codexPathOverride: this.input.codexBin,
      ...(this.configOverrides ? { config: this.configOverrides } : {}),
    });
  }

  async run(input: {
    profile: SessionRunProfile;
    prompt: Input;
    callbacks?: RunCallbacks;
  }): Promise<RunResultWithThread> {
    if (this.activeRuns.has(input.profile.sessionKey)) {
      throw new Error("Codex run already active for this session");
    }

    const threadOptions = toThreadOptions(input.profile);
    const thread = input.profile.threadId
      ? this.codex.resumeThread(input.profile.threadId, threadOptions)
      : this.codex.startThread(threadOptions);
    const abortController = new AbortController();

    const runPromise = this.consumeStream({
      thread,
      prompt: input.prompt,
      signal: abortController.signal,
      initialThreadId: input.profile.threadId,
      sessionKey: input.profile.sessionKey,
      outputSchema: input.profile.outputSchema,
      ...(input.callbacks ? { callbacks: input.callbacks } : {}),
    });
    const startedAt = new Date().toISOString();

    this.activeRuns.set(input.profile.sessionKey, {
      sessionKey: input.profile.sessionKey,
      startedAt,
      threadId: input.profile.threadId,
      lastEventAt: startedAt,
      lastEventType: null,
      abortController,
      promise: runPromise,
    });

    try {
      const result = await runPromise;
      return result;
    } finally {
      this.activeRuns.delete(input.profile.sessionKey);
    }
  }

  private async consumeStream(input: {
    thread: ReturnType<Codex["startThread"]>;
    prompt: Input;
    signal: AbortSignal;
    initialThreadId: string | null;
    sessionKey: string;
    outputSchema: unknown;
    callbacks?: RunCallbacks;
  }): Promise<RunResultWithThread> {
    const streamed = await input.thread.runStreamed(input.prompt, {
      signal: input.signal,
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    });
    const items = new Map<string, ThreadItem>();
    let finalResponse = "";
    let usage: RunResult["usage"] = null;
    let threadId = input.initialThreadId;

    for await (const event of streamed.events) {
      const activeRun = this.activeRuns.get(input.sessionKey);
      if (activeRun) {
        activeRun.lastEventAt = new Date().toISOString();
        activeRun.lastEventType = event.type;
      }

      if (event.type === "thread.started") {
        threadId = event.thread_id;
        const activeRun = this.activeRuns.get(input.sessionKey);
        if (activeRun) {
          activeRun.threadId = event.thread_id;
        }
        await input.callbacks?.onThreadStarted?.(event.thread_id);
      } else if (
        event.type === "item.started" ||
        event.type === "item.updated" ||
        event.type === "item.completed"
      ) {
        items.set(event.item.id, event.item);
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        }
      } else if (event.type === "turn.completed") {
        usage = event.usage;
      } else if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      } else if (event.type === "error") {
        throw new Error(event.message);
      }

      await input.callbacks?.onEvent?.(event);
    }

    if (!threadId) {
      throw new Error("Codex SDK run finished without a thread id");
    }

    return {
      threadId,
      items: [...items.values()],
      finalResponse,
      usage,
    };
  }
}

export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return error.name === "AbortError" || message.includes("aborted") || message.includes("aborterror");
}

function toThreadOptions(profile: SessionRunProfile): ThreadOptions {
  const modelReasoningEffort =
    profile.reasoningEffort == null || profile.reasoningEffort === "none"
      ? undefined
      : profile.reasoningEffort;

  return {
    model: profile.model,
    sandboxMode: toSandboxMode(profile.sandboxMode),
    workingDirectory: profile.cwd,
    skipGitRepoCheck: profile.skipGitRepoCheck,
    ...(modelReasoningEffort ? { modelReasoningEffort } : {}),
    networkAccessEnabled: profile.networkAccessEnabled,
    ...(profile.webSearchMode ? { webSearchMode: toWebSearchMode(profile.webSearchMode) } : {}),
    ...(profile.additionalDirectories.length > 0 ? { additionalDirectories: profile.additionalDirectories } : {}),
    approvalPolicy: toApprovalMode(profile.approvalPolicy),
  };
}

function toSandboxMode(value: SessionSandboxMode): SandboxMode {
  return value;
}

function toApprovalMode(value: SessionApprovalPolicy): ApprovalMode {
  if (value === "on-failure") return "on-failure";
  return value;
}

function toWebSearchMode(value: SessionWebSearchMode): WebSearchMode {
  return value;
}
