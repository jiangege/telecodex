import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../generated/codex-app-server/v2/Thread.js";
import { createReconcileTelegramTopicsTask } from "../maintenance/tasks/reconcileTelegramTopics.js";
import { createFakeBot, createNoopLogger, createTestSessionStore } from "./helpers.js";

test("reconciler removes archived codex thread bindings and deletes telegram topics", async () => {
  const { store, cleanup } = createTestSessionStore();
  const { bot, deletedTopics, sent } = createFakeBot();
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

    const gateway = {
      async readThread(): Promise<Thread> {
        return {
          id: "thread-21",
          forkedFromId: null,
          preview: "preview",
          ephemeral: false,
          modelProvider: "openai",
          createdAt: 0,
          updatedAt: 0,
          status: { type: "notLoaded" },
          path: "/tmp/archived_sessions/demo/thread-21.json",
          cwd: process.cwd(),
          cliVersion: "test",
          source: "cli",
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: "archived",
          turns: [],
        };
      },
    } as never;

    const task = createReconcileTelegramTopicsTask({
      bot,
      store,
      gateway,
      logger: createNoopLogger(),
    });

    await task.run({ logger: createNoopLogger() });

    assert.equal(store.get(session.sessionKey), null);
    assert.deepEqual(deletedTopics.at(-1), { chatId: -100, messageThreadId: 21 });
    assert.match(sent.at(-1)?.text ?? "", /Codex thread 已归档/);
    assert.equal(sent.at(-1)?.messageThreadId, null);
  } finally {
    cleanup();
  }
});
