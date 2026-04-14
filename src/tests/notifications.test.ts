import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../generated/codex-app-server/v2/Thread.js";
import {
  handleCodexNotification,
  handleUserText,
  recoverPendingTurnDeliveries,
  refreshLiveSessionHeartbeats,
  refreshSessionIfActiveTurnIsStale,
} from "../bot/createBot.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createFakeBot, createNoopLogger, createTestSessionStore } from "./helpers.js";

test("turn/completed hydrates final agent message into Telegram", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:10",
      chatId: "-100",
      messageThreadId: "10",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-1");
    store.setActiveTurn(session.sessionKey, "turn-1");

    const buffers = new MessageBuffer(bot, 1, createNoopLogger());
    const messageId = await buffers.create("thread-1:pending", { chatId: -100, messageThreadId: 10 });
    store.setOutputMessage(session.sessionKey, messageId);
    buffers.rename("thread-1:pending", "thread-1:turn-1");

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-1",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-1",
              status: "completed",
              items: [
                { type: "userMessage", id: "u1", content: [] },
                { type: "agentMessage", id: "a1", text: "final answer", phase: "final_answer", memoryCitation: null },
              ],
            }),
          ],
        });
      },
    } as never;

    await handleCodexNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: makeTurn({ id: "turn-1", status: "completed", items: [] }),
        },
      },
      store,
      buffers,
      bot,
      gateway,
      createNoopLogger(),
    );

    assert.equal(edited.at(-1)?.text, "final answer");
    assert.equal(store.get(session.sessionKey)?.activeTurnId, null);
    assert.equal(store.get(session.sessionKey)?.outputMessageId, null);
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "idle");
    assert.ok(sent.length >= 1);
  } finally {
    cleanup();
  }
});

test("turn/completed recovers final agent message without an in-memory buffer", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:15",
      chatId: "-100",
      messageThreadId: "15",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-15");
    store.setActiveTurn(session.sessionKey, "turn-15");
    store.setOutputMessage(session.sessionKey, 88);

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-15",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-15",
              status: "completed",
              items: [{ type: "agentMessage", id: "a15", text: "recovered final answer", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await handleCodexNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-15",
          turn: makeTurn({ id: "turn-15", status: "completed", items: [] }),
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      gateway,
      createNoopLogger(),
    );

    assert.equal(edited.at(-1)?.messageId, 88);
    assert.equal(edited.at(-1)?.text, "recovered final answer");
    assert.equal(sent.some((message) => message.text === "recovered final answer"), false);
    assert.equal(store.get(session.sessionKey)?.activeTurnId, null);
    assert.equal(store.get(session.sessionKey)?.outputMessageId, null);
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "idle");
    const delivery = store.getTurnDelivery("turn-15");
    assert.equal(delivery?.status, "delivered");
    assert.ok(delivery?.contentHash);
    assert.ok(delivery?.deliveredAt);
  } finally {
    cleanup();
  }
});

test("turn/completed sends a new final message when recovered edit fails", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, api, edited, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:151",
      chatId: "-100",
      messageThreadId: "151",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-151");
    store.setActiveTurn(session.sessionKey, "turn-151");
    store.setOutputMessage(session.sessionKey, 188);

    api.editMessageText = async () => {
      throw new Error("telegram edit failed");
    };

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-151",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-151",
              status: "completed",
              items: [{ type: "agentMessage", id: "a151", text: "fallback final answer", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await handleCodexNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-151",
          turn: makeTurn({ id: "turn-151", status: "completed", items: [] }),
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      gateway,
      createNoopLogger(),
    );

    assert.equal(edited.some((entry) => entry.text === "fallback final answer"), false);
    assert.equal(sent.some((message) => message.text === "fallback final answer"), true);
    assert.equal(store.getTurnDelivery("turn-151")?.status, "delivered");
  } finally {
    cleanup();
  }
});

