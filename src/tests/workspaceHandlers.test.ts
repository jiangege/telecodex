import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("/workspace without args shows the current working root", async () => {
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
    const handler = commands.get("workspace");
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
    assert.match(output, /workspace: telecodex/);
    assert.match(output, new RegExp(`working root: ${escapeRegExp(process.cwd())}`));
    assert.match(output, /This supergroup uses one shared working root/);
  } finally {
    cleanup();
  }
});

test("/workspace without args prompts for an initial binding in an unbound supergroup", async () => {
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
    const handler = commands.get("workspace");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: "",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", /This supergroup has no working root yet/);
    assert.match(replies.at(-1) ?? "", /Run \/workspace <absolute-path> first/);
  } finally {
    cleanup();
  }
});

test("/workspace rejects a nonexistent directory", async () => {
  const { store, projects, admin, appState, cleanup, bot, commands, threadCatalog, codex } = createDeps();
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-workspace-handler-"));
  const missingDirectory = path.join(dir, "missing");
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
    const handler = commands.get("workspace");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: missingDirectory,
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", new RegExp(`Directory does not exist: ${escapeRegExp(path.resolve(missingDirectory))}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

test("/project replies with the workspace migration hint", async () => {
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
    const handler = commands.get("project");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      match: process.cwd(),
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.match(replies.at(-1) ?? "", /The project command was renamed/);
    assert.match(replies.at(-1) ?? "", /Use \/workspace <absolute-path> to set the working root/);
  } finally {
    cleanup();
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
