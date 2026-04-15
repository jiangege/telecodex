import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertProjectScopedPath } from "../bot/commandSupport.js";

test("assertProjectScopedPath rejects a symlink that escapes the project root", () => {
  const base = mkdtempSync(path.join(tmpdir(), "telecodex-path-"));
  try {
    const projectRoot = path.join(base, "project");
    const externalRoot = path.join(base, "external");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });

    const escaped = path.join(projectRoot, "escaped");
    symlinkSync(externalRoot, escaped);

    assert.throws(
      () => assertProjectScopedPath(escaped, projectRoot),
      /Path must stay within the project root/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