test("recoverPendingTurnDeliveries replays a completed turn from persisted delivery state", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:16",
      chatId: "-100",
      messageThreadId: "16",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-16");
    store.upsertTurnDelivery({
      turnId: "turn-16",
      threadId: "thread-16",
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      outputMessageId: 99,
    });

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-16",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-16",
              status: "completed",
              items: [{ type: "agentMessage", id: "a16", text: "replayed answer", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await recoverPendingTurnDeliveries(store, gateway, bot, createNoopLogger());

    assert.equal(edited.at(-1)?.messageId, 99);
    assert.equal(edited.at(-1)?.text, "replayed answer");
    const delivery = store.getTurnDelivery("turn-16");
    assert.equal(delivery?.status, "delivered");
    assert.ok(delivery?.contentHash);
    assert.ok(delivery?.deliveredAt);
  } finally {
    cleanup();
  }
});

test("handleUserText queues follow-up input while session is busy", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:160",
      chatId: "-100",
      messageThreadId: "160",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-160");
    store.setPinnedStatusMessage(session.sessionKey, 1600);
    store.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date().toISOString(),
      activeTurnId: "turn-160",
    });

    await handleUserText({
      text: "queued follow-up",
      session,
      store,
      gateway: {} as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(store.getQueuedInputCount(session.sessionKey), 1);
    assert.match(sent.at(-1)?.text ?? "", /已把你的消息加入队列/);
    assert.match(sent.at(-1)?.text ?? "", /queue position: 1/);
    assert.match(edited.at(-1)?.text ?? "", /queue: <code>1<\/code>/);
  } finally {
    cleanup();
  }
});

test("handleUserText alerts the authorized user when output placeholder creation fails", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, api, sent } = createFakeBot();
  try {
    store.claimAuthorizedUserId(424242);
    const session = store.getOrCreate({
      sessionKey: "-100:161",
      chatId: "-100",
      messageThreadId: "161",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    api.sendMessage = async (chatId) => {
      if (chatId === -100) {
        throw new Error("telegram send failed");
      }
      sent.push({ chatId, text: "alerted", messageThreadId: null });
      return { message_id: 999 };
    };

    const result = await handleUserText({
      text: "hello",
      session,
      store,
      gateway: {} as never,
      buffers: new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      logger: createNoopLogger(),
    });

    assert.equal(result.status, "failed");
    assert.equal(result.consumed, false);
    const alert = sent.find((message) => message.chatId === 424242);
    assert.ok(alert);
  } finally {
    cleanup();
  }
});

