import assert from "node:assert/strict";
import test from "node:test";
import { updateTopicStatusPin } from "../telegram/topicStatus.js";
import { createFakeBot, createNoopLogger, createTestSessionStore } from "./helpers.js";

test("updateTopicStatusPin shows running state and active turn", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, sent } = createFakeBot();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:21",
      chatId: "-100",
      messageThreadId: "21",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setThread(session.sessionKey, "thread-21");
    store.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date().toISOString(),
      activeTurnId: "turn-21",
    });

    await updateTopicStatusPin(bot, store, session, createNoopLogger());

    const text = sent.at(-1)?.text ?? "";
    assert.match(text, /state: <code>running<\/code>/);
    assert.match(text, /active turn: <code>turn-21<\/code>/);
  } finally {
    cleanup();
  }
});
