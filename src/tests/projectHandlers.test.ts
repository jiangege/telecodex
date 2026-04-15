import assert from "node:assert/strict";
import test from "node:test";
import { registerHandlers } from "../bot/registerHandlers.js";
import { createFakeHandlerBot, createTestStores } from "./helpers.js";

function createConfig() {
  return {
    telegramBotToken: "test-token",
    defaultCwd: process.cwd(),
    defaultModel: "gpt-5.4",
    dbPath: "/tmp/telecodex-test.sqlite",
    codexBin: "codex",
    updateIntervalMs: 1000,
  };
}

function createDeps() {
  const { bot, commands, createdTopics, sent } = createFakeHandlerBot();
  const stores = createTestStores();
  return {
    ...stores,
    bot,
    commands,
    createdTopics,
    sent,
  };
}

test("/thread new creates a fresh topic session and posts a ready message", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, sent } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {} as never,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "new Research Thread",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 1);
    assert.equal(createdTopics[0]?.name, "Research Thread");
    const session = store.get(`-100:${createdTopics[0]!.messageThreadId}`);
    assert.ok(session);
    assert.equal(session?.codexThreadId, null);
    assert.equal(session?.cwd, process.cwd());
    assert.ok(sent.some((entry) => entry.text.includes("New topic created.")));
    assert.match(replies.at(-1) ?? "", /Created a new topic/);
  } finally {
    cleanup();
  }
});

test("/thread resume creates a topic and binds it to a known thread id", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, sent } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {} as never,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "resume thread-401",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 1);
    const session = store.get(`-100:${createdTopics[0]!.messageThreadId}`);
    assert.ok(session);
    assert.equal(session?.codexThreadId, "thread-401");
    assert.ok(sent.some((entry) => entry.text.includes("This topic is now bound to an existing Codex thread id.")));
    assert.match(replies.at(-1) ?? "", /Created a topic and bound it to the existing thread id/);
  } finally {
    cleanup();
  }
});
