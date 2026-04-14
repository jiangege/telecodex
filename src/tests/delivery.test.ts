import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError } from "grammy";
import { editHtmlMessage, sendHtmlChunks, sendTypingAction } from "../telegram/delivery.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createNoopLogger, createFakeBot } from "./helpers.js";

test("editHtmlMessage retries on Telegram 429", async () => {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = ((handler: (...args: unknown[]) => void, _timeout?: number, ...args: unknown[]) => {
    handler(...args);
    return { ref() { return this; }, unref() { return this; } } as never;
  }) as unknown as typeof setTimeout;

  let calls = 0;
  const bot = {
    api: {
      async editMessageText() {
        calls += 1;
        if (calls < 3) {
          throw fakeGrammyError("Too Many Requests: retry after 1", 1);
        }
        return true;
      },
    },
  } as never;

  try {
    await editHtmlMessage(
      bot,
      {
        chatId: 1,
        messageId: 2,
        text: "hello",
      },
      createNoopLogger(),
    );
    assert.equal(calls, 3);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("sendHtmlChunks preserves valid html across long formatted messages", async () => {
  const { bot, sent } = createFakeBot();
  const boldText = "alpha ".repeat(900);
  const italicText = "beta ".repeat(900);

  await sendHtmlChunks(
    bot,
    {
      chatId: 1,
      messageThreadId: 2,
      text: `<b>${boldText}</b>\n\n<i>${italicText}</i>`,
    },
    createNoopLogger(),
  );

  assert.ok(sent.length > 1);
  for (const message of sent) {
    assert.ok(message.text.length <= 3900);
    assert.equal(count(message.text, "<b>"), count(message.text, "</b>"));
    assert.equal(count(message.text, "<i>"), count(message.text, "</i>"));
  }
});

test("sendTypingAction targets the current forum topic", async () => {
  const { bot, chatActions } = createFakeBot();

  await sendTypingAction(
    bot,
    {
      chatId: 1,
      messageThreadId: 2,
    },
    createNoopLogger(),
  );

  assert.deepEqual(chatActions, [
    {
      chatId: 1,
      action: "typing",
      messageThreadId: 2,
    },
  ]);
});

test("MessageBuffer.complete falls back to sending a new final message when edit fails", async () => {
  const { bot, api, sent } = createFakeBot();
  const buffer = new MessageBuffer(bot, 1, createNoopLogger());
  const messageId = await buffer.create("thread-final:pending", {
    chatId: 1,
    messageThreadId: 2,
  });

  api.editMessageText = async (chatId, attemptedMessageId, text) => {
    if (attemptedMessageId === messageId && text === "final text") {
      throw new Error("telegram edit failed");
    }
    return true;
  };

  await buffer.complete("thread-final:pending", "final text");

  assert.ok(sent.filter((message) => message.text === "final text").length >= 1);
});

function fakeGrammyError(description: string, retryAfter: number): GrammyError {
  const error = new Error(description) as GrammyError & {
    description: string;
    parameters: { retry_after: number };
  };
  Object.setPrototypeOf(error, GrammyError.prototype);
  error.description = description;
  error.parameters = { retry_after: retryAfter };
  return error;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
