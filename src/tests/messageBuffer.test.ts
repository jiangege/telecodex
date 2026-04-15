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

test("MessageBuffer starts as starting and switches to working after turn start", async () => {
  const { bot, sent, edited } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());

  await buffers.create("thread-phase:turn-1", { chatId: 1, messageThreadId: 2 });
  assert.match(sent[0]?.text ?? "", /Starting Codex/);

  buffers.markTurnStarted("thread-phase:turn-1");
  await delay(4);

  assert.ok(edited.some((entry) => entry.text.includes("Codex is working...")));
  await buffers.complete("thread-phase:turn-1", "done");
});

test("MessageBuffer stops typing after idle activity and resumes on new progress", async () => {
  const { bot, chatActions } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger(), {
    activityPulseIntervalMs: 2,
    activityIdleMs: 5,
  });

  await buffers.create("thread-idle:turn-1", { chatId: 1, messageThreadId: 2 });
  await delay(12);

  const stoppedCount = chatActions.length;
  await delay(8);
  assert.equal(chatActions.length, stoppedCount);

  buffers.note("thread-idle:turn-1", "still working");
  await delay(4);
  assert.ok(chatActions.length > stoppedCount);

  await buffers.complete("thread-idle:turn-1", "done");
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