test("turn/completed automatically starts the next queued input", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:163",
      chatId: "-100",
      messageThreadId: "163",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-163");
    store.setActiveTurn(session.sessionKey, "turn-163");
    store.setOutputMessage(session.sessionKey, 88);
    store.enqueueInput(session.sessionKey, "queued next turn");

    const gateway = {
      async readThread(threadId: string): Promise<Thread> {
        if (threadId !== "thread-163") throw new Error(`unexpected thread ${threadId}`);
        return makeThread({
          id: "thread-163",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-163",
              status: "completed",
              items: [{ type: "agentMessage", id: "a163", text: "done", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
      async resumeThread() {
        return {
          cwd: process.cwd(),
          model: "gpt-5.4",
          sandbox: { type: "dangerFullAccess" },
          approvalPolicy: "never",
          reasoningEffort: "low",
        };
      },
      async startTurn() {
        return {
          turn: {
            id: "turn-164",
          },
        };
      },
    } as never;

    await handleCodexNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-163",
          turn: makeTurn({ id: "turn-163", status: "completed", items: [] }),
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      gateway,
      createNoopLogger(),
    );

    assert.ok(edited.some((entry) => entry.text === "done"));
    assert.equal(store.getQueuedInputCount(session.sessionKey), 0);
    assert.equal(store.get(session.sessionKey)?.activeTurnId, "turn-164");
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "running");
    assert.ok(sent.some((message) => message.text.includes("Codex 正在处理...")));
  } finally {
    cleanup();
  }
});

test("queued input is retained when the next placeholder cannot be sent", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, api } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:164",
      chatId: "-100",
      messageThreadId: "164",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-164");
    store.setActiveTurn(session.sessionKey, "turn-164");
    store.setOutputMessage(session.sessionKey, 89);
    store.enqueueInput(session.sessionKey, "queued next turn");

    const originalSendMessage = api.sendMessage;
    api.sendMessage = async (chatId, text, options) => {
      if (text === "Codex 正在处理...") {
        throw new Error("telegram send failed");
      }
      return originalSendMessage(chatId, text, options);
    };

    let startTurnCalls = 0;
    const gateway = {
      async readThread(threadId: string): Promise<Thread> {
        if (threadId !== "thread-164") throw new Error(`unexpected thread ${threadId}`);
        return makeThread({
          id: "thread-164",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-164",
              status: "completed",
              items: [{ type: "agentMessage", id: "a164", text: "done", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
      async resumeThread() {
        return {
          cwd: process.cwd(),
          model: "gpt-5.4",
          sandbox: { type: "dangerFullAccess" },
          approvalPolicy: "never",
          reasoningEffort: "low",
        };
      },
      async startTurn() {
        startTurnCalls += 1;
        return {
          turn: {
            id: "turn-165",
          },
        };
      },
    } as never;

    await handleCodexNotification(
      {
        method: "turn/completed",
        params: {
          threadId: "thread-164",
          turn: makeTurn({ id: "turn-164", status: "completed", items: [] }),
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      gateway,
      createNoopLogger(),
    );

    assert.equal(store.getQueuedInputCount(session.sessionKey), 1);
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "failed");
    assert.equal(startTurnCalls, 0);
  } finally {
    cleanup();
  }
});

test("recoverPendingTurnDeliveries skips an in-flight delivering turn", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:161",
      chatId: "-100",
      messageThreadId: "161",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-161");
    store.upsertTurnDelivery({
      turnId: "turn-161",
      threadId: "thread-161",
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      outputMessageId: 199,
    });
    store.markTurnDeliveryDelivering("turn-161", "hash-161");

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-161",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-161",
              status: "completed",
              items: [{ type: "agentMessage", id: "a161", text: "should not replay yet", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await recoverPendingTurnDeliveries(store, gateway, bot, createNoopLogger());

    assert.equal(edited.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(store.getTurnDelivery("turn-161")?.status, "delivering");
  } finally {
    cleanup();
  }
});

test("recoverPendingTurnDeliveries replays a stale delivering turn", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:162",
      chatId: "-100",
      messageThreadId: "162",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-162");
    store.upsertTurnDelivery({
      turnId: "turn-162",
      threadId: "thread-162",
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      outputMessageId: 299,
    });
    store.markTurnDeliveryDelivering("turn-162", "hash-162");

    const db = (store as any).db as {
      prepare: (sql: string) => { run: (...args: unknown[]) => void };
    };
    const staleAt = new Date(Date.now() - 11 * 60_000).toISOString();
    db
      .prepare("UPDATE turn_deliveries SET last_attempt_at = ?, updated_at = ? WHERE turn_id = ?")
      .run(staleAt, staleAt, "turn-162");

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-162",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-162",
              status: "completed",
              items: [{ type: "agentMessage", id: "a162", text: "replayed stale answer", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await recoverPendingTurnDeliveries(store, gateway, bot, createNoopLogger());

    assert.equal(edited.at(-1)?.messageId, 299);
    assert.equal(edited.at(-1)?.text, "replayed stale answer");
    assert.equal(store.getTurnDelivery("turn-162")?.status, "delivered");
  } finally {
    cleanup();
  }
});

test("recoverPendingTurnDeliveries backs off after a failed delivery attempt", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, api, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:17",
      chatId: "-100",
      messageThreadId: "17",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-17");
    store.upsertTurnDelivery({
      turnId: "turn-17",
      threadId: "thread-17",
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      outputMessageId: 199,
    });

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-17",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-17",
              status: "completed",
              items: [{ type: "agentMessage", id: "a17", text: "retry later", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    const originalSendMessage = api.sendMessage;
    api.editMessageText = async () => {
      throw new Error("telegram edit failed");
    };
    api.sendMessage = async (chatId, text, options) => {
      if (chatId === -100) {
        throw new Error("telegram send failed");
      }
      return originalSendMessage(chatId, text, options);
    };

    await recoverPendingTurnDeliveries(store, gateway, bot, createNoopLogger());
    const afterFirstFailure = store.getTurnDelivery("turn-17");
    assert.equal(afterFirstFailure?.status, "failed");
    assert.equal(afterFirstFailure?.failureCount, 1);
    assert.ok(afterFirstFailure?.nextAttemptAt);

    await recoverPendingTurnDeliveries(store, gateway, bot, createNoopLogger());
    const afterImmediateRetry = store.getTurnDelivery("turn-17");
    assert.equal(afterImmediateRetry?.failureCount, 1);
    assert.equal(sent.length, 0);
  } finally {
    cleanup();
  }
});

test("turn delivery alerts the authorized user after retries are exhausted", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, api, sent } = createFakeBot();
  try {
    const authorizedUserId = 424242;
    store.claimAuthorizedUserId(authorizedUserId);

    const session = store.getOrCreate({
      sessionKey: "-100:18",
      chatId: "-100",
      messageThreadId: "18",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-18");
    store.upsertTurnDelivery({
      turnId: "turn-18",
      threadId: "thread-18",
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      outputMessageId: 299,
    });

    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-18",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-18",
              status: "completed",
              items: [{ type: "agentMessage", id: "a18", text: "never lands", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    const originalSendMessage = api.sendMessage;
    api.editMessageText = async () => {
      throw new Error("telegram edit failed");
    };
    api.sendMessage = async (chatId, text, options) => {
      if (chatId === -100) {
        throw new Error("telegram send failed");
      }
      return originalSendMessage(chatId, text, options);
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await handleCodexNotification(
        {
          method: "turn/completed",
          params: {
            threadId: "thread-18",
            turn: makeTurn({ id: "turn-18", status: "completed", items: [] }),
          },
        },
        store,
        new MessageBuffer(bot, 1, createNoopLogger()),
        bot,
        gateway,
        createNoopLogger(),
      );
    }

    const delivery = store.getTurnDelivery("turn-18");
    assert.equal(delivery?.status, "failed");
    assert.equal(delivery?.failureCount, 5);
    assert.equal(delivery?.alertedAt == null, false);
    const alert = sent.find((message) => message.chatId === authorizedUserId);
    assert.match(alert?.text ?? "", /已停止自动重试/);
    assert.match(alert?.text ?? "", /turn-18/);
  } finally {
    cleanup();
  }
});

test("error notification sends failure text and clears active turn", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:11",
      chatId: "-100",
      messageThreadId: "11",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-2");
    store.setActiveTurn(session.sessionKey, "turn-2");

    const buffers = new MessageBuffer(bot, 1, createNoopLogger());
    const messageId = await buffers.create("thread-2:pending", { chatId: -100, messageThreadId: 11 });
    store.setOutputMessage(session.sessionKey, messageId);
    buffers.rename("thread-2:pending", "thread-2:turn-2");

    await handleCodexNotification(
      {
        method: "error",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          willRetry: false,
          error: {
            message: "apply_patch verification failed",
            additionalDetails: "docs/demo.md",
            codexErrorInfo: null,
          },
        },
      },
      store,
      buffers,
      bot,
      {} as never,
      createNoopLogger(),
    );

    assert.match(edited.at(-1)?.text ?? "", /Codex 出错：Codex 失败：apply_patch verification failed/);
    assert.equal(store.get(session.sessionKey)?.activeTurnId, null);
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "failed");
  } finally {
    cleanup();
  }
});

test("refreshSessionIfActiveTurnIsStale recovers completed turn after restart", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, edited } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:12",
      chatId: "-100",
      messageThreadId: "12",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-3");
    store.setActiveTurn(session.sessionKey, "turn-3");
    store.setOutputMessage(session.sessionKey, 77);

    const buffers = new MessageBuffer(bot, 1, createNoopLogger());
    const gateway = {
      async readThread(): Promise<Thread> {
        return makeThread({
          id: "thread-3",
          status: { type: "notLoaded" },
          turns: [
            makeTurn({
              id: "turn-3",
              status: "completed",
              items: [{ type: "agentMessage", id: "a3", text: "recovered answer", phase: "final_answer", memoryCitation: null }],
            }),
          ],
        });
      },
    } as never;

    await refreshSessionIfActiveTurnIsStale(session, store, gateway, buffers, bot, createNoopLogger());

    assert.equal(edited.at(-1)?.messageId, 77);
    assert.equal(edited.at(-1)?.text, "recovered answer");
    assert.equal(store.get(session.sessionKey)?.activeTurnId, null);
    assert.equal(store.get(session.sessionKey)?.outputMessageId, null);
    assert.equal(store.get(session.sessionKey)?.runtimeStatus, "idle");
    const delivery = store.getTurnDelivery("turn-3");
    assert.equal(delivery?.status, "delivered");
  } finally {
    cleanup();
  }
});

