import assert from "node:assert/strict";
import test from "node:test";
import { formatInputTargetForStatus, getSessionInputState } from "../bot/inputTarget.js";
import { createTestSessionStore } from "./helpers.js";

test("input target becomes user_input when a blocking form interaction exists", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:101",
      chatId: "-100",
      messageThreadId: "101",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.putPendingInteraction({
      interactionId: "interaction-101",
      sessionKey: session.sessionKey,
      kind: "tool_user_input",
      requestJson: JSON.stringify({
        params: {
          questions: [
            {
              header: "Project",
              question: "Which project?",
            },
          ],
        },
      }),
    });

    const state = getSessionInputState(store, session);
    assert.equal(formatInputTargetForStatus(state), "user_input");
    assert.match(state.summary, /作为回答提交/);
    assert.equal(state.pendingBlockers, 0);
  } finally {
    cleanup();
  }
});

test("input target reports approval blocker ahead of queued work", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const session = store.getOrCreate({
      sessionKey: "-100:102",
      chatId: "-100",
      messageThreadId: "102",
      telegramTopicName: "demo",
      defaultCwd: process.cwd(),
      defaultModel: "gpt-5.4",
    });
    store.setRuntimeState(session.sessionKey, {
      status: "waiting_approval",
      detail: "approval",
      updatedAt: new Date().toISOString(),
      activeTurnId: "turn-102",
    });
    store.putPendingInteraction({
      interactionId: "interaction-102",
      sessionKey: session.sessionKey,
      kind: "approval",
      requestJson: JSON.stringify({
        params: {
          command: "npm publish",
        },
      }),
    });

    const state = getSessionInputState(store, store.get(session.sessionKey)!);
    assert.equal(formatInputTargetForStatus(state), "approval");
    assert.match(state.summary, /点按钮处理/);
  } finally {
    cleanup();
  }
});
