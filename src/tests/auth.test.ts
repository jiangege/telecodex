import assert from "node:assert/strict";
import test from "node:test";
import { authMiddleware } from "../bot/auth.js";
import { createTestSessionStore } from "./helpers.js";

function createPrivateTextContext(userId: number, text: string) {
  const replies: string[] = [];
  return {
    ctx: {
      from: { id: userId },
      chat: { id: userId, type: "private" },
      message: { text },
      reply: async (message: string) => {
        replies.push(message);
        return undefined;
      },
    },
    replies,
  };
}

test("auth middleware claims the initial bootstrap binding code", async () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    admin.issueBindingCode({
      code: "bind-123",
      mode: "bootstrap",
    });

    let boundUserId: number | null = null;
    const middleware = authMiddleware({
      admin,
      onAdminBound: (userId) => {
        boundUserId = userId;
      },
    });
    const { ctx, replies } = createPrivateTextContext(101, "bind-123");

    await middleware(ctx as never, async () => undefined);

    assert.equal(admin.getAuthorizedUserId(), 101);
    assert.equal(boundUserId, 101);
    assert.match(replies.at(-1) ?? "", /Admin binding succeeded/);
  } finally {
    cleanup();
  }
});

test("auth middleware invalidates the binding code after too many failed attempts", async () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    admin.issueBindingCode({
      code: "bind-123",
      mode: "bootstrap",
    });

    const middleware = authMiddleware({ admin });
    let finalReply = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { ctx, replies } = createPrivateTextContext(101, `wrong-${attempt}`);
      await middleware(ctx as never, async () => undefined);
      finalReply = replies.at(-1) ?? "";
    }

    assert.equal(admin.getBindingCodeState(), null);
    assert.match(finalReply, /attempt limit/i);
  } finally {
    cleanup();
  }
});

test("auth middleware transfers control with an active rebind code", async () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    admin.claimAuthorizedUserId(101);
    admin.issueBindingCode({
      code: "rebind-123",
      mode: "rebind",
      issuedByUserId: 101,
    });

    const middleware = authMiddleware({ admin });
    const { ctx, replies } = createPrivateTextContext(202, "rebind-123");

    await middleware(ctx as never, async () => undefined);

    assert.equal(admin.getAuthorizedUserId(), 202);
    assert.match(replies.at(-1) ?? "", /handoff succeeded/i);
  } finally {
    cleanup();
  }
});
