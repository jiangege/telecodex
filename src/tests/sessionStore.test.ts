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

test("pending interactions are stored and removed with the session", () => {
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

    store.putPendingInteraction({
      interactionId: "interaction-79",
      sessionKey: session.sessionKey,
      kind: "approval",
      requestJson: "{\"id\":\"req-79\"}",
    });

    assert.equal(store.getPendingInteraction("interaction-79")?.sessionKey, session.sessionKey);
    store.remove(session.sessionKey);
    assert.equal(store.getPendingInteraction("interaction-79"), null);
  } finally {
    cleanup();
  }
});
