import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertProjectScopedFile, assertProjectScopedPath } from "../pathScope.js";

test("assertProjectScopedPath rejects a symlink that escapes the working root", () => {
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
      /Path must stay within the working root/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("assertProjectScopedFile rejects files outside the working root", () => {
  const base = mkdtempSync(path.join(tmpdir(), "telecodex-file-"));
  try {
    const projectRoot = path.join(base, "project");
    const externalRoot = path.join(base, "external");
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(externalRoot, { recursive: true });

    const escaped = path.join(externalRoot, "secret.png");
    writeFileSync(escaped, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    assert.throws(
      () => assertProjectScopedFile(escaped, projectRoot),
      /File must stay within the working root/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
