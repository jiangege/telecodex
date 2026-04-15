import assert from "node:assert/strict";
import test from "node:test";
import { registerHandlers } from "../bot/registerHandlers.js";
import { createFakeHandlerBot, createFakeThreadCatalog, createTestStores } from "./helpers.js";

function createConfig() {
  return {
    telegramBotToken: "test-token",
    defaultCwd: process.cwd(),
    defaultModel: "gpt-5.4",
    codexBin: "codex",
    updateIntervalMs: 1000,
  };
}

function createDeps() {
  const { bot, commands, createdTopics, sent } = createFakeHandlerBot();
  const stores = createTestStores();
  const threadCatalog = createFakeThreadCatalog();
  return {
    ...stores,
    bot,
    commands,
    createdTopics,
    sent,
    threadCatalog,
  };
}

test("/thread new creates a fresh topic session and posts a ready message", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, sent, threadCatalog } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {} as never,
      threadCatalog,
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
  const { store, projects, cleanup, bot, commands, createdTopics, sent, threadCatalog } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    threadCatalog.setThreads([
      {
        id: "thread-401",
        cwd: process.cwd(),
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T01:00:00.000Z",
        preview: "Existing thread 401",
        source: "cli",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-401.jsonl",
      },
    ]);

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {} as never,
      threadCatalog,
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

test("/thread list shows saved project threads from the Codex session catalog", async () => {
  const { store, projects, cleanup, bot, commands, threadCatalog } = createDeps();
  try {
    const projectRoot = process.cwd();
    projects.upsert({ chatId: "-100", cwd: projectRoot, name: "telecodex" });
    threadCatalog.setThreads([
      {
        id: "thread-1",
        cwd: projectRoot,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T01:00:00.000Z",
        preview: "First saved thread",
        source: "cli",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-1.jsonl",
      },
      {
        id: "thread-2",
        cwd: `${projectRoot}/src`,
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T02:00:00.000Z",
        preview: "Second saved thread",
        source: "vscode",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-2.jsonl",
      },
    ]);
    store.getOrCreate({
      sessionKey: "-100:88",
      chatId: "-100",
      messageThreadId: "88",
      telegramTopicName: "Bound Topic",
      defaultCwd: projectRoot,
      defaultModel: "gpt-5.4",
    });
    store.bindThread("-100:88", "thread-2");

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: {} as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "list",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    const output = replies.at(-1) ?? "";
    assert.match(output, /Saved Codex threads for telecodex/);
    assert.match(output, /First saved thread/);
    assert.match(output, /id: thread-1/);
    assert.match(output, /Second saved thread/);
    assert.match(output, /bound: Bound Topic/);
    assert.match(output, /Resume one with \/thread resume <threadId>/);
  } finally {
    cleanup();
  }
});
