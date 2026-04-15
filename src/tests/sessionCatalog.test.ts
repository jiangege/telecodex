import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexSessionCatalog } from "../codex/sessionCatalog.js";

test("CodexSessionCatalog lists saved project threads from Codex session files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-catalog-"));
  const sessionsRoot = path.join(dir, "sessions");
  try {
    writeSessionFile({
      sessionsRoot,
      relativePath: "2026/04/15/rollout-project-root.jsonl",
      id: "thread-root",
      cwd: "/repo/app",
      preview: "Root thread preview",
      updatedAt: "2026-04-15T02:00:00.000Z",
      source: "cli",
    });
    writeSessionFile({
      sessionsRoot,
      relativePath: "2026/04/15/rollout-project-subdir.jsonl",
      id: "thread-subdir",
      cwd: "/repo/app/src",
      preview: "Subdir thread preview",
      updatedAt: "2026-04-15T03:00:00.000Z",
      source: "vscode",
    });
    writeSessionFile({
      sessionsRoot,
      relativePath: "2026/04/15/rollout-other-project.jsonl",
      id: "thread-other",
      cwd: "/repo/other",
      preview: "Other project preview",
      updatedAt: "2026-04-15T04:00:00.000Z",
      source: "cli",
    });

    const catalog = new CodexSessionCatalog({ sessionsRoot });
    const threads = await catalog.listProjectThreads({
      projectRoot: "/repo/app",
      limit: 10,
    });

    assert.deepEqual(
      threads.map((thread) => ({
        id: thread.id,
        cwd: thread.cwd,
        preview: thread.preview,
        source: thread.source,
      })),
      [
        {
          id: "thread-subdir",
          cwd: "/repo/app/src",
          preview: "Subdir thread preview",
          source: "vscode",
        },
        {
          id: "thread-root",
          cwd: "/repo/app",
          preview: "Root thread preview",
          source: "cli",
        },
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CodexSessionCatalog finds a saved thread by id within the current project", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-catalog-"));
  const sessionsRoot = path.join(dir, "sessions");
  try {
    writeSessionFile({
      sessionsRoot,
      relativePath: "2026/04/15/rollout-match.jsonl",
      id: "thread-match",
      cwd: "/repo/app",
      preview: "Match preview",
      updatedAt: "2026-04-15T02:00:00.000Z",
      source: "cli",
    });
    writeSessionFile({
      sessionsRoot,
      relativePath: "2026/04/15/rollout-other.jsonl",
      id: "thread-outside",
      cwd: "/repo/other",
      preview: "Outside preview",
      updatedAt: "2026-04-15T03:00:00.000Z",
      source: "cli",
    });

    const catalog = new CodexSessionCatalog({ sessionsRoot });
    const match = await catalog.findProjectThreadById({
      projectRoot: "/repo/app",
      threadId: "thread-match",
    });
    const outside = await catalog.findProjectThreadById({
      projectRoot: "/repo/app",
      threadId: "thread-outside",
    });

    assert.equal(match?.id, "thread-match");
    assert.equal(match?.preview, "Match preview");
    assert.equal(outside, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeSessionFile(input: {
  sessionsRoot: string;
  relativePath: string;
  id: string;
  cwd: string;
  preview: string;
  updatedAt: string;
  source: string;
}): void {
  const filePath = path.join(input.sessionsRoot, input.relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        timestamp: input.updatedAt,
        type: "session_meta",
        payload: {
          id: input.id,
          timestamp: input.updatedAt,
          cwd: input.cwd,
          source: input.source,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        timestamp: input.updatedAt,
        type: "event_msg",
        payload: {
          type: "user_message",
          message: input.preview,
        },
      }),
      "",
    ].join("\n"),
  );
  const updatedAt = new Date(input.updatedAt);
  utimesSync(filePath, updatedAt, updatedAt);
}
