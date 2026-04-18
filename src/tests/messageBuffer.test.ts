import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { InputFile } from "grammy";
import { tmpdir } from "node:os";
import path from "node:path";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { createFakeBot, createNoopLogger } from "./helpers.js";

test("MessageBuffer completes long markdown replies without losing formatted chunks", async () => {
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

  const payloads = [
    ...edited.filter((entry) => entry.messageId != null).map((entry) => ({ text: entry.text, options: entry.options })),
    ...sent.map((message) => ({ text: message.text, options: message.options ?? undefined })),
  ].filter((entry) => entry.text !== "Starting...");

  assert.ok(payloads.length > 1);
  const allEntities = payloads.flatMap((payload) => ((payload.options?.entities as Array<{ type: string }> | undefined) ?? []));
  for (const payload of payloads) {
    assert.ok(payload.text.length <= 3900);
  }
  assert.ok(allEntities.some((entity) => entity.type === "bold"));
  assert.ok(allEntities.some((entity) => entity.type === "pre"));
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
  assert.ok(hasEntity(sent[0]?.options?.entities as Entity[] | undefined, sent[0]?.text ?? "", "bold", "Starting..."));

  buffers.markTurnStarted("thread-phase:turn-1");
  await delay(4);

  const working = edited.find((entry) => entry.text.includes("Working..."));
  assert.ok(working);
  assert.ok(hasEntity(working?.options?.entities as Entity[] | undefined, working?.text ?? "", "bold", "Working..."));
  await buffers.complete("thread-phase:turn-1", "done");
});

test("MessageBuffer renders structured working sections as Telegram entities", async () => {
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

  const latest = edited.at(-1);
  const text = latest?.text ?? "";
  const entities = (latest?.options?.entities as Entity[] | undefined) ?? [];
  assert.match(text, /Working\.\.\./);
  assert.match(text, /Plan/);
  assert.match(text, /Reasoning/);
  assert.match(text, /Activity/);
  assert.match(text, /Reply Draft/);
  assert.match(text, /Draft/);
  assert.match(text, /Terminal/);
  assert.ok(entities.some((entity) => entity.type === "blockquote"));
  assert.ok(entities.some((entity) => entity.type === "pre"));
  assert.ok(entities.some((entity) => entity.type === "bold"));

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
    assert.ok(((sentPhotos[0]?.options?.caption_entities as Array<{ type: string }> | undefined) ?? []).length === 0);
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

test("MessageBuffer.complete degrades blocked images into fallback text instead of dropping them", async () => {
  const { bot, edited, sent, sentPhotos } = createFakeBot();
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
    assert.ok(sent.some((message) => message.text.includes("Escaped")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

type Entity = { type: string; offset: number; length: number };

function hasEntity(entities: Entity[] | undefined, text: string, type: string, value: string): boolean {
  const offset = text.indexOf(value);
  return entities?.some((entity) => entity.type === type && entity.offset === offset && entity.length === value.length) ?? false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
