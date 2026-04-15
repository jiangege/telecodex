import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError } from "grammy";
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
  return {
    ...stores,
    bot,
    api,
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
    const readyMessage = sent.find((entry) => entry.text.includes("New topic created."));
    assert.ok(readyMessage);
    assert.equal(readyMessage?.options?.parse_mode, undefined);
    assert.deepEqual(readyMessage?.options?.link_preview_options, { is_disabled: true });
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
    const readyMessage = sent.find((entry) => entry.text.includes("This topic is now bound to an existing Codex thread id."));
    assert.ok(readyMessage);
    assert.equal(readyMessage?.options?.parse_mode, undefined);
    assert.deepEqual(readyMessage?.options?.link_preview_options, { is_disabled: true });
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

test("/thread new replies with a useful error when Telegram denies topic creation", async () => {
  const { store, projects, cleanup, bot, api, commands, createdTopics, threadCatalog } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    api.createForumTopic = async (chatId: number, name: string) => {
      throw new GrammyError(
        "Call to 'createForumTopic' failed!",
        {
          ok: false,
          error_code: 400,
          description: "Bad Request: not enough rights to create a topic",
          parameters: {},
        },
        "createForumTopic",
        { chat_id: chatId, name },
      );
    };

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
      update: { update_id: 401 },
      message: {},
      match: "new Research Thread",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(createdTopics.length, 0);
    assert.match(replies.at(-1) ?? "", /lacks permission to create topics/i);
    assert.match(replies.at(-1) ?? "", /grant topic management/i);
  } finally {
    cleanup();
  }
});

test("/thread list still replies when an unexpected handler error escapes", async () => {
  const { store, projects, cleanup, bot, commands, threadCatalog } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    threadCatalog.listProjectThreads = async () => {
      throw new Error("catalog offline");
    };

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
      update: { update_id: 402 },
      message: {},
      match: "list",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", /catalog offline/);
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
