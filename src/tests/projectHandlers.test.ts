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
  const { bot, api, commands, createdTopics, sent } = createFakeHandlerBot();
  const stores = createTestStores();
  const threadCatalog = createFakeThreadCatalog();
  const codex = {
    isRunning: () => false,
  };
  return {
    ...stores,
    bot,
    api,
    commands,
    createdTopics,
    sent,
    threadCatalog,
    codex,
  };
}

test("/thread new resets the current topic to start a fresh thread", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, sent, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:51",
      chatId: "-100",
      messageThreadId: "51",
      telegramTopicName: "Research Thread",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.bindThread(session.sessionKey, "thread-old");

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 51 },
      match: "new",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 0);
    assert.equal(sent.length, 0);
    const updated = store.get(session.sessionKey);
    assert.equal(updated?.codexThreadId, null);
    assert.equal(updated?.runtimeStatus, "idle");
    assert.match(replies.at(-1) ?? "", /Current topic is ready for a new thread/);
  } finally {
    cleanup();
  }
});

test("/thread resume binds the current topic to a known thread id", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, sent, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    store.getOrCreate({
      sessionKey: "-100:52",
      chatId: "-100",
      messageThreadId: "52",
      telegramTopicName: "Resume Here",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
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
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 52 },
      match: "resume thread-401",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 0);
    assert.equal(sent.length, 0);
    const updated = store.get("-100:52");
    assert.equal(updated?.codexThreadId, "thread-401");
    assert.equal(updated?.runtimeStatus, "idle");
    assert.match(replies.at(-1) ?? "", /Current topic is now bound to the existing thread id/);
  } finally {
    cleanup();
  }
});

test("/thread list shows saved project threads from the Codex session catalog", async () => {
  const { store, projects, cleanup, bot, commands, threadCatalog, codex } = createDeps();
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
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: Array<{ text: string; options: unknown }> = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "list",
      reply: async (text: string, options?: unknown) => {
        replies.push({ text, options: options ?? null });
        return undefined;
      },
    });

    const reply = replies.at(-1);
    assert.ok(reply);
    const options = reply.options as {
      parse_mode?: string;
      entities?: Array<{ type: string; offset: number; length: number }>;
      reply_markup?: unknown;
    };
    assert.equal(options.parse_mode, undefined);
    assert.equal(options.reply_markup, undefined);
    const output = reply.text;
    assert.match(output, /Saved Codex threads/);
    assert.match(output, /project: telecodex/);
    assert.match(output, /First saved thread/);
    assert.match(output, /id: thread-1/);
    assert.match(output, /resume: \/thread resume thread-1/);
    assert.match(output, /Second saved thread/);
    assert.match(output, /bound: Bound Topic/);
    assert.match(output, /Copy an id or resume command from the code-formatted fields above/);
    assert.ok(hasEntity(options.entities, output, "bold", "Saved Codex threads"));
    assert.ok(hasEntity(options.entities, output, "code", "telecodex"));
    assert.ok(hasEntity(options.entities, output, "bold", "1. First saved thread"));
    assert.ok(hasEntity(options.entities, output, "code", "thread-1"));
    assert.ok(hasEntity(options.entities, output, "code", "/thread resume thread-1"));
  } finally {
    cleanup();
  }
});

test("/thread new requires an existing topic context", async () => {
  const { store, projects, cleanup, bot, commands, createdTopics, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "new",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 0);
    assert.match(replies.at(-1) ?? "", /Create or open a Telegram forum topic/);
  } finally {
    cleanup();
  }
});

test("/thread resume refuses to change binding while queued messages exist", async () => {
  const { store, projects, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:60",
      chatId: "-100",
      messageThreadId: "60",
      telegramTopicName: "Queued Topic",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.enqueueInput(session.sessionKey, "queued work");
    threadCatalog.setThreads([
      {
        id: "thread-queued",
        cwd: process.cwd(),
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T01:00:00.000Z",
        preview: "Queued thread",
        source: "cli",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-queued.jsonl",
      },
    ]);

    registerHandlers({
      bot,
      config: createConfig(),
      store,
      projects,
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 60 },
      match: "resume thread-queued",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", /Clear 1 queued message\(s\) before changing the thread binding/);
    assert.equal(store.get(session.sessionKey)?.codexThreadId, null);
  } finally {
    cleanup();
  }
});

function hasEntity(
  entities: Array<{ type: string; offset: number; length: number }> | undefined,
  text: string,
  type: string,
  value: string,
): boolean {
  const offset = text.indexOf(value);
  return entities?.some((entity) => entity.type === type && entity.offset === offset && entity.length === value.length) ?? false;
}
