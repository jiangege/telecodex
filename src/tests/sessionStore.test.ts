import assert from "node:assert/strict";
import test from "node:test";
import { createTestSessionStore } from "./helpers.js";

test("listQueuedInputs returns queued items in FIFO order", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:77",
      chatId: "-100",
      messageThreadId: "77",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    store.enqueueInput(session.sessionKey, "first");
    store.enqueueInput(session.sessionKey, "second");
    store.enqueueInput(session.sessionKey, "third");

    const items = store.listQueuedInputs(session.sessionKey, 2);
    assert.deepEqual(
      items.map((item) => item.text),
      ["first", "second"],
    );
    assert.deepEqual(
      items.map((item) => item.input),
      ["first", "second"],
    );
  } finally {
    cleanup();
  }
});

test("queued inputs preserve structured SDK input payloads", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:79",
      chatId: "-100",
      messageThreadId: "79",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    const input = [
      { type: "text" as const, text: "caption" },
      { type: "local_image" as const, path: "/tmp/example.png" },
    ];
    const queued = store.enqueueInput(session.sessionKey, input);

    assert.equal(queued.text, "caption [image: /tmp/example.png]");
    assert.deepEqual(store.peekNextQueuedInput(session.sessionKey)?.input, input);
  } finally {
    cleanup();
  }
});

test("queue helpers can drop a single item or clear the rest", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:78",
      chatId: "-100",
      messageThreadId: "78",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    const first = store.enqueueInput(session.sessionKey, "first");
    store.enqueueInput(session.sessionKey, "second");
    store.enqueueInput(session.sessionKey, "third");

    assert.equal(store.removeQueuedInputForSession(session.sessionKey, first.id), true);
    assert.equal(store.listQueuedInputs(session.sessionKey, 5).map((item) => item.text).join(","), "second,third");
    assert.equal(store.clearQueuedInputs(session.sessionKey), 2);
    assert.equal(store.getQueuedInputCount(session.sessionKey), 0);
  } finally {
    cleanup();
  }
});
