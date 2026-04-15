import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadEvent } from "@openai/codex-sdk";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { handleUserText } from "../bot/inputService.js";
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

test("handleUserText queues when a session already has an active SDK run", async () => {
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
      activeTurnId: "sdk-turn-busy",
    });

    const result = await handleUserText({
      text: "follow up",
      session,
      store,
      codex: createConfigRuntime([], { running: true }) as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(result.status, "queued");
    assert.equal(store.getQueuedInputCount(session.sessionKey), 1);
    assert.match(sent.at(-1)?.text ?? "", /Your message was added to the queue/);
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
      store,
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
    assert.equal(latest?.activeTurnId, null);
    assert.ok(edited.some((entry) => entry.text.includes("final answer")));
  } finally {
    cleanup();
  }
});
