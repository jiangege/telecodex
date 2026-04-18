import assert from "node:assert/strict";
import test from "node:test";
import { buildBootstrapBindingDisplay, resolveBootstrapBindingState } from "../runtime/bootstrap.js";
import { createTestSessionStore } from "./helpers.js";

test("resolveBootstrapBindingState issues a bootstrap code when no admin is bound", () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    const binding = resolveBootstrapBindingState(admin, () => "bind-new");
    assert.deepEqual(binding, {
      code: "bind-new",
      expiresAt: admin.getBindingCodeState()?.expiresAt ?? "",
      maxAttempts: 5,
    });
    assert.equal(admin.getBindingCodeState()?.code, "bind-new");
    assert.equal(admin.getBindingCodeState()?.mode, "bootstrap");
  } finally {
    cleanup();
  }
});

test("resolveBootstrapBindingState reuses an active bootstrap code", () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    admin.issueBindingCode({
      code: "bind-existing",
      mode: "bootstrap",
    });
    const binding = resolveBootstrapBindingState(admin, () => "bind-new");
    assert.equal(binding?.code, "bind-existing");
    assert.equal(admin.getBindingCodeState()?.code, "bind-existing");
  } finally {
    cleanup();
  }
});

test("resolveBootstrapBindingState clears stale bootstrap codes once an admin is bound", () => {
  const { admin, cleanup } = createTestSessionStore();
  try {
    admin.issueBindingCode({
      code: "bind-stale",
      mode: "bootstrap",
    });
    admin.claimAuthorizedUserId(101);
    admin.issueBindingCode({
      code: "bind-stale-2",
      mode: "bootstrap",
    });

    const binding = resolveBootstrapBindingState(admin, () => "bind-new");
    assert.equal(binding, null);
    assert.equal(admin.getBindingCodeState(), null);
  } finally {
    cleanup();
  }
});

test("buildBootstrapBindingDisplay includes a deep link and QR code when the bot username is known", async () => {
  const display = await buildBootstrapBindingDisplay({
    binding: {
      code: "bind-123",
      expiresAt: "2026-04-18T10:00:00.000Z",
      maxAttempts: 5,
    },
    botUsername: "telecodex_bot",
    workspace: "/tmp/project",
    renderQrCode: async () => "QR-CODE",
  });

  assert.equal(display.deepLink, "https://t.me/telecodex_bot?start=bind-123");
  assert.equal(display.qrCode, "QR-CODE");
  assert.equal(display.clipboardText, "https://t.me/telecodex_bot?start=bind-123");
  assert.match(display.noteText, /QR-CODE/);
  assert.match(display.noteText, /\/project bind \/tmp\/project/);
  assert.match(display.noteText, /Fallback: send this one-time code/);
});

test("buildBootstrapBindingDisplay falls back to the raw binding code when the bot username is unknown", async () => {
  const display = await buildBootstrapBindingDisplay({
    binding: {
      code: "bind-123",
      expiresAt: "2026-04-18T10:00:00.000Z",
      maxAttempts: 5,
    },
    botUsername: null,
    workspace: "/tmp/project",
  });

  assert.equal(display.deepLink, null);
  assert.equal(display.qrCode, null);
  assert.equal(display.clipboardText, "bind-123");
  assert.match(display.noteText, /send this one-time binding code/i);
  assert.doesNotMatch(display.noteText, /https:\/\/t\.me\//);
});
