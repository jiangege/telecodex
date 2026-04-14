import assert from "node:assert/strict";
import test from "node:test";
import { registerHandlers } from "../bot/registerHandlers.js";
import { recordTerminalInteraction } from "../bot/terminalBridge.js";
import { createFakeHandlerBot, createTestStores } from "./helpers.js";

function createConfig() {
  return {
    telegramBotToken: "test-token",
    defaultCwd: process.cwd(),
    allowedCwds: [process.cwd()],
    defaultModel: "gpt-5.4",
    dbPath: "/tmp/telecodex-test.sqlite",
    codexBin: "codex",
    updateIntervalMs: 1000,
  };
}

test("/queue clear refreshes topic status pin after removing queued inputs", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, commands, edited } = createFakeHandlerBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:210",
      chatId: "-100",
      messageThreadId: "210",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setPinnedStatusMessage(session.sessionKey, 2100);
    store.enqueueInput(session.sessionKey, "first");
    store.enqueueInput(session.sessionKey, "second");

    registerHandlers({
      bot,
      approvals: {
        handleCallback: async () => false,
        handleTextReply: async () => false,
      } as never,
      config: createConfig(),
      store,
      projects,
      gateway: {} as never,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("queue");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 210 },
      match: "clear",
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(store.getQueuedInputCount(session.sessionKey), 0);
    assert.match(replies.at(-1) ?? "", /已清空队列/);
    assert.match(edited.at(-1)?.text ?? "", /queue: <code>0<\/code>/);
  } finally {
    cleanup();
  }
});

test("/queue drop refreshes topic status pin after removing one queued input", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, commands, edited } = createFakeHandlerBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:211",
      chatId: "-100",
      messageThreadId: "211",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setPinnedStatusMessage(session.sessionKey, 2110);
    const first = store.enqueueInput(session.sessionKey, "first");
    store.enqueueInput(session.sessionKey, "second");

    registerHandlers({
      bot,
      approvals: {
        handleCallback: async () => false,
        handleTextReply: async () => false,
      } as never,
      config: createConfig(),
      store,
      projects,
      gateway: {} as never,
      buffers: {} as never,
    });

    const replies: string[] = [];
    const handler = commands.get("queue");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      message: { message_thread_id: 211 },
      match: `drop ${first.id}`,
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.equal(store.getQueuedInputCount(session.sessionKey), 1);
    assert.match(replies.at(-1) ?? "", /已移除队列项/);
    assert.match(edited.at(-1)?.text ?? "", /queue: <code>1<\/code>/);
  } finally {
    cleanup();
  }
});

test("message:text routes plain text to terminal stdin when tty input is pending", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, events } = createFakeHandlerBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:212",
      chatId: "-100",
      messageThreadId: "212",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    recordTerminalInteraction(store, session.sessionKey, {
      threadId: "thread-212",
      turnId: "turn-212",
      itemId: "item-212",
      processId: "proc-212",
      stdin: "Enter value:",
    });

    const writes: Array<{ processId: string; text?: string; closeStdin?: boolean }> = [];
    const replies: string[] = [];
    registerHandlers({
      bot,
      approvals: {
        handleCallback: async () => false,
        handleTextReply: async () => {
          throw new Error("approvals should not handle tty input");
        },
      } as never,
      config: createConfig(),
      store,
      projects,
      gateway: {
        writeTerminalInput: async (processId: string, input: { text?: string; closeStdin?: boolean }) => {
          writes.push({ processId, ...input });
        },
        startThread: async () => {
          throw new Error("should not start a new turn");
        },
      } as never,
      buffers: {} as never,
    });

    const handler = events.get("message:text");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      from: { id: 1 },
      message: { text: "123", message_thread_id: 212 },
      reply: async (text: string) => {
        replies.push(text);
        return undefined;
      },
    });

    assert.deepEqual(writes.at(-1), {
      processId: "proc-212",
      text: "123\n",
    });
    assert.match(replies.at(-1) ?? "", /已发送到终端 stdin/);
  } finally {
    cleanup();
  }
});

test("message:text routes plain text to approvals text reply when user input is pending", async () => {
  const { store, projects, cleanup } = createTestStores();
  const { bot, events } = createFakeHandlerBot();
  try {
    projects.upsert({ chatId: "-100", cwd: process.cwd() });
    const session = store.getOrCreate({
      sessionKey: "-100:213",
      chatId: "-100",
      messageThreadId: "213",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.putPendingInteraction({
      interactionId: "tool-213",
      sessionKey: session.sessionKey,
      kind: "tool_user_input",
      requestJson: JSON.stringify({
        id: "req-213",
        method: "item/tool/requestUserInput",
        params: {
          threadId: "thread-213",
          turnId: "turn-213",
          itemId: "item-213",
          questions: [
            {
              id: "lang",
              header: "Language",
              question: "Choose one",
              isOther: false,
              isSecret: false,
              options: [{ label: "TypeScript", description: "preferred" }],
            },
          ],
        },
      }),
    });

    let approvalReplies = 0;
    registerHandlers({
      bot,
      approvals: {
        handleCallback: async () => false,
        handleTextReply: async () => {
          approvalReplies += 1;
          return true;
        },
      } as never,
      config: createConfig(),
      store,
      projects,
      gateway: {
        startThread: async () => {
          throw new Error("should not start a new turn");
        },
      } as never,
      buffers: {} as never,
    });

    const handler = events.get("message:text");
    assert.ok(handler);
    await handler!({
      chat: { id: -100, type: "supergroup" },
      from: { id: 1 },
      message: { text: "TypeScript", message_thread_id: 213 },
      reply: async () => undefined,
    });

    assert.equal(approvalReplies, 1);
  } finally {
    cleanup();
  }
});
