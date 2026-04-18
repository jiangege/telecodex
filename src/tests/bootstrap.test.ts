import assert from "node:assert/strict";
import test from "node:test";
import { resolveBootstrapBindingState } from "../runtime/bootstrap.js";
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