test("refreshLiveSessionHeartbeats refreshes running session timestamps", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:164",
      chatId: "-100",
      messageThreadId: "164",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-164");
    store.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
      activeTurnId: "turn-164",
    });

    await refreshLiveSessionHeartbeats(store, bot, createNoopLogger());

    const updated = store.get(session.sessionKey);
    assert.ok(updated);
    assert.equal(updated?.runtimeStatus, "running");
    assert.ok(Date.parse(updated!.runtimeStatusUpdatedAt) > Date.now() - 30_000);
    assert.match(sent.at(-1)?.text ?? "", /state: <code>running<\/code>/);
  } finally {
    cleanup();
  }
});

test("thread/name/updated syncs Telegram topic title", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, forumEdits } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:13",
      chatId: "-100",
      messageThreadId: "13",
      telegramTopicName: "old",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-4");

    await handleCodexNotification(
      {
        method: "thread/name/updated",
        params: {
          threadId: "thread-4",
          threadName: "New Better Title",
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      {} as never,
      createNoopLogger(),
    );

    assert.equal(forumEdits.at(-1)?.name, "New Better Title");
    assert.equal(store.get(session.sessionKey)?.telegramTopicName, "New Better Title");
  } finally {
    cleanup();
  }
});

test("thread/archived removes binding, deletes telegram topic, and reports to general", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, deletedTopics, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:14",
      chatId: "-100",
      messageThreadId: "14",
      telegramTopicName: "archived",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-archived");

    await handleCodexNotification(
      {
        method: "thread/archived",
        params: {
          threadId: "thread-archived",
        },
      },
      store,
      new MessageBuffer(bot, 1, createNoopLogger()),
      bot,
      {} as never,
      createNoopLogger(),
    );

    assert.equal(store.get(session.sessionKey), null);
    assert.deepEqual(deletedTopics.at(-1), { chatId: -100, messageThreadId: 14 });
    assert.match(sent.at(-1)?.text ?? "", /Codex thread 已归档/);
    assert.equal(sent.at(-1)?.messageThreadId, null);
  } finally {
    cleanup();
  }
});

function makeThread(input: Partial<Thread> & Pick<Thread, "id" | "status" | "turns">): Thread {
  return {
    id: input.id,
    forkedFromId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 0,
    updatedAt: 0,
    status: input.status,
    path: null,
    cwd: process.cwd(),
    cliVersion: "test",
    source: "cli",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: input.turns,
  };
}

function makeTurn(input: {
  id: string;
  status: "completed" | "failed" | "interrupted" | "inProgress";
  items: Thread["turns"][number]["items"];
}) {
  return {
    id: input.id,
    items: input.items,
    status: input.status,
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  };
}
