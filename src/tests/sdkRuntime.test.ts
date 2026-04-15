import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexSdkRuntime } from "../codex/sdkRuntime.js";

class FakeThread {
  constructor(
    private readonly eventsList: ThreadEvent[],
    private readonly runCalls: Array<{ input: unknown; turnOptions: unknown }>,
  ) {}

  async runStreamed(input: unknown, turnOptions?: unknown): Promise<{ events: AsyncGenerator<ThreadEvent> }> {
    this.runCalls.push({ input, turnOptions });
    const events = this.eventsList;
    return {
      events: (async function* () {
        for (const event of events) {
          yield event;
        }
      })(),
    };
  }
}

class FakeCodex {
  readonly started: ThreadOptions[] = [];
  readonly resumed: Array<{ id: string; options?: ThreadOptions }> = [];
  readonly runCalls: Array<{ input: unknown; turnOptions: unknown }> = [];
  constructor(private readonly eventsList: ThreadEvent[]) {}

  startThread(options?: ThreadOptions) {
    this.started.push(options ?? {});
    return new FakeThread(this.eventsList, this.runCalls);
  }

  resumeThread(id: string, options?: ThreadOptions) {
    this.resumed.push(options ? { id, options } : { id });
    return new FakeThread(this.eventsList, this.runCalls);
  }
}

test("CodexSdkRuntime starts a new thread, forwards events, and returns final response", async () => {
  const events: ThreadEvent[] = [
    { type: "thread.started", thread_id: "thread-901" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "msg-1", type: "agent_message", text: "draft" } },
    { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "final answer" } },
    { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } },
  ];
  const fakeCodex = new FakeCodex(events);
  const runtime = new CodexSdkRuntime({
    codexBin: "codex",
    codex: fakeCodex as never,
  });
  const seen: ThreadEvent[] = [];
  const seenThreadIds: string[] = [];

  const result = await runtime.run({
    profile: {
      sessionKey: "session-1",
      threadId: null,
      cwd: process.cwd(),
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      reasoningEffort: "medium",
      webSearchMode: null,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      additionalDirectories: [],
      outputSchema: undefined,
    },
    prompt: "hello",
    callbacks: {
      onEvent: async (event) => {
        seen.push(event);
      },
      onThreadStarted: async (threadId) => {
        seenThreadIds.push(threadId);
      },
    },
  });

  assert.equal(fakeCodex.started.length, 1);
  assert.equal(fakeCodex.resumed.length, 0);
  assert.equal(result.threadId, "thread-901");
  assert.equal(result.finalResponse, "final answer");
  assert.equal(seen.length, events.length);
  assert.deepEqual(seenThreadIds, ["thread-901"]);
});

test("CodexSdkRuntime exposes active run progress while streaming", async () => {
  const events: ThreadEvent[] = [
    { type: "thread.started", thread_id: "thread-active" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "msg-active", type: "agent_message", text: "done" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  const fakeCodex = new FakeCodex(events);
  const runtime = new CodexSdkRuntime({
    codexBin: "codex",
    codex: fakeCodex as never,
  });
  const snapshots: Array<{ threadId: string | null; lastEventType: string | null }> = [];

  await runtime.run({
    profile: {
      sessionKey: "session-active",
      threadId: null,
      cwd: process.cwd(),
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      reasoningEffort: "medium",
      webSearchMode: null,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      additionalDirectories: [],
      outputSchema: undefined,
    },
    prompt: "hello",
    callbacks: {
      onEvent: async () => {
        const active = runtime.getActiveRun("session-active");
        snapshots.push({
          threadId: active?.threadId ?? null,
          lastEventType: active?.lastEventType ?? null,
        });
      },
    },
  });

  assert.deepEqual(snapshots[0], {
    threadId: "thread-active",
    lastEventType: "thread.started",
  });
  assert.deepEqual(snapshots.at(-1), {
    threadId: "thread-active",
    lastEventType: "turn.completed",
  });
  assert.equal(runtime.getActiveRun("session-active"), null);
});

test("CodexSdkRuntime resumes an existing thread id", async () => {
  const events: ThreadEvent[] = [
    { type: "turn.started" },
    { type: "item.completed", item: { id: "msg-2", type: "agent_message", text: "continued" } },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  const fakeCodex = new FakeCodex(events);
  const runtime = new CodexSdkRuntime({
    codexBin: "codex",
    codex: fakeCodex as never,
  });

  const result = await runtime.run({
    profile: {
      sessionKey: "session-2",
      threadId: "thread-existing",
      cwd: process.cwd(),
      model: "gpt-5.4",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      reasoningEffort: null,
      webSearchMode: null,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      additionalDirectories: [],
      outputSchema: undefined,
    },
    prompt: "continue",
  });

  assert.equal(fakeCodex.started.length, 0);
  assert.equal(fakeCodex.resumed.length, 1);
  assert.equal(fakeCodex.resumed[0]?.id, "thread-existing");
  assert.equal(result.threadId, "thread-existing");
  assert.equal(result.finalResponse, "continued");
});

test("CodexSdkRuntime passes non-auth SDK options through", async () => {
  const events: ThreadEvent[] = [
    { type: "thread.started", thread_id: "thread-options" },
    { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
  ];
  const fakeCodex = new FakeCodex(events);
  const runtime = new CodexSdkRuntime({
    codexBin: "codex",
    codex: fakeCodex as never,
  });
  const outputSchema = {
    type: "object",
    properties: {
      ok: {
        type: "boolean",
      },
    },
  };

  await runtime.run({
    profile: {
      sessionKey: "session-options",
      threadId: null,
      cwd: process.cwd(),
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-failure",
      reasoningEffort: "high",
      webSearchMode: "live",
      networkAccessEnabled: false,
      skipGitRepoCheck: false,
      additionalDirectories: [process.cwd()],
      outputSchema,
    },
    prompt: [
      {
        type: "text",
        text: "describe image",
      },
      {
        type: "local_image",
        path: "/tmp/example.png",
      },
    ],
  });

  assert.deepEqual(fakeCodex.started[0], {
    model: "gpt-5.4",
    sandboxMode: "workspace-write",
    workingDirectory: process.cwd(),
    skipGitRepoCheck: false,
    modelReasoningEffort: "high",
    networkAccessEnabled: false,
    webSearchMode: "live",
    additionalDirectories: [process.cwd()],
    approvalPolicy: "on-failure",
  });
  assert.deepEqual(fakeCodex.runCalls[0]?.turnOptions, {
    signal: fakeCodex.runCalls[0]?.turnOptions && (fakeCodex.runCalls[0].turnOptions as { signal: AbortSignal }).signal,
    outputSchema,
  });
  assert.ok((fakeCodex.runCalls[0]?.turnOptions as { signal?: AbortSignal } | undefined)?.signal instanceof AbortSignal);
});
