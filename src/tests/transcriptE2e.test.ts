import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { encodeStopCallbackData } from "../bot/run/stopButton.js";
import { createScenarioHarness } from "./harness/scenarioHarness.js";

test("transcript e2e runs a topic message through preparing, working, and final formatting", async () => {
  const harness = createScenarioHarness();
  const control = harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-transcript-1" },
      { type: "pause" },
      { type: "turn.started" },
      { type: "item.updated", item: { id: "reason-1", type: "reasoning", text: "Inspecting repository structure" } },
      { type: "item.completed", item: { id: "msg-1", type: "agent_message", text: "## Final\n\n`thread-transcript-1`" } },
      { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 5 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("inspect the project", 301);
    await harness.waitFor(() => harness.codex.calls.length === 1);

    assert.equal(harness.store.get("-1003940193016:301")?.runtimeStatus, "preparing");
    const startingCall = harness.sendMessageCalls.find(
      (call) => call.payload.text === "Starting..." && call.payload.message_thread_id === 301,
    );
    assert.ok(startingCall);
    assert.deepEqual(startingCall?.payload.reply_markup, {
      inline_keyboard: [[{
        text: "Stop",
        callback_data: encodeStopCallbackData({ chatId: -1003940193016, messageThreadId: 301 }),
      }]],
    });

    control.release();
    await harness.waitFor(() => harness.store.get("-1003940193016:301")?.runtimeStatus === "idle");

    const session = harness.store.get("-1003940193016:301");
    assert.equal(session?.codexThreadId, "thread-transcript-1");
    assert.ok(harness.sendChatActionCalls.some((call) => call.payload.message_thread_id === 301));

    await harness.waitFor(() =>
      [...harness.editMessageTextCalls, ...harness.sendMessageCalls].some((call) =>
        String(call.payload.text).includes("<code>thread-transcript-1</code>")
      ),
    );
    await harness.waitFor(() =>
      harness.editMessageTextCalls.some((call) =>
        String(call.payload.text).includes("<code>thread-transcript-1</code>") &&
        JSON.stringify(call.payload.reply_markup) === JSON.stringify({ inline_keyboard: [] })
      ),
    );
    const finalPayload = [
      ...harness.editMessageTextCalls.map((call) => call.payload),
      ...harness.sendMessageCalls.map((call) => call.payload),
    ].reverse().find((payload) => String(payload.text).includes("<code>thread-transcript-1</code>"));
    assert.ok(finalPayload);
    assert.equal(finalPayload?.parse_mode, "HTML");
    assert.deepEqual(finalPayload?.reply_markup, { inline_keyboard: [] });
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e keeps placeholder working drafts out of Telegram progress messages", async () => {
  const harness = createScenarioHarness();
  const control = harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-working-1" },
      { type: "turn.started" },
      { type: "item.updated", item: { id: "msg-working", type: "agent_message", text: "working" } },
      { type: "item.updated", item: { id: "reason-working", type: "reasoning", text: "Checking the current implementation." } },
      { type: "pause" },
      { type: "item.completed", item: { id: "msg-working", type: "agent_message", text: "final working result" } },
      { type: "turn.completed", usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 2 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("inspect the working placeholder", 308);
    await harness.waitFor(() =>
      harness.editMessageTextCalls.some((call) =>
        String(call.payload.text).includes("<b>Reasoning</b>")
      ),
    );

    const workingPayload = harness.editMessageTextCalls
      .map((call) => String(call.payload.text))
      .find((text) => text.includes("<b>Reasoning</b>"));
    assert.ok(workingPayload);
    assert.doesNotMatch(workingPayload ?? "", /<b>Reply Draft<\/b>/);

    control.release();
    await harness.waitFor(() => harness.store.get("-1003940193016:308")?.runtimeStatus === "idle");
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e ignores a follow-up message while the active run is still busy", async () => {
  const harness = createScenarioHarness();
  const first = harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-queue-1" },
      { type: "pause" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "msg-q1", type: "agent_message", text: "first result" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("first task", 302);
    await harness.waitFor(() => harness.codex.isRunning("-1003940193016:302"));

    await harness.sendGroupText("second task", 302);
    const busyNotice = harness.sendMessageCalls.find((call) => String(call.payload.text).includes("Codex is still working in this topic."));
    assert.ok(busyNotice);
    assert.equal(busyNotice?.payload.parse_mode, undefined);
    assert.deepEqual(busyNotice?.payload.link_preview_options, { is_disabled: true });
    assert.match(String(busyNotice?.payload.text), /Use the Stop button to interrupt it/);

    first.release();
    await harness.waitFor(() => harness.store.get("-1003940193016:302")?.runtimeStatus === "idle");

    assert.deepEqual(harness.codex.calls.map((call) => call.prompt), ["first task"]);
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e interrupts an active run with the Stop button", async () => {
  const harness = createScenarioHarness();
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-stop-inline-1" },
      { type: "turn.started" },
      { type: "pause" },
      { type: "item.completed", item: { id: "msg-stop-inline", type: "agent_message", text: "should not complete" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("long task", 309);
    await harness.waitFor(() => harness.codex.getActiveRun("-1003940193016:309")?.lastEventType === "turn.started");

    const startingCall = harness.sendMessageCalls.find(
      (call) => call.payload.text === "Starting..." && call.payload.message_thread_id === 309,
    );
    assert.ok(startingCall);
    await harness.sendGroupCallbackQuery({
      data: encodeStopCallbackData({ chatId: -1003940193016, messageThreadId: 309 }),
      messageThreadId: 309,
    });
    await harness.waitFor(() => harness.store.get("-1003940193016:309")?.runtimeStatus === "idle");

    assert.ok(harness.answerCallbackQueryCalls.some((call) => call.payload.text === "Interrupt requested."));
    assert.ok(
      harness.editMessageTextCalls.some((call) => String(call.payload.text).includes("Current run interrupted.")) ||
      harness.sendMessageCalls.some((call) => String(call.payload.text).includes("Current run interrupted.")),
    );
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e interrupts an active run with /stop", async () => {
  const harness = createScenarioHarness();
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-stop-1" },
      { type: "turn.started" },
      { type: "pause" },
      { type: "item.completed", item: { id: "msg-stop", type: "agent_message", text: "should not complete" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("long task", 303);
    await harness.waitFor(() => harness.codex.getActiveRun("-1003940193016:303")?.lastEventType === "turn.started");

    await harness.sendGroupCommand("stop", "", 303);
    await harness.waitFor(() => harness.store.get("-1003940193016:303")?.runtimeStatus === "idle");

    assert.ok(!harness.sendMessageCalls.some((call) => String(call.payload.text).includes("Interrupt requested for the current run.")));
    assert.ok(
      harness.editMessageTextCalls.some((call) => String(call.payload.text).includes("Current run interrupted.")) ||
      harness.sendMessageCalls.some((call) => String(call.payload.text).includes("Current run interrupted.")),
    );
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e supports /thread resume and /thread new without creating Telegram topics", async () => {
  const harness = createScenarioHarness();
  harness.threadCatalog.setThreads([
    {
      id: "thread-existing-777",
      cwd: process.cwd(),
      createdAt: "2026-04-15T00:00:00.000Z",
      updatedAt: "2026-04-15T01:00:00.000Z",
      preview: "Existing thread 777",
      source: "cli",
      modelProvider: "openai",
      sessionPath: "/tmp/thread-existing-777.jsonl",
    },
  ]);
  const control = harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-new-888" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "msg-new", type: "agent_message", text: "new thread result" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupCommand("thread", "resume thread-existing-777", 304);

    assert.equal(harness.store.get("-1003940193016:304")?.codexThreadId, "thread-existing-777");
    assert.ok(harness.sendMessageCalls.some((call) => String(call.payload.text).includes("Current topic is now bound to the existing thread id.")));

    await harness.sendGroupCommand("thread", "new", 304);
    assert.equal(harness.store.get("-1003940193016:304")?.codexThreadId, null);

    await harness.sendGroupText("start fresh", 304);
    await harness.waitFor(() => harness.codex.calls.length === 1);
    control.release();
    await harness.waitFor(() => harness.store.get("-1003940193016:304")?.runtimeStatus === "idle");

    assert.equal(harness.codex.calls[0]?.profile.threadId, null);
    assert.equal(harness.recorder.getCalls("createForumTopic").length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e splits long markdown final replies into valid Telegram HTML chunks", async () => {
  const harness = createScenarioHarness();
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
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-long-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "msg-long", type: "agent_message", text: markdown } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("return a long answer", 305);
    await harness.waitFor(() => harness.store.get("-1003940193016:305")?.runtimeStatus === "idle");

    const finalChunks = [
      ...harness.editMessageTextCalls.filter((call) => call.payload.message_id != null && String(call.payload.text) !== "Starting..."),
      ...harness.sendMessageCalls.filter((call) => call.payload.message_thread_id === 305 && String(call.payload.text) !== "Starting..."),
    ].map((call) => String(call.payload.text));

    assert.ok(finalChunks.length > 1);
    for (const chunk of finalChunks) {
      assert.ok(chunk.length <= 3900);
      assert.equal(count(chunk, "<b>"), count(chunk, "</b>"));
      assert.equal(count(chunk, "<code>"), count(chunk, "</code>"));
      assert.equal(count(chunk, "<pre>"), count(chunk, "</pre>"));
    }
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e sends Telegram images to Codex as local_image input", async () => {
  const harness = createScenarioHarness();
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-image-1" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "msg-image", type: "agent_message", text: "image result" } },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupPhoto(306, {
      caption: "inspect this image",
      photo: [{ file_id: "photo-e2e", width: 1280, height: 720 }],
    });
    await harness.waitFor(() => harness.codex.calls.length === 1);

    const prompt = harness.codex.calls[0]?.prompt;
    assert.ok(Array.isArray(prompt));
    assert.deepEqual(prompt?.[0], {
      type: "text",
      text: "inspect this image",
    });
    assert.equal(prompt?.[1]?.type, "local_image");
    assert.match(prompt?.[1]?.path ?? "", /telecodex-attachment-1\.jpg$/);
    assert.equal(harness.recorder.getCalls("getFile").length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("transcript e2e sends assistant markdown images back to Telegram media", async () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "telecodex-generated-image-"));
  const generatedImage = path.join(projectRoot, "generated-color-study.png");
  writeFileSync(generatedImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const harness = createScenarioHarness({
    cwd: projectRoot,
  });
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-generated-image-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: {
          id: "msg-generated-image",
          type: "agent_message",
          text: `Generated concept.\n\n![Color study](${generatedImage})`,
        },
      },
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${projectRoot}`);
    await harness.sendGroupText("generate an image", 309);
    await harness.waitFor(() => harness.store.get("-1003940193016:309")?.runtimeStatus === "idle");

    assert.equal(harness.sendPhotoCalls.length, 1);
    assert.equal(harness.sendPhotoCalls[0]?.payload.message_thread_id, 309);
    assert.equal(harness.sendPhotoCalls[0]?.payload.caption, "Color study");
    assert.deepEqual(harness.sendPhotoCalls[0]?.payload.photo, {
      __type: "InputFile",
      filename: "generated-color-study.png",
    });

    const deliveredText = [
      ...harness.editMessageTextCalls.map((call) => String(call.payload.text)),
      ...harness.sendMessageCalls.map((call) => String(call.payload.text)),
    ].join("\n");
    assert.match(deliveredText, /Generated concept\./);
    assert.doesNotMatch(deliveredText, /generated-color-study\.png/);
  } finally {
    await harness.cleanup();
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("transcript e2e sanitizes upstream Codex HTML errors before sending them to Telegram", async () => {
  const harness = createScenarioHarness();
  harness.codex.enqueueRun({
    steps: [
      { type: "thread.started", thread_id: "thread-error-1" },
      { type: "turn.started" },
      {
        type: "error",
        message:
          "Reconnecting... 2/5 (unexpected status 403 Forbidden: 154c\r\n<!DOCTYPE html>\n<html><body>cf challenge</body></html>, url: wss://chatgpt.com/backend-api/codex/responses, cf-ray: 123-HKG)",
      },
    ],
  });

  try {
    await harness.sendGroupCommand("project", `bind ${process.cwd()}`);
    await harness.sendGroupText("trigger upstream error", 307);
    await harness.waitFor(() => harness.store.get("-1003940193016:307")?.runtimeStatus === "failed");

    const delivered = [
      ...harness.editMessageTextCalls.map((call) => String(call.payload.text)),
      ...harness.sendMessageCalls.map((call) => String(call.payload.text)),
    ].join("\n");

    assert.match(delivered, /Codex backend rejected the connection \(403\)/);
    assert.doesNotMatch(delivered, /<!DOCTYPE html>/i);
    assert.doesNotMatch(delivered, /cf challenge/i);
    assert.equal(
      harness.store.get("-1003940193016:307")?.runtimeStatusDetail,
      "Codex backend rejected the connection (403). Refresh the Codex login or try again later.",
    );
  } finally {
    await harness.cleanup();
  }
});

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
