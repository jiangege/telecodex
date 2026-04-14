import assert from "node:assert/strict";
import test from "node:test";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createFakeBot, createNoopLogger } from "./helpers.js";

test("MessageBuffer completes long markdown replies without losing chunks", async () => {
  const { bot, edited, sent } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());
  await buffers.create("thread-1:turn-1", { chatId: 1, messageThreadId: 2 });

  const markdown = [
    "# Final",
    "",
    `**${"alpha ".repeat(900)}**`,
    "",
    "```ts",
    "const value = 1;",
    "```",
    "",
    `${"beta ".repeat(900)}`,
  ].join("\n");

  await buffers.complete("thread-1:turn-1", markdown);

  assert.ok((edited.at(-1)?.text.length ?? 0) <= 3900);
  assert.ok(sent.length >= 2);

  const chunks = [edited.at(-1)?.text ?? "", ...sent.map((message) => message.text)];
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 3900);
    assert.equal(count(chunk, "<b>"), count(chunk, "</b>"));
    assert.equal(count(chunk, "<code>"), count(chunk, "</code>"));
    assert.equal(count(chunk, "<pre>"), count(chunk, "</pre>"));
  }
});

test("MessageBuffer sends a typing pulse while a run is pending", async () => {
  const { bot, chatActions } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());

  await buffers.create("thread-typing:turn-1", { chatId: 1, messageThreadId: 2 });
  await buffers.complete("thread-typing:turn-1", "done");

  assert.deepEqual(chatActions[0], {
    chatId: 1,
    action: "typing",
    messageThreadId: 2,
  });
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
