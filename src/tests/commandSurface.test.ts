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

test("/status in private chat redirects users to /admin", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  try {
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
    const handler = commands.get("status");
    assert.ok(handler);
    await handler!({
      chat: { id: 101, type: "private" },
      match: "",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    const output = replies.at(-1) ?? "";
    assert.match(output, /Use \/admin in the bot private chat/);
    assert.match(output, /\/status is for workspace and topic runtime state/);
  } finally {
    cleanup();
  }
});

test("/yolo replies with the /mode migration hint and does not mutate session state", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:71",
      chatId: "-100",
      messageThreadId: "71",
      telegramTopicName: "Config Topic",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

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
    const handler = commands.get("yolo");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 71 },
      match: "on",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    const output = replies.at(-1) ?? "";
    assert.match(output, /The \/yolo command was removed/);
    assert.match(output, /Use \/mode yolo to enable the YOLO preset/);
    assert.match(output, /Use \/mode write to return to the standard write preset/);
    const latest = store.get(session.sessionKey);
    assert.equal(latest?.sandboxMode, "read-only");
    assert.equal(latest?.approvalPolicy, "on-request");
  } finally {
    cleanup();
  }
});

test("/help no longer advertises sandbox or approval as public commands", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd(), name: "telecodex" });

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
    const handler = commands.get("help");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    const output = replies.at(-1) ?? "";
    assert.match(output, /\/mode read\|write\|danger\|yolo/);
    assert.doesNotMatch(output, /\/sandbox /);
    assert.doesNotMatch(output, /\/approval /);
  } finally {
    cleanup();
  }
});
