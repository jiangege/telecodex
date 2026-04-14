import assert from "node:assert/strict";
import test from "node:test";
import { handleTerminalCommand, handleTerminalTextReply, recordTerminalInteraction } from "../bot/terminalBridge.js";
import { createNoopLogger, createTestSessionStore } from "./helpers.js";

test("plain telegram text is forwarded to pending terminal stdin", async () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:90",
      chatId: "-100",
      messageThreadId: "90",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    recordTerminalInteraction(store, session.sessionKey, {
      threadId: "thread-90",
      turnId: "turn-90",
      itemId: "item-90",
      processId: "proc-90",
      stdin: "Enter value:",
    });

    const writes: Array<{ processId: string; text?: string; closeStdin?: boolean }> = [];
    const replies: string[] = [];
    const gateway = {
      writeTerminalInput: async (processId: string, input: { text?: string; closeStdin?: boolean }) => {
        writes.push({ processId, ...input });
      },
    } as never;

    const handled = await handleTerminalTextReply({
      ctx: {
        chat: { id: -100 },
        message: { text: "123", message_thread_id: 90 },
        reply: async (text: string) => {
          replies.push(text);
          return undefined;
        },
      } as never,
      store,
      gateway,
      logger: createNoopLogger(),
    });

    assert.equal(handled, true);
    assert.deepEqual(writes.at(-1), {
      processId: "proc-90",
      text: "123\n",
    });
    assert.match(replies.at(-1) ?? "", /stdin/);
  } finally {
    cleanup();
  }
});

test("/tty close closes stdin and clears pending terminal state", async () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:91",
      chatId: "-100",
      messageThreadId: "91",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    recordTerminalInteraction(store, session.sessionKey, {
      threadId: "thread-91",
      turnId: "turn-91",
      itemId: "item-91",
      processId: "proc-91",
      stdin: "Password:",
    });

    const writes: Array<{ processId: string; text?: string; closeStdin?: boolean }> = [];
    const replies: string[] = [];
    const gateway = {
      writeTerminalInput: async (processId: string, input: { text?: string; closeStdin?: boolean }) => {
        writes.push({ processId, ...input });
      },
      terminateTerminalProcess: async () => undefined,
    } as never;

    await handleTerminalCommand({
      ctx: {
        match: "close",
        reply: async (text: string) => {
          replies.push(text);
          return undefined;
        },
      } as never,
      session,
      store,
      gateway,
      logger: createNoopLogger(),
    });

    assert.deepEqual(writes.at(-1), {
      processId: "proc-91",
      closeStdin: true,
    });
    assert.equal(store.getOldestPendingInteractionForSession(session.sessionKey, ["terminal_stdin"]), null);
    assert.match(replies.at(-1) ?? "", /关闭/);
  } finally {
    cleanup();
  }
});
