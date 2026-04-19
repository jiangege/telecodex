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
  const { store, projects, admin, appState, cleanup, bot, commands, createdTopics, sent, threadCatalog, codex } = createDeps();
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
      sessions: store,
      projects,
      admin,
      appState,
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
  const { store, projects, admin, appState, cleanup, bot, commands, createdTopics, sent, threadCatalog, codex } = createDeps();
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
      sessions: store,
      projects,
      admin,
      appState,
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: Array<{ text: string; options: unknown }> = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 52 },
      match: "resume thread-401",
      reply: async (text: string, options?: unknown) => {
        replies.push({ text, options: options ?? null });
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 0);
    assert.equal(sent.length, 0);
    const updated = store.get("-100:52");
    assert.equal(updated?.codexThreadId, "thread-401");
    assert.equal(updated?.runtimeStatus, "idle");
    const reply = replies.at(-1);
    assert.ok(reply);
    const options = reply.options as {
      entities?: Array<{ type: string; offset: number; length: number }>;
    };
    const output = reply.text;
    assert.match(output, /Current topic is now bound to the existing thread id/);
    assert.match(output, /thread: thread-401/);
    assert.match(output, /codex resume --include-non-interactive 'thread-401'/);
    assert.ok(hasEntity(options.entities, output, "pre", `cd '${process.cwd()}' && codex resume --include-non-interactive 'thread-401'`));
  } finally {
    cleanup();
  }
});

test("/thread shows a pc resume command for the current SDK thread", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  try {
    const projectRoot = process.cwd();
    projects.upsert({ chatId: "-100", cwd: projectRoot });
    const session = store.getOrCreate({
      sessionKey: "-100:61",
      chatId: "-100",
      messageThreadId: "61",
      telegramTopicName: "Phone Thread",
      defaultCwd: projectRoot,
      defaultModel: "gpt-5.4",
    });
    store.bindThread(session.sessionKey, "thread-sdk-1");

    registerHandlers({
      bot,
      config: createConfig(),
      sessions: store,
      projects,
      admin,
      appState,
      codex: codex as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: Array<{ text: string; options: unknown }> = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 61 },
      match: "",
      reply: async (text: string, options?: unknown) => {
        replies.push({ text, options: options ?? null });
        return undefined;
      },
    });

    const reply = replies.at(-1);
    assert.ok(reply);
    const options = reply.options as {
      entities?: Array<{ type: string; offset: number; length: number }>;
    };
    const output = reply.text;
    assert.match(output, /Current thread/);
    assert.match(output, /pc resume:\n\ncd '/);
    assert.match(output, /codex resume --include-non-interactive 'thread-sdk-1'/);
    assert.match(output, /Use \/status for runtime state and recent SDK events/);
    assert.match(output, /SDK-created threads may not appear in Codex Desktop yet/);
    assert.doesNotMatch(output, /\nstate:/);
    assert.ok(hasEntity(options.entities, output, "pre", `cd '${projectRoot}' && codex resume --include-non-interactive 'thread-sdk-1'`));
  } finally {
    cleanup();
  }
});

test("/thread list shows saved project threads from the Codex session catalog", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
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
      sessions: store,
      projects,
      admin,
      appState,
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
    assert.match(output, /workspace: telecodex/);
    assert.match(output, /First saved thread/);
    assert.match(output, /id: thread-1/);
    assert.match(output, /resume: \/thread resume thread-1/);
    assert.match(output, /pc resume:\n\ncd '/);
    assert.match(output, /codex resume --include-non-interactive 'thread-1'/);
    assert.match(output, /Second saved thread/);
    assert.match(output, /bound: Bound Topic/);
    assert.match(output, /Copy a thread id or the pc resume command above/);
    assert.ok(hasEntity(options.entities, output, "bold", "Saved Codex threads"));
    assert.ok(hasEntity(options.entities, output, "code", "telecodex"));
    assert.ok(hasEntity(options.entities, output, "bold", "1. First saved thread"));
    assert.ok(hasEntity(options.entities, output, "code", "thread-1"));
    assert.ok(hasEntity(options.entities, output, "code", "/thread resume thread-1"));
    assert.ok(hasEntity(options.entities, output, "pre", `cd '${projectRoot}' && codex resume --include-non-interactive 'thread-1'`));
  } finally {
    cleanup();
  }
});

test("/thread new requires an existing topic context", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, createdTopics, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });

    registerHandlers({
      bot,
      config: createConfig(),
      sessions: store,
      projects,
      admin,
      appState,
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

test("/thread resume refuses to change binding while a run is active", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:60",
      chatId: "-100",
      messageThreadId: "60",
      telegramTopicName: "Busy Topic",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: null,
      updatedAt: new Date().toISOString(),
    });
    threadCatalog.setThreads([
      {
        id: "thread-busy",
        cwd: process.cwd(),
        createdAt: "2026-04-15T00:00:00.000Z",
        updatedAt: "2026-04-15T01:00:00.000Z",
        preview: "Busy thread",
        source: "cli",
        modelProvider: "openai",
        sessionPath: "/tmp/thread-busy.jsonl",
      },
    ]);

    registerHandlers({
      bot,
      config: createConfig(),
      sessions: store,
      projects,
      admin,
      appState,
      codex: {
        isRunning: (sessionKey: string) => sessionKey === session.sessionKey,
      } as never,
      threadCatalog,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("thread");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 60 },
      match: "resume thread-busy",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", /Stop the current run before changing the thread binding/);
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
