import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStateStorage } from "../store/fileState.js";
import { SessionStore } from "../store/sessionStore.js";

test("reloading the file-backed session store keeps durable topic state but clears runtime state", async () => {
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
    });
    firstStore.setOutputMessage(session.sessionKey, 999);
    await firstStore.flush();

    const secondStore = new SessionStore(new FileStateStorage(stateDir));
    const reloaded = secondStore.get(session.sessionKey);
    assert.equal(reloaded?.codexThreadId, "thread-80");
    assert.equal(reloaded?.runtimeStatus, "idle");
    assert.equal(reloaded?.outputMessageId, null);
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
    assert.equal(secondStore.get("-100:82")?.codexThreadId, null);
    assert.equal(secondStore.get("-100:82")?.telegramTopicName, "Topic B Renamed");
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

test("new sessions do not persist the legacy cwd field", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-session-no-cwd-"));
  const stateDir = path.join(dir, "state");
  try {
    const store = new SessionStore(new FileStateStorage(stateDir));
    const session = store.getOrCreate({
      sessionKey: "-100:83",
      chatId: "-100",
      messageThreadId: "83",
      telegramTopicName: "Topic C",
      defaultCwd: "/legacy/cwd",
      defaultModel: "gpt-5.4",
    });
    store.bindThread(session.sessionKey, "thread-83");
    await store.flush();

    const persisted = JSON.parse(readFileSync(path.join(stateDir, "sessions.json"), "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    const storedSession = persisted.sessions.find((entry) => entry.sessionKey === session.sessionKey);
    assert.ok(storedSession);
    assert.equal("cwd" in storedSession, false);
    assert.equal(storedSession.cwd, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
