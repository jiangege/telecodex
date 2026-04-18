import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { handleUserText } from "../bot/run/runOrchestrator.js";
import { createFakeBot, createNoopLogger, createTestStores } from "./helpers.js";

function createConfigRuntime(events: ThreadEvent[], options?: { running?: boolean }) {
  let running = options?.running ?? false;
  return {
    isRunning: () => running,
    getActiveRun: () => null,
    interrupt: () => {
      running = false;
      return true;
    },
    run: async ({ callbacks, profile }: any) => {
      running = true;
      let threadId = profile.threadId ?? "thread-501";
      let finalResponse = "done";
      for (const event of events) {
        if (event.type === "thread.started") {
          threadId = event.thread_id;
          await callbacks?.onThreadStarted?.(event.thread_id);
        }
        if (
          (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") &&
          event.item.type === "agent_message"
        ) {
          finalResponse = event.item.text;
        }
        await callbacks?.onEvent?.(event);
      }
      running = false;
      return {
        threadId,
        items: [],
        finalResponse,
        usage: null,
      };
    },
  };
}

function createDeferredTurnRuntime() {
  let running = false;
  let startTurn: () => void = () => undefined;
  let finishTurn: () => void = () => undefined;
  const turnStarted = new Promise<void>((resolve) => {
    startTurn = resolve;
  });
  const turnFinished = new Promise<void>((resolve) => {
    finishTurn = resolve;
  });

  return {
    startTurn,
    finishTurn,
    runtime: {
      isRunning: () => running,
      getActiveRun: () => null,
      interrupt: () => {
        running = false;
        finishTurn();
        return true;
      },
      run: async ({ callbacks, profile }: any) => {
        running = true;
        const threadId = profile.threadId ?? "thread-deferred";
        await callbacks?.onThreadStarted?.(threadId);
        await callbacks?.onEvent?.({ type: "thread.started", thread_id: threadId });
        await turnStarted;
        await callbacks?.onEvent?.({ type: "turn.started" });
        await turnFinished;
        await callbacks?.onEvent?.({
          type: "item.completed",
          item: { id: "msg-deferred", type: "agent_message", text: "done" },
        });
        await callbacks?.onEvent?.({
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        });
        running = false;
        return {
          threadId,
          items: [],
          finalResponse: "done",
          usage: null,
        };
      },
    },
  };
}

test("handleUserText sends a fixed busy notice when a session already has an active SDK run", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, sent } = createFakeBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:210",
      chatId: "-100",
      messageThreadId: "210",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date().toISOString(),
    });

    const result = await handleUserText({
      text: "follow up",
      session,
      sessions: store,
      projects,
      codex: createConfigRuntime([], { running: true }) as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(result.status, "busy");
    assert.match(sent.at(-1)?.text ?? "", /Codex is still working in this topic/);
    assert.match(sent.at(-1)?.text ?? "", /New messages are ignored until the current run finishes or fails/);
    assert.match(sent.at(-1)?.text ?? "", /Use \/stop to interrupt it/);
  } finally {
    cleanup();
  }
});

test("handleUserText starts a SDK run, persists thread id, and finishes idle", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, edited } = createFakeBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:211",
      chatId: "-100",
      messageThreadId: "211",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    const events: ThreadEvent[] = [
      { type: "thread.started", thread_id: "thread-211" },
      { type: "turn.started" },
      { type: "item.started", item: { id: "todo-1", type: "todo_list", items: [{ text: "inspect", completed: false }] } },
      { type: "item.updated", item: { id: "msg-1", type: "agent_message", text: "working" } },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "final answer" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 2 } },
    ];

    const result = await handleUserText({
      text: "please help",
      session,
      sessions: store,
      projects,
      codex: createConfigRuntime(events) as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(result.status, "started");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const latest = store.get(session.sessionKey);
    assert.equal(latest?.codexThreadId, "thread-211");
    assert.equal(latest?.runtimeStatus, "idle");
    assert.ok(edited.some((entry) => entry.text.includes("final answer")));
  } finally {
    cleanup();
  }
});

test("handleUserText stays preparing until the SDK emits turn.started", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot } = createFakeBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:212",
      chatId: "-100",
      messageThreadId: "212",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    const deferred = createDeferredTurnRuntime();

    const result = await handleUserText({
      text: "wait for sdk",
      session,
      sessions: store,
      projects,
      codex: deferred.runtime as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(result.status, "started");
    await new Promise((resolve) => setTimeout(resolve, 10));
    let latest = store.get(session.sessionKey);
    assert.equal(latest?.runtimeStatus, "preparing");

    deferred.startTurn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = store.get(session.sessionKey);
    assert.equal(latest?.runtimeStatus, "running");

    deferred.finishTurn();
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = store.get(session.sessionKey);
    assert.equal(latest?.runtimeStatus, "idle");
  } finally {
    cleanup();
  }
});
