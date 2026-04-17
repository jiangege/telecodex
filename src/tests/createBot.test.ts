import assert from "node:assert/strict";
import test from "node:test";
import { wireBot } from "../bot/createBot.js";
import { createFakeHandlerBot, createFakeThreadCatalog, createNoopLogger, createTestStores } from "./helpers.js";

function createConfig() {
  return {
    telegramBotToken: "test-token",
    defaultCwd: process.cwd(),
    defaultModel: "gpt-5.4",
    codexBin: "codex",
    updateIntervalMs: 1,
  };
}

test("wireBot runs startup topic cleanup and removes stale topic bindings", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, api } = createFakeHandlerBot();
  const threadCatalog = createFakeThreadCatalog();

  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:31",
      chatId: "-100",
      messageThreadId: "31",
      telegramTopicName: "Stale topic",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    api.sendChatAction = async (_chatId, _action, options) => {
      if (options?.message_thread_id === 31) {
        throw new Error("Bad Request: forum topic not found");
      }
      return true;
    };

    wireBot({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {
        isRunning: () => false,
      } as never,
      threadCatalog,
      bootstrapCode: null,
      logger: createNoopLogger(),
    });

    await waitFor(() => store.get(session.sessionKey) === null);
    assert.equal(store.get(session.sessionKey), null);
  } finally {
    cleanup();
  }
});

test("wireBot syncs Telegram command menus for private chats and groups", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, botCommands } = createFakeHandlerBot();
  const threadCatalog = createFakeThreadCatalog();

  try {
    wireBot({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {
        isRunning: () => false,
      } as never,
      threadCatalog,
      bootstrapCode: null,
      logger: createNoopLogger(),
    });

    await waitFor(() => botCommands.length === 2);
    assert.deepEqual(botCommands.map((entry) => entry.scope), [
      { type: "all_private_chats" },
      { type: "all_group_chats" },
    ]);
    assert.ok(botCommands[0]?.commands.some((entry) => entry.command === "admin"));
    assert.ok(botCommands[0]?.commands.some((entry) => entry.description === "Show or hand off admin access"));
    assert.ok(botCommands[1]?.commands.some((entry) => entry.command === "help"));
    assert.ok(botCommands[1]?.commands.some((entry) => entry.command === "thread"));
    assert.ok(botCommands[1]?.commands.some((entry) => entry.description === "List, resume, or create topics"));
    assert.ok(botCommands[1]?.commands.every((entry) => entry.command !== "queue"));
  } finally {
    cleanup();
  }
});

test("wireBot can defer startup initialization until explicitly requested", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, botCommands } = createFakeHandlerBot();
  const threadCatalog = createFakeThreadCatalog();

  try {
    const wired = wireBot({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {
        isRunning: () => false,
      } as never,
      threadCatalog,
      bootstrapCode: null,
      logger: createNoopLogger(),
      autoInitialize: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(botCommands.length, 0);

    await wired.initializeRuntime();
    await waitFor(() => botCommands.length === 2);
    assert.equal(botCommands.length, 2);
  } finally {
    cleanup();
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), "condition was not met before timeout");
}
