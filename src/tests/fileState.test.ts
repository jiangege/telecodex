import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileStateStorage } from "../store/fileState.js";

test("FileStateStorage quarantines a corrupt sessions file and still loads healthy state files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-file-state-"));
  try {
    writeFileSync(
      path.join(dir, "app.json"),
      `${JSON.stringify({ version: 1, values: { authorized_user_id: "101" } }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "projects.json"),
      `${JSON.stringify(
        {
          version: 1,
          projects: [
            {
              chatId: "-100",
              name: "telecodex",
              cwd: "/repo/app",
              createdAt: "2026-04-15T00:00:00.000Z",
              updatedAt: "2026-04-15T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(path.join(dir, "sessions.json"), '{"version":1,"sessions":{}}\n', "utf8");

    const storage = new FileStateStorage(dir);

    assert.equal(storage.getAppState("authorized_user_id"), "101");
    assert.equal(storage.getProject("-100")?.workingRoot, "/repo/app");
    assert.deepEqual(storage.listSessions(), []);

    const files = readdirSync(dir).sort();
    assert.ok(files.some((file) => file.startsWith("sessions.json.corrupt-")));
    assert.equal(files.includes("sessions.json"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
