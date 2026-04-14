import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock } from "../runtime/instanceLock.js";
import { createNoopLogger } from "./helpers.js";

test("acquireInstanceLock rejects a second live instance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-lock-test-"));
  const lockPath = path.join(dir, "telecodex.lock");

  try {
    const lock = acquireInstanceLock({ lockPath, logger: createNoopLogger() });
    try {
      assert.throws(
        () => acquireInstanceLock({ lockPath, logger: createNoopLogger() }),
        /telecodex is already running/,
      );
    } finally {
      lock.release();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireInstanceLock replaces a stale lock file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-lock-test-"));
  const lockPath = path.join(dir, "telecodex.lock");

  try {
    writeFileSync(lockPath, "stale");
    const lock = acquireInstanceLock({ lockPath, logger: createNoopLogger() });
    try {
      const contents = readFileSync(lockPath, "utf8");
      assert.match(contents, new RegExp(`\"pid\":${process.pid}`));
    } finally {
      lock.release();
    }
    assert.equal(existsSync(lockPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
