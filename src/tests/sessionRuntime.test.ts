import assert from "node:assert/strict";
import test from "node:test";
import { reduceSessionRuntimeState } from "../runtime/sessionRuntime.js";
import { createTestSessionStore } from "./helpers.js";

test("reduceSessionRuntimeState moves SDK-backed sessions through active and terminal states", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:31",
      chatId: "-100",
      messageThreadId: "31",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });

    const running = reduceSessionRuntimeState(session, {
      type: "turn.started",
    });
    assert.equal(running.status, "running");

    const done = reduceSessionRuntimeState(
      {
        ...session,
        runtimeStatus: running.status,
        runtimeStatusDetail: running.detail,
        runtimeStatusUpdatedAt: running.updatedAt,
      },
      {
        type: "turn.completed",
      },
    );
    assert.equal(done.status, "idle");
  } finally {
    cleanup();
  }
});
