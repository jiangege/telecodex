import assert from "node:assert/strict";
import test from "node:test";
import { reduceSessionRuntimeState } from "../runtime/sessionRuntime.js";
import { createTestSessionStore } from "./helpers.js";

test("reduceSessionRuntimeState moves running sessions through waiting and terminal states", () => {
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
      turnId: "turn-31",
    });
    assert.equal(running.status, "running");
    assert.equal(running.activeTurnId, "turn-31");

    const waiting = reduceSessionRuntimeState(
      {
        ...session,
        runtimeStatus: running.status,
        runtimeStatusDetail: running.detail,
        runtimeStatusUpdatedAt: running.updatedAt,
        activeTurnId: running.activeTurnId,
      },
      {
        type: "turn.waitingApproval",
      },
    );
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(waiting.activeTurnId, "turn-31");

    const done = reduceSessionRuntimeState(
      {
        ...session,
        runtimeStatus: waiting.status,
        runtimeStatusDetail: waiting.detail,
        runtimeStatusUpdatedAt: waiting.updatedAt,
        activeTurnId: waiting.activeTurnId,
      },
      {
        type: "turn.completed",
        turnId: "turn-31",
      },
    );
    assert.equal(done.status, "idle");
    assert.equal(done.activeTurnId, null);
  } finally {
    cleanup();
  }
});
