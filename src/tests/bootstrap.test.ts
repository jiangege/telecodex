import assert from "node:assert/strict";
import test from "node:test";
import { resolveBootstrapBindingState } from "../runtime/bootstrap.js";
import { createTestSessionStore } from "./helpers.js";

test("resolveBootstrapBindingState issues a bootstrap code when no admin is bound", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    const binding = resolveBootstrapBindingState(store, () => "bind-new");
    assert.deepEqual(binding, {
      code: "bind-new",
      expiresAt: store.getBindingCodeState()?.expiresAt ?? "",
      maxAttempts: 5,
    });
    assert.equal(store.getBindingCodeState()?.code, "bind-new");
    assert.equal(store.getBindingCodeState()?.mode, "bootstrap");
  } finally {
    cleanup();
  }
});

test("resolveBootstrapBindingState reuses an active bootstrap code", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    store.issueBindingCode({
      code: "bind-existing",
      mode: "bootstrap",
    });
    const binding = resolveBootstrapBindingState(store, () => "bind-new");
    assert.equal(binding?.code, "bind-existing");
    assert.equal(store.getBindingCodeState()?.code, "bind-existing");
  } finally {
    cleanup();
  }
});

test("resolveBootstrapBindingState clears stale bootstrap codes once an admin is bound", () => {
  const { store, cleanup } = createTestSessionStore();
  try {
    store.issueBindingCode({
      code: "bind-stale",
      mode: "bootstrap",
    });
    store.claimAuthorizedUserId(101);
    store.issueBindingCode({
      code: "bind-stale-2",
      mode: "bootstrap",
    });

    const binding = resolveBootstrapBindingState(store, () => "bind-new");
    assert.equal(binding, null);
    assert.equal(store.getBindingCodeState(), null);
  } finally {
    cleanup();
  }
});
