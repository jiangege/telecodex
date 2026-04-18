import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { InputFile } from "grammy";
import { tmpdir } from "node:os";
import path from "node:path";
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
  assert.match(sent[0]?.text ?? "", /Starting\.\.\./);

  buffers.markTurnStarted("thread-phase:turn-1");
  await delay(4);

  assert.ok(edited.some((entry) => entry.text.includes("Working...")));
  await buffers.complete("thread-phase:turn-1", "done");
});

test("MessageBuffer renders structured working sections as Telegram HTML", async () => {
  const { bot, edited } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());

  await buffers.create("thread-structured:turn-1", { chatId: 1, messageThreadId: 2 });
  buffers.markTurnStarted("thread-structured:turn-1");
  buffers.setPlan("thread-structured:turn-1", "[todo] inspect logs\n[done] confirm repro");
  buffers.setReasoningSummary("thread-structured:turn-1", "Comparing the failing path with the successful one.");
  buffers.note("thread-structured:turn-1", "Running command: npm test -- runInBand");
  buffers.setReplyDraft("thread-structured:turn-1", "## Draft\n\nNeed one guard clause.");
  buffers.setToolOutput("thread-structured:turn-1", "stderr line 1\nstdout line 2");

  await delay(4);

  const latest = edited.at(-1)?.text ?? "";
  assert.match(latest, /<b>Working\.\.\.<\/b>/);
  assert.match(latest, /<b>Plan<\/b>/);
  assert.match(latest, /<b>Reasoning<\/b>/);
  assert.match(latest, /<blockquote>/);
  assert.match(latest, /<b>Activity<\/b>/);
  assert.match(latest, /<b>Reply Draft<\/b>/);
  assert.match(latest, /<b>Draft<\/b>/);
  assert.match(latest, /<b>Terminal<\/b>/);
  assert.match(latest, /<pre><code>stderr line 1/);

  await buffers.complete("thread-structured:turn-1", "done");
});

test("MessageBuffer keeps typing active until the run completes", async () => {
  const { bot, chatActions } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger(), {
    activityPulseIntervalMs: 2,
  });

  await buffers.create("thread-idle:turn-1", { chatId: 1, messageThreadId: 2 });
  await delay(12);

  const pulseCount = chatActions.length;
  await delay(8);
  assert.ok(chatActions.length > pulseCount);

  await buffers.complete("thread-idle:turn-1", "done");
});

test("MessageBuffer.complete sends markdown image references as Telegram media", async () => {
  const { bot, edited, sentPhotos } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());
  const projectRoot = mkdtempSync(path.join(tmpdir(), "telecodex-media-"));
  const imagePath = path.join(projectRoot, "mockup.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    await buffers.create("thread-media:turn-1", { chatId: 1, messageThreadId: 2 });
    await buffers.complete(
      "thread-media:turn-1",
      `Result below.\n\n![Mockup](${imagePath})`,
      {
        mediaScope: {
          projectRoot,
          workingDirectory: projectRoot,
        },
      },
    );

    assert.match(edited.at(-1)?.text ?? "", /Result below\./);
    assert.equal(sentPhotos.length, 1);
    assert.equal(sentPhotos[0]?.chatId, 1);
    assert.equal(sentPhotos[0]?.messageThreadId, 2);
    assert.ok(sentPhotos[0]?.photo instanceof InputFile);
    assert.equal(sentPhotos[0]?.options?.caption, "Mockup");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("MessageBuffer.complete keeps image alt text when the final reply only contains images", async () => {
  const { bot, edited, sentPhotos } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());
  const projectRoot = mkdtempSync(path.join(tmpdir(), "telecodex-media-"));
  const imagePath = path.join(projectRoot, "concept.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    await buffers.create("thread-media-only:turn-1", { chatId: 1, messageThreadId: 2 });
    await buffers.complete(
      "thread-media-only:turn-1",
      `![Generated concept](${imagePath})`,
      {
        mediaScope: {
          projectRoot,
          workingDirectory: projectRoot,
        },
      },
    );

    assert.match(edited.at(-1)?.text ?? "", /Generated concept/);
    assert.equal(sentPhotos.length, 1);
    assert.equal(sentPhotos[0]?.options?.caption, "Generated concept");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("MessageBuffer.complete does not send images outside the project root", async () => {
  const { bot, edited, sentPhotos } = createFakeBot();
  const buffers = new MessageBuffer(bot, 1, createNoopLogger());
  const projectRoot = mkdtempSync(path.join(tmpdir(), "telecodex-media-root-"));
  const externalRoot = mkdtempSync(path.join(tmpdir(), "telecodex-media-external-"));
  const imagePath = path.join(externalRoot, "escaped.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  try {
    await buffers.create("thread-media-blocked:turn-1", { chatId: 1, messageThreadId: 2 });
    await buffers.complete(
      "thread-media-blocked:turn-1",
      `Result below.\n\n![Escaped](${imagePath})`,
      {
        mediaScope: {
          projectRoot,
          workingDirectory: projectRoot,
        },
      },
    );

    assert.match(edited.at(-1)?.text ?? "", /Result below\./);
    assert.equal(sentPhotos.length, 0);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
