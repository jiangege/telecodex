import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  HANDLED_CODEX_NOTIFICATION_METHODS,
  IGNORED_CODEX_NOTIFICATION_METHODS,
} from "../bot/codexNotificationPolicy.js";

test("all generated codex notifications are explicitly classified", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src/generated/codex-app-server/ServerNotification.ts"),
    "utf8",
  );
  const generated = [...source.matchAll(/"method": "([^"]+)"/g)].map((match) => match[1]).filter(Boolean).sort();
  const classified = [...HANDLED_CODEX_NOTIFICATION_METHODS, ...IGNORED_CODEX_NOTIFICATION_METHODS].sort();

  assert.deepEqual(classified, generated);
  assert.equal(new Set(classified).size, classified.length);
});
