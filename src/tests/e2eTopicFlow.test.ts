import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { registerHandlers } from "../bot/registerHandlers.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createFakeHandlerBot, createFakeThreadCatalog, createNoopLogger, createTestStores } from "./helpers.js";

class DeferredCodexRuntime {
  calls: Array<{
    prompt: unknown;
    profile: any;
    threadId: string;
    release: () => void;
  }> = [];

  configOverrides: unknown;
  activeRuns = new Map<
    string,
    {
      sessionKey: string;
      startedAt: string;
      threadId: string | null;
      lastEventAt: string;
      lastEventType: "thread.started" | "turn.started" | "item.completed" | "turn.completed" | null;
      abortController: AbortController;
      promise: Promise<unknown>;
    }
  >();

  interruptedSessions = new Set<string>();

  isRunning(sessionKey: string): boolean {
    return this.activeRuns.has(sessionKey);
  }

  getActiveRun(sessionKey: string) {
    return this.activeRuns.get(sessionKey) ?? null;
  }

  interrupt(sessionKey: string): boolean {
    const active = this.activeRuns.get(sessionKey);
    if (!active) return false;
    this.interruptedSessions.add(sessionKey);
    active.abortController.abort();
    for (let index = this.calls.length - 1; index >= 0; index -= 1) {
      const call = this.calls[index];
      if (call?.profile.sessionKey === sessionKey) {
        call.release();
        break;
      }
    }
    return true;
  }

  setConfigOverrides(configOverrides: unknown): void {
    this.configOverrides = configOverrides;
  }

  async run(input: { profile: any; prompt: unknown; callbacks?: any }) {
    const { profile, prompt, callbacks } = input;
    const threadId = profile.threadId ?? `thread-e2e-${this.calls.length + 1}`;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedAt = new Date().toISOString();
    const active: {
      sessionKey: string;
      startedAt: string;
      threadId: string | null;
      lastEventAt: string;
      lastEventType: "thread.started" | "turn.started" | "item.completed" | "turn.completed" | null;
      abortController: AbortController;
      promise: Promise<unknown>;
    } = {
      sessionKey: profile.sessionKey,
      startedAt,
      threadId: profile.threadId,
      lastEventAt: startedAt,
      lastEventType: null,
      abortController: new AbortController(),
      promise: Promise.resolve({ threadId, items: [], finalResponse: "", usage: null }),
    };
    this.activeRuns.set(profile.sessionKey, active);
    this.calls.push({
      prompt,
      profile,
      threadId,
      release,
    });

    await gate;

    try {
      if (this.interruptedSessions.has(profile.sessionKey)) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }

      if (!profile.threadId) {
        active.threadId = threadId;
        active.lastEventAt = new Date().toISOString();
        active.lastEventType = "thread.started";
        await callbacks?.onThreadStarted?.(threadId);
        await callbacks?.onEvent?.({ type: "thread.started", thread_id: threadId });
      }

      active.lastEventAt = new Date().toISOString();
      active.lastEventType = "turn.started";
      await callbacks?.onEvent?.({ type: "turn.started" });

      const finalResponse = `final: ${String(prompt)}`;
      active.lastEventAt = new Date().toISOString();
      active.lastEventType = "item.completed";
      await callbacks?.onEvent?.({
        type: "item.completed",
        item: {
          id: `msg-${this.calls.length}`,
          type: "agent_message",
          text: finalResponse,
        },
      });

      active.lastEventAt = new Date().toISOString();
      active.lastEventType = "turn.completed";
      await callbacks?.onEvent?.({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
        },
      });

      return {
        threadId,
        items: [],
        finalResponse,
        usage: null,
      };
    } finally {
      this.interruptedSessions.delete(profile.sessionKey);
      this.activeRuns.delete(profile.sessionKey);
    }
  }
}

