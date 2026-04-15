import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError, HttpError } from "grammy";
import { editHtmlMessage, sendHtmlChunks, sendHtmlMessage, sendTypingAction } from "../telegram/delivery.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createNoopLogger, createFakeBot } from "./helpers.js";

test("editHtmlMessage retries on Telegram 429", async () => {
  let calls = 0;
  const bot = {
    api: {
      async editMessageText() {
        calls += 1;
        if (calls < 3) {
          throw fakeGrammyError("Too Many Requests: retry after 0.001", 0.001);
        }
        return true;
      },
    },
  } as never;

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
});

test("editHtmlMessage retries on transient Telegram network errors", async () => {
  let calls = 0;
  const startedAt = Date.now();
  const bot = {
    api: {
      async editMessageText() {
        calls += 1;
        if (calls < 3) {
          throw fakeHttpError("socket hang up", "ECONNRESET");
        }
        return true;
      },
    },
  } as never;

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
  assert.ok(Date.now() - startedAt >= 250);
});

test("sendHtmlMessage does not retry transient network errors", async () => {
  let calls = 0;
  const bot = {
    api: {
      async sendMessage() {
        calls += 1;
        throw fakeHttpError("socket hang up", "ECONNRESET");
      },
    },
  } as never;

  await assert.rejects(
    () =>
      sendHtmlMessage(
        bot,
        {
          chatId: 1,
          messageThreadId: 2,
          text: "hello",
        },
        createNoopLogger(),
      ),
    HttpError,
  );

  assert.equal(calls, 1);
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

test("telegram calls share a bot-level cooldown after a 429", async () => {
  let editCalls = 0;
  let typingCalls = 0;
  let typingStartedAt = 0;
  const bot = {
    api: {
      async editMessageText() {
        editCalls += 1;
        if (editCalls === 1) {
          throw fakeGrammyError("Too Many Requests: retry after 0.001", 0.001);
        }
        return true;
      },
      async sendChatAction() {
        typingCalls += 1;
        typingStartedAt = Date.now();
        return true;
      },
    },
  } as never;

  const startedAt = Date.now();
  const first = editHtmlMessage(
    bot,
    {
      chatId: 1,
      messageId: 2,
      text: "hello",
    },
    createNoopLogger(),
  );

  await flushMicrotasks();
  const second = sendTypingAction(
    bot,
    {
      chatId: 1,
      messageThreadId: 2,
    },
    createNoopLogger(),
  );

  await Promise.all([first, second]);

  assert.equal(editCalls, 2);
  assert.equal(typingCalls, 1);
  assert.ok(typingStartedAt - startedAt >= 150);
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

function fakeHttpError(message: string, code: string): HttpError {
  const cause = Object.assign(new Error(message), { code });
  return new HttpError("Network request for 'editMessageText' failed!", cause);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
