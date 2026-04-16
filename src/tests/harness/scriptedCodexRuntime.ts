import type { ThreadEvent, ThreadItem } from "@openai/codex-sdk";

export type ScriptedCodexStep = ThreadEvent | { type: "pause" };

interface ScriptedRun {
  threadId?: string;
  steps: ScriptedCodexStep[];
  pauseController: PauseController;
}

interface ActiveRunSnapshot {
  sessionKey: string;
  startedAt: string;
  threadId: string | null;
  lastEventAt: string;
  lastEventType: ThreadEvent["type"] | null;
  abortController: AbortController;
  pauseController: PauseController;
  promise: Promise<unknown>;
}

export class ScriptedCodexRuntime {
  readonly calls: Array<{
    prompt: unknown;
    profile: any;
    threadId: string;
  }> = [];

  configOverrides: unknown;
  private readonly activeRuns = new Map<string, ActiveRunSnapshot>();
  private readonly queuedRuns: ScriptedRun[] = [];
  private runCount = 0;

  constructor(private readonly input?: { now?: () => number }) {}

  enqueueRun(input: { threadId?: string; steps: ScriptedCodexStep[] }): { release: () => void } {
    const pauseController = new PauseController();
    this.queuedRuns.push(
      input.threadId
        ? {
          threadId: input.threadId,
          steps: input.steps,
          pauseController,
        }
        : {
          steps: input.steps,
          pauseController,
        },
    );
    return {
      release: () => pauseController.release(),
    };
  }

  setConfigOverrides(configOverrides: unknown): void {
    this.configOverrides = configOverrides;
  }

  isRunning(sessionKey: string): boolean {
    return this.activeRuns.has(sessionKey);
  }

  getActiveRun(sessionKey: string) {
    return this.activeRuns.get(sessionKey) ?? null;
  }

  interrupt(sessionKey: string): boolean {
    const active = this.activeRuns.get(sessionKey);
    if (!active) return false;
    active.abortController.abort();
    active.pauseController.releaseAll();
    return true;
  }

  async run(input: { profile: any; prompt: unknown; callbacks?: any }) {
    const { profile, prompt, callbacks } = input;
    const scripted = this.queuedRuns.shift() ?? this.createDefaultRun(profile, prompt);
    const threadId = profile.threadId ?? scripted.threadId ?? `thread-scripted-${++this.runCount}`;
    const startedAt = this.nowIso();
    const abortController = new AbortController();
    const active: ActiveRunSnapshot = {
      sessionKey: profile.sessionKey,
      startedAt,
      threadId: profile.threadId,
      lastEventAt: startedAt,
      lastEventType: null,
      abortController,
      pauseController: scripted.pauseController,
      promise: Promise.resolve(),
    };

    const runPromise = this.executeRun({
      profile,
      prompt,
      callbacks,
      scripted,
      fallbackThreadId: threadId,
      active,
    });
    active.promise = runPromise;
    this.activeRuns.set(profile.sessionKey, active);
    this.calls.push({
      prompt,
      profile,
      threadId,
    });

    try {
      return await runPromise;
    } finally {
      this.activeRuns.delete(profile.sessionKey);
    }
  }

  private async executeRun(input: {
    profile: any;
    prompt: unknown;
    callbacks: any;
    scripted: ScriptedRun;
    fallbackThreadId: string;
    active: ActiveRunSnapshot;
  }) {
    const { profile, callbacks, scripted, fallbackThreadId, active } = input;
    let finalResponse = "";
    let usage = null;
    let threadId = profile.threadId ?? scripted.threadId ?? fallbackThreadId;

    for (const step of scripted.steps) {
      this.throwIfInterrupted(active.abortController);
      if (step.type === "pause") {
        await scripted.pauseController.wait();
        this.throwIfInterrupted(active.abortController);
        continue;
      }

      active.lastEventAt = this.nowIso();
      active.lastEventType = step.type;

      if (step.type === "thread.started") {
        threadId = step.thread_id;
        active.threadId = step.thread_id;
        await callbacks?.onThreadStarted?.(step.thread_id);
        await callbacks?.onEvent?.(step);
        continue;
      }

      if (step.type === "turn.failed") {
        throw new Error(step.error.message);
      }
      if (step.type === "error") {
        throw new Error(step.message);
      }

      if (isItemEvent(step) && step.item.type === "agent_message") {
        finalResponse = step.item.text;
      }
      if (step.type === "turn.completed") {
        usage = step.usage;
      }
      await callbacks?.onEvent?.(step);
    }

    return {
      threadId,
      items: [],
      finalResponse,
      usage,
    };
  }

  private createDefaultRun(profile: { threadId: string | null }, prompt: unknown): ScriptedRun {
    const threadId = profile.threadId ?? `thread-scripted-${++this.runCount}`;
    const steps: ScriptedCodexStep[] = [];
    if (!profile.threadId) {
      steps.push({ type: "thread.started", thread_id: threadId });
    }
    steps.push(
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: `msg-${this.runCount}`,
          type: "agent_message",
          text: `final: ${String(prompt)}`,
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      },
    );
    return {
      threadId,
      steps,
      pauseController: new PauseController(),
    };
  }

  private throwIfInterrupted(abortController: AbortController): void {
    if (!abortController.signal.aborted) return;
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  }

  private nowIso(): string {
    const now = this.input?.now?.() ?? Date.now();
    return new Date(now).toISOString();
  }
}

function isItemEvent(
  event: ThreadEvent,
): event is Extract<ThreadEvent, { type: "item.started" | "item.updated" | "item.completed" }> & { item: ThreadItem } {
  return event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed";
}

class PauseController {
  private availableReleases = 0;
  private readonly waiters: Array<() => void> = [];

  async wait(): Promise<void> {
    if (this.availableReleases > 0) {
      this.availableReleases -= 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
      return;
    }
    this.availableReleases += 1;
  }

  releaseAll(): void {
    while (this.waiters.length > 0) {
      this.release();
    }
    this.availableReleases = 0;
  }
}