test("e2e topic flow runs Codex inside an existing project topic and reports status", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    const projectReplies = await runCommand(harness, "project", `bind ${process.cwd()}`);
    assert.match(projectReplies.at(-1) ?? "", /Project binding updated/);

    const topicId = 201;

    await runTextMessage(harness, topicId, "inspect the project");
    await waitFor(() => codex.calls.length === 1);

    assert.equal(codex.getActiveRun(`-100:${topicId}`)?.lastEventType, null);
    const preparingStatusReplies = await runCommand(harness, "status", "", topicId);
    const preparingStatus = preparingStatusReplies.at(-1) ?? "";
    assert.match(preparingStatus, /state: preparing/);
    assert.doesNotMatch(preparingStatus, /active run: none/);

    codex.calls[0]!.release();

    await waitFor(() => harness.store.get(`-100:${topicId}`)?.runtimeStatus === "idle");

    const session = harness.store.get(`-100:${topicId}`);
    assert.equal(session?.codexThreadId, "thread-e2e-1");
    assert.equal(session?.outputMessageId, null);
    assert.equal(codex.calls[0]?.profile.cwd, process.cwd());
    assert.equal(codex.calls[0]?.profile.threadId, null);
    assert.ok(harness.sent.some((entry) => entry.messageThreadId === topicId && entry.text.includes("Starting...")));
    assert.ok(harness.chatActions.some((entry) => entry.messageThreadId === topicId && entry.action === "typing"));
    assert.ok(harness.edited.some((entry) => entry.text.includes("final: inspect the project")));

    const statusReplies = await runCommand(harness, "status", "", topicId);
    const status = statusReplies.at(-1) ?? "";
    assert.match(status, /thread: thread-e2e-1/);
    assert.match(status, /state: idle/);
    assert.match(status, /active run: none/);
  } finally {
    await harness.cleanup();
  }
});

test("e2e topic flow ignores follow-up messages while the current run is active", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 202;
    const sessionKey = `-100:${topicId}`;

    await runTextMessage(harness, topicId, "first task");
    await waitFor(() => codex.calls.length === 1 && codex.isRunning(sessionKey));

    await runTextMessage(harness, topicId, "second task");
    const busyNotice = harness.sent.find(
      (entry) => entry.messageThreadId === topicId && entry.text.includes("Codex is still working in this topic."),
    );
    assert.ok(busyNotice);
    assert.equal(busyNotice?.options?.parse_mode, undefined);
    assert.deepEqual(busyNotice?.options?.link_preview_options, { is_disabled: true });

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(sessionKey)?.runtimeStatus === "idle");

    assert.deepEqual(codex.calls.map((call) => call.prompt), ["first task"]);
    assert.ok(harness.edited.some((entry) => entry.text.includes("final: first task")));
  } finally {
    await harness.cleanup();
  }
});

test("e2e topic flow resumes an existing thread id", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    harness.threadCatalog.setThreads([
      {
        id: "thread-existing-777",
        cwd: process.cwd(),
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T01:00:00.000Z",
        preview: "Existing thread 777",
        source: "cli",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-existing-777.jsonl",
      },
    ]);
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 203;
    const replies = await runCommand(harness, "thread", "resume thread-existing-777", topicId);
    assert.match(replies.at(-1) ?? "", /Current topic is now bound to the existing thread id/);

    await runTextMessage(harness, topicId, "continue previous work");
    await waitFor(() => codex.calls.length === 1);
    assert.equal(codex.calls[0]?.profile.threadId, "thread-existing-777");

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(`-100:${topicId}`)?.runtimeStatus === "idle");

    const session = harness.store.get(`-100:${topicId}`);
    assert.equal(session?.codexThreadId, "thread-existing-777");
    assert.ok(harness.edited.some((entry) => entry.text.includes("final: continue previous work")));
  } finally {
    await harness.cleanup();
  }
});

test("e2e topic flow interrupts an active run with /stop", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 204;
    const sessionKey = `-100:${topicId}`;

    await runTextMessage(harness, topicId, "long task");
    await waitFor(() => codex.calls.length === 1 && codex.isRunning(sessionKey));

    const replies = await runCommand(harness, "stop", "", topicId);
    assert.match(replies.at(-1) ?? "", /Interrupt requested for the current run/);
    await waitFor(() => harness.store.get(sessionKey)?.runtimeStatus === "idle" && !codex.isRunning(sessionKey));
    await waitFor(
      () =>
        harness.edited.some((entry) => entry.text.includes("Current run interrupted")) ||
        harness.sent.some((entry) => entry.text.includes("Current run interrupted")),
    );

    assert.ok(
      harness.edited.some((entry) => entry.text.includes("Current run interrupted")) ||
      harness.sent.some((entry) => entry.text.includes("Current run interrupted")),
    );
    assert.equal(harness.store.get(sessionKey)?.outputMessageId, null);
  } finally {
    await harness.cleanup();
  }
});

test("e2e status recovers stale in-memory running state", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 205;
    const sessionKey = `-100:${topicId}`;
    createTopicSession(harness, topicId);
    harness.store.setRuntimeState(sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date().toISOString(),
    });
    harness.store.setOutputMessage(sessionKey, 1234);

    const replies = await runCommand(harness, "status", "", topicId);
    const status = replies.at(-1) ?? "";
    assert.match(status, /state: failed/);
    assert.match(status, /state detail: The previous run was lost. Send the message again./);
    assert.equal(harness.store.get(sessionKey)?.outputMessageId, null);
  } finally {
    await harness.cleanup();
  }
});

