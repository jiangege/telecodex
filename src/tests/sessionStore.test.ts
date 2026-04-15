import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStateStorage } from "../store/fileState.js";
import { SessionStore } from "../store/sessions.js";
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

test("reloading the file-backed session store keeps durable topic state but clears runtime and queue state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-session-reload-"));
  const stateDir = path.join(dir, "state");
  try {
    const firstStore = new SessionStore(new FileStateStorage(stateDir));
    const session = firstStore.getOrCreate({
      sessionKey: "-100:80",
      chatId: "-100",
      messageThreadId: "80",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    firstStore.bindThread(session.sessionKey, "thread-80");
    firstStore.setRuntimeState(session.sessionKey, {
      status: "running",
      detail: "busy",
      updatedAt: new Date().toISOString(),
      activeTurnId: "turn-80",
    });
    firstStore.setOutputMessage(session.sessionKey, 999);
    firstStore.enqueueInput(session.sessionKey, "queued before restart");
    await firstStore.flush();

    const secondStore = new SessionStore(new FileStateStorage(stateDir));
    const reloaded = secondStore.get(session.sessionKey);
    assert.equal(reloaded?.codexThreadId, "thread-80");
    assert.equal(reloaded?.runtimeStatus, "idle");
    assert.equal(reloaded?.activeTurnId, null);
    assert.equal(reloaded?.outputMessageId, null);
    assert.equal(secondStore.getQueuedInputCount(session.sessionKey), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file-backed session state keeps multi-topic bindings isolated across reloads and removals", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-session-multi-topic-"));
  const stateDir = path.join(dir, "state");
  try {
    const firstStore = new SessionStore(new FileStateStorage(stateDir));
    const firstTopic = firstStore.getOrCreate({
      sessionKey: "-100:81",
      chatId: "-100",
      messageThreadId: "81",
      telegramTopicName: "Topic A",
      defaultCwd: "/repo/a",
      defaultModel: "gpt-5.4",
    });
    const secondTopic = firstStore.getOrCreate({
      sessionKey: "-100:82",
      chatId: "-100",
      messageThreadId: "82",
      telegramTopicName: "Topic B",
      defaultCwd: "/repo/b",
      defaultModel: "gpt-5.2",
    });
    firstStore.bindThread(firstTopic.sessionKey, "thread-a");
    firstStore.setTelegramTopicName(secondTopic.sessionKey, "Topic B Renamed");
    firstStore.setAdditionalDirectories(secondTopic.sessionKey, ["/repo/shared"]);
    await firstStore.flush();

    const secondStore = new SessionStore(new FileStateStorage(stateDir));
    assert.deepEqual(
      secondStore.listTopicSessions().map((session) => session.sessionKey),
      ["-100:81", "-100:82"],
    );
    assert.equal(secondStore.get("-100:81")?.codexThreadId, "thread-a");
    assert.equal(secondStore.get("-100:81")?.telegramTopicName, "Topic A");
    assert.equal(secondStore.get("-100:81")?.cwd, "/repo/a");
    assert.equal(secondStore.get("-100:82")?.codexThreadId, null);
    assert.equal(secondStore.get("-100:82")?.telegramTopicName, "Topic B Renamed");
    assert.equal(secondStore.get("-100:82")?.cwd, "/repo/b");
    assert.deepEqual(secondStore.get("-100:82")?.additionalDirectories, ["/repo/shared"]);

    secondStore.remove("-100:81");
    await secondStore.flush();

    const thirdStore = new SessionStore(new FileStateStorage(stateDir));
    assert.equal(thirdStore.get("-100:81"), null);
    assert.equal(thirdStore.get("-100:82")?.telegramTopicName, "Topic B Renamed");
    assert.deepEqual(
      thirdStore.listTopicSessions().map((session) => session.sessionKey),
      ["-100:82"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
