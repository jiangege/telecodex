import assert from "node:assert/strict";
import test from "node:test";
import { cleanupMissingTopicBindings } from "../bot/topicCleanup.js";
import { createFakeBot, createNoopLogger, createTestStores } from "./helpers.js";

test("cleanupMissingTopicBindings removes stale topic sessions whose Telegram topics are gone", async () => {
  const { store, cleanup } = createTestStores();
  const { bot, api } = createFakeBot();
  try {
    const stale = store.getOrCreate({
      sessionKey: "-100:21",
      chatId: "-100",
      messageThreadId: "21",
      telegramTopicName: "Stale",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.bindThread(stale.sessionKey, "thread-stale");

    const live = store.getOrCreate({
      sessionKey: "-100:22",
      chatId: "-100",
      messageThreadId: "22",
      telegramTopicName: "Live",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    api.sendChatAction = async (_chatId, _action, options) => {
      if (options?.message_thread_id === 21) {
        throw new Error("Bad Request: message thread not found");
      }
      return true;
    };

    const summary = await cleanupMissingTopicBindings({
      bot,
      store,
      logger: createNoopLogger(),
    });

    assert.deepEqual(summary, {
      total: 2,
      checked: 2,
      kept: 1,
      removed: 1,
      skipped: 0,
      failed: 0,
    });
    assert.equal(store.get(stale.sessionKey), null);
    assert.ok(store.get(live.sessionKey));
  } finally {
    cleanup();
  }
});

test("cleanupMissingTopicBindings keeps sessions when the probe fails for a non-missing-topic reason", async () => {
  const { store, cleanup } = createTestStores();
  const { bot, api } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:23",
      chatId: "-100",
      messageThreadId: "23",
      telegramTopicName: "Blocked",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    api.sendChatAction = async () => {
      throw new Error("Forbidden: bot was kicked from the supergroup chat");
    };

    const summary = await cleanupMissingTopicBindings({
      bot,
      store,
      logger: createNoopLogger(),
    });

    assert.deepEqual(summary, {
      total: 1,
      checked: 1,
      kept: 0,
      removed: 0,
      skipped: 0,
      failed: 1,
    });
    assert.ok(store.get(session.sessionKey));
  } finally {
    cleanup();
  }
});