test("e2e config commands feed the next SDK run profile", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 206;
    const sessionKey = `-100:${topicId}`;

    await runCommand(harness, "mode", "write", topicId);
    assert.equal(harness.store.get(sessionKey)?.sandboxMode, "workspace-write");
    assert.equal(harness.store.get(sessionKey)?.approvalPolicy, "on-request");

    await runCommand(harness, "yolo", "on", topicId);
    assert.equal(harness.store.get(sessionKey)?.sandboxMode, "danger-full-access");
    assert.equal(harness.store.get(sessionKey)?.approvalPolicy, "never");

    await runCommand(harness, "sandbox", "workspace-write", topicId);
    await runCommand(harness, "approval", "on-failure", topicId);
    await runCommand(harness, "model", "gpt-test-e2e", topicId);
    await runCommand(harness, "effort", "high", topicId);
    await runCommand(harness, "web", "live", topicId);
    await runCommand(harness, "network", "off", topicId);
    await runCommand(harness, "gitcheck", "enforce", topicId);
    await runCommand(harness, "adddir", `add ${process.cwd()}`, topicId);
    await runCommand(harness, "schema", 'set {"type":"object","properties":{"ok":{"type":"boolean"}}}', topicId);
    await runCommand(harness, "codexconfig", 'set {"model_verbosity":"high"}', topicId);
    assert.deepEqual(codex.configOverrides, {
      model_verbosity: "high",
    });
    assert.equal(harness.store.getAppState("codex_config_overrides"), '{"model_verbosity":"high"}');

    const outsideReplies = await runCommand(harness, "cwd", "/", topicId);
    assert.match(outsideReplies.at(-1) ?? "", /Path must stay within the project root/);
    assert.equal(harness.store.get(sessionKey)?.cwd, process.cwd());

    const externalAddReplies = await runCommand(harness, "adddir", `add ${path.resolve(process.cwd(), "..")}`, topicId);
    assert.match(externalAddReplies.at(-1) ?? "", /Path must stay within the project root/);

    const externalDirectory = path.resolve(process.cwd(), "..");
    await runCommand(harness, "adddir", `add-external ${externalDirectory}`, topicId);

    const allowedCwd = `${process.cwd()}/src`;
    await runCommand(harness, "cwd", allowedCwd, topicId);
    assert.equal(harness.store.get(sessionKey)?.cwd, allowedCwd);

    await runTextMessage(harness, topicId, "use configured profile");
    await waitFor(() => codex.calls.length === 1);

    const profile = codex.calls[0]?.profile;
    assert.equal(profile?.cwd, allowedCwd);
    assert.equal(profile?.sandboxMode, "workspace-write");
    assert.equal(profile?.approvalPolicy, "on-failure");
    assert.equal(profile?.model, "gpt-test-e2e");
    assert.equal(profile?.reasoningEffort, "high");
    assert.equal(profile?.webSearchMode, "live");
    assert.equal(profile?.networkAccessEnabled, false);
    assert.equal(profile?.skipGitRepoCheck, false);
    assert.deepEqual(profile?.additionalDirectories, [process.cwd(), externalDirectory]);
    assert.deepEqual(profile?.outputSchema, {
      type: "object",
      properties: {
        ok: {
          type: "boolean",
        },
      },
    });

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(sessionKey)?.runtimeStatus === "idle");
  } finally {
    await harness.cleanup();
  }
});

test("e2e image messages are ignored with the same busy notice while a run is active", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();
  const originalFetch = global.fetch;

  global.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 207;
    const sessionKey = `-100:${topicId}`;

    await runTextMessage(harness, topicId, "active task");
    await waitFor(() => codex.calls.length === 1 && codex.isRunning(sessionKey));

    await runImageMessage(harness, topicId, {
      caption: "queued image",
      photo: [{ file_id: "photo-busy", width: 1280, height: 720 }],
    });

    const busyNotice = harness.sent.find(
      (entry) => entry.messageThreadId === topicId && entry.text.includes("Codex is still working in this topic."),
    );
    assert.ok(busyNotice);
    assert.deepEqual(codex.calls.map((call) => call.prompt), ["active task"]);

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(sessionKey)?.runtimeStatus === "idle");
  } finally {
    global.fetch = originalFetch;
    await harness.cleanup();
  }
});

test("e2e runs clear an invalid stored output schema and continue without it", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 208;
    const sessionKey = `-100:${topicId}`;
    createTopicSession(harness, topicId);

    harness.store.setOutputSchema(sessionKey, "{broken-json");

    await runTextMessage(harness, topicId, "recover from broken schema");
    await waitFor(() => codex.calls.length === 1);

    assert.equal(codex.calls[0]?.profile.outputSchema, undefined);
    assert.equal(harness.store.get(sessionKey)?.outputSchema, null);

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(sessionKey)?.runtimeStatus === "idle");
  } finally {
    await harness.cleanup();
  }
});

