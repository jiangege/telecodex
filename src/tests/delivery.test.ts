import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { GrammyError, HttpError } from "grammy";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  editTextMessage,
  sendMediaMessage,
  sendTextChunks,
  sendTextMessage,
  sendTypingAction,
  splitRenderedText,
} from "../telegram/delivery.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createNoopLogger, createFakeBot } from "./helpers.js";

test("editTextMessage retries on Telegram 429", async () => {
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

  await editTextMessage(
    bot,
    {
      chatId: 1,
      messageId: 2,
      message: { text: "hello" },
    },
    createNoopLogger(),
  );
  assert.equal(calls, 3);
});

test("editTextMessage retries on transient Telegram network errors", async () => {
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

  await editTextMessage(
    bot,
    {
      chatId: 1,
      messageId: 2,
      message: { text: "hello" },
    },
    createNoopLogger(),
  );

  assert.equal(calls, 3);
  assert.ok(Date.now() - startedAt >= 250);
});

test("sendTextMessage does not retry transient network errors", async () => {
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
      sendTextMessage(
        bot,
        {
          chatId: 1,
          messageThreadId: 2,
          message: { text: "hello" },
        },
        createNoopLogger(),
      ),
    HttpError,
  );

  assert.equal(calls, 1);
});

test("sendTextChunks preserves entities across long formatted messages", async () => {
  const { bot, sent } = createFakeBot();
  const boldText = "alpha ".repeat(900);
  const italicText = "beta ".repeat(900);
  const text = `${boldText}\n\n${italicText}`;

  await sendTextChunks(
    bot,
    {
      chatId: 1,
      messageThreadId: 2,
      message: {
        text,
        entities: [
          { type: "bold", offset: 0, length: boldText.length },
          { type: "italic", offset: boldText.length + 2, length: italicText.length },
        ],
      },
    },
    createNoopLogger(),
  );

  assert.ok(sent.length > 1);
  for (const message of sent) {
    assert.ok(message.text.length <= 3900);
    const entities = (message.options?.entities as Array<{ type: string }> | undefined) ?? [];
    assert.ok(entities.length > 0);
  }
});

test("splitRenderedText preserves grapheme clusters and entity coverage", () => {
  const familyEmoji = "👨‍👩‍👧‍👦";
  const text = familyEmoji.repeat(4);
  const chunks = splitRenderedText(
    {
      text,
      entities: [{ type: "bold", offset: 0, length: text.length }],
    },
    familyEmoji.length + 1,
  );

  assert.deepEqual(chunks.map((chunk) => chunk.text), [familyEmoji, familyEmoji, familyEmoji, familyEmoji]);
  assert.equal(chunks.map((chunk) => chunk.text).join(""), text);
  for (const chunk of chunks) {
    assert.deepEqual(chunk.entities, [{ type: "bold", offset: 0, length: familyEmoji.length }]);
  }
});

test("splitRenderedText preserves pre language when slicing long code blocks", () => {
  const line = 'console.log("x");\n';
  const text = line.repeat(300);
  const chunks = splitRenderedText(
    {
      text,
      entities: [{ type: "pre", offset: 0, length: text.length, language: "ts" }],
    },
    500,
  );

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.deepEqual(chunk.entities, [{ type: "pre", offset: 0, length: chunk.text.length, language: "ts" }]);
  }
});

test("sendMediaMessage truncates captions and preserves caption entities", async () => {
  const { bot, sentPhotos } = createFakeBot();
  const workingRoot = mkdtempSync(path.join(tmpdir(), "telecodex-caption-"));
  const imagePath = path.join(workingRoot, "caption.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    const boldText = "A".repeat(900);
    const linkedText = "B".repeat(200);
    await sendMediaMessage(
      bot,
      {
        chatId: 1,
        messageThreadId: 2,
        source: imagePath,
        scope: {
          workingRoot,
        },
        caption: {
          caption: `${boldText}${linkedText}`,
          caption_entities: [
            { type: "bold", offset: 0, length: boldText.length },
            { type: "text_link", offset: boldText.length, length: linkedText.length, url: "https://example.com/caption" },
          ],
        },
      },
      createNoopLogger(),
    );

    assert.equal(sentPhotos.length, 1);
    assert.equal(sentPhotos[0]?.options?.caption, `${boldText}${linkedText.slice(0, 124)}`);
    assert.deepEqual(sentPhotos[0]?.options?.caption_entities, [
      { type: "bold", offset: 0, length: 900 },
      { type: "text_link", offset: 900, length: 124, url: "https://example.com/caption" },
    ]);
  } finally {
    rmSync(workingRoot, { recursive: true, force: true });
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
  const first = editTextMessage(
    bot,
    {
      chatId: 1,
      messageId: 2,
      message: { text: "hello" },
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