test("e2e image messages are sent to the SDK as local_image input", async () => {
  const harness = createHarness();
  const codex = new DeferredCodexRuntime();
  const originalFetch = global.fetch;

  global.fetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as typeof fetch;

  try {
    registerHandlers({
      bot: harness.bot,
      config: harness.config,
      store: harness.store,
      projects: harness.projects,
      codex: codex as never,
      threadCatalog: harness.threadCatalog,
      buffers: harness.buffers,
    });

    await runCommand(harness, "project", `bind ${process.cwd()}`);
    const topicId = 209;

    await runImageMessage(harness, topicId, {
      caption: "inspect this image",
      photo: [{ file_id: "photo-e2e", width: 1280, height: 720 }],
    });
    await waitFor(() => codex.calls.length === 1);

    const prompt = codex.calls[0]?.prompt;
    assert.ok(Array.isArray(prompt));
    assert.deepEqual(prompt[0], {
      type: "text",
      text: "inspect this image",
    });
    assert.equal(prompt[1]?.type, "local_image");
    const imagePath = prompt[1]?.type === "local_image" ? prompt[1].path : null;
    assert.match(imagePath ?? "", /\.jpg$/);

    codex.calls[0]!.release();
    await waitFor(() => harness.store.get(`-100:${topicId}`)?.runtimeStatus === "idle");
    if (imagePath) rmSync(imagePath, { force: true });
  } finally {
    global.fetch = originalFetch;
    await harness.cleanup();
  }
});

function createHarness() {
  const { bot, commands, events, sent, edited, chatActions, createdTopics } = createFakeHandlerBot();
  const stores = createTestStores();
  const threadCatalog = createFakeThreadCatalog();
  const config: AppConfig = {
    telegramBotToken: "test-token",
    defaultCwd: process.cwd(),
    defaultModel: "gpt-5.4",
    codexBin: "codex",
    updateIntervalMs: 1,
  };
  const buffers = new MessageBuffer(bot, config.updateIntervalMs, createNoopLogger());

  return {
    ...stores,
    bot,
    commands,
    events,
    sent,
    edited,
    chatActions,
    createdTopics,
    threadCatalog,
    config,
    buffers,
    cleanup: async () => {
      buffers.dispose();
      await stores.store.flush();
      stores.cleanup();
    },
  };
}

function createTopicSession(harness: ReturnType<typeof createHarness>, messageThreadId: number) {
  return harness.store.getOrCreate({
    sessionKey: `-100:${messageThreadId}`,
    chatId: "-100",
    messageThreadId: String(messageThreadId),
    telegramTopicName: null,
    defaultCwd: harness.config.defaultCwd,
    defaultModel: harness.config.defaultModel,
  });
}

async function runCommand(
  harness: ReturnType<typeof createHarness>,
  command: string,
  match: string,
  messageThreadId?: number,
): Promise<string[]> {
  const handler = harness.commands.get(command);
  assert.ok(handler, `missing /${command} handler`);
  const replies: string[] = [];
  await handler!({
    chat: { id: -100, type: "supergroup" },
    message: messageThreadId == null ? {} : { message_thread_id: messageThreadId },
    match,
    reply: async (text: string) => {
      replies.push(text);
      return undefined;
    },
  });
  return replies;
}

async function runTextMessage(harness: ReturnType<typeof createHarness>, messageThreadId: number, text: string): Promise<void> {
  const handler = harness.events.get("message:text");
  assert.ok(handler, "missing message:text handler");
  await handler!({
    chat: { id: -100, type: "supergroup" },
    message: {
      message_thread_id: messageThreadId,
      text,
    },
    reply: async () => undefined,
  });
}

async function runImageMessage(
  harness: ReturnType<typeof createHarness>,
  messageThreadId: number,
  message: { caption?: string; photo?: Array<{ file_id: string; width?: number; height?: number }> },
): Promise<void> {
  const handler = findEventHandler(harness, "message:photo");
  assert.ok(handler, "missing message:photo handler");
  await handler({
    chat: { id: -100, type: "supergroup" },
    message: {
      message_thread_id: messageThreadId,
      ...message,
    },
    reply: async () => undefined,
  });
}

function findEventHandler(harness: ReturnType<typeof createHarness>, eventName: string): ((ctx: any) => Promise<unknown>) | null {
  for (const [event, handler] of harness.events.entries()) {
    if (event === eventName) return handler;
    if (Array.isArray(event) && event.includes(eventName)) return handler;
  }
  return null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "condition was not met before timeout");
}
