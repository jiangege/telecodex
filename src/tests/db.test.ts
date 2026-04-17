import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FileStateStorage } from "../store/fileState.js";
import { migrateLegacySqliteState } from "../store/legacyMigration.js";
import { ProjectStore } from "../store/projects.js";
import { SessionStore } from "../store/sessions.js";

test("legacy SQLite state migrates into file-backed state without importing runtime or queue state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-db-test-"));
  const legacyDbPath = path.join(dir, "state.sqlite");
  const stateDir = path.join(dir, "state");

  try {
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_thread_id TEXT,
        codex_thread_id TEXT,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        sandbox_mode TEXT NOT NULL DEFAULT 'workspace-write',
        approval_policy TEXT NOT NULL DEFAULT 'never',
        telegram_topic_name TEXT,
        reasoning_effort TEXT,
        web_search_mode TEXT,
        network_access_enabled INTEGER NOT NULL DEFAULT 0,
        skip_git_repo_check INTEGER NOT NULL DEFAULT 0,
        additional_directories TEXT,
        output_schema TEXT,
        runtime_status TEXT NOT NULL DEFAULT 'running',
        runtime_status_detail TEXT,
        runtime_status_updated_at TEXT,
        active_turn_id TEXT,
        output_message_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE queued_inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_key TEXT NOT NULL,
        text TEXT NOT NULL,
        input_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "authorized_user_id",
      "101",
      "2026-04-15T00:00:00.000Z",
    );
    legacy.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "codex_bin",
      "/usr/local/bin/codex",
      "2026-04-15T00:00:00.000Z",
    );
    legacy.prepare("INSERT INTO projects (chat_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "-100",
      "telecodex",
      "/repo/app",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T01:00:00.000Z",
    );
    legacy.prepare(`
      INSERT INTO sessions (
        session_key, chat_id, message_thread_id, codex_thread_id, cwd, model,
        sandbox_mode, approval_policy, telegram_topic_name, reasoning_effort, web_search_mode,
        network_access_enabled, skip_git_repo_check, additional_directories, output_schema,
        runtime_status, runtime_status_detail, runtime_status_updated_at, active_turn_id, output_message_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "-100:7",
      "-100",
      "7",
      "thread-777",
      "/repo/app",
      "gpt-5.4",
      "workspace-write",
      "never",
      "Topic 7",
      "high",
      "live",
      0,
      0,
      JSON.stringify(["/repo/shared"]),
      JSON.stringify({ type: "object", properties: { ok: { type: "boolean" } } }),
      "running",
      "old runtime",
      "2026-04-15T02:00:00.000Z",
      "turn-legacy",
      42,
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T03:00:00.000Z",
    );
    legacy.prepare(`
      INSERT INTO queued_inputs (session_key, text, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "-100:7",
      "queued legacy work",
      JSON.stringify("queued legacy work"),
      "2026-04-15T02:30:00.000Z",
      "2026-04-15T02:30:00.000Z",
    );
    legacy.close();
    writeFileSync(`${legacyDbPath}-wal`, "legacy wal", "utf8");
    writeFileSync(`${legacyDbPath}-shm`, "legacy shm", "utf8");

    const storage = new FileStateStorage(stateDir);
    const result = migrateLegacySqliteState({
      storage,
      legacyDbPath,
    });
    assert.equal(result.imported, true);

    const store = new SessionStore(storage);
    const projects = new ProjectStore(storage);

    assert.equal(store.getAuthorizedUserId(), 101);
    assert.equal(store.getAppState("codex_bin"), "/usr/local/bin/codex");
    assert.equal(projects.get("-100")?.cwd, "/repo/app");

    const session = store.get("-100:7");
    assert.ok(session);
    assert.equal(session?.codexThreadId, "thread-777");
    assert.equal(session?.sandboxMode, "workspace-write");
    assert.equal(session?.approvalPolicy, "never");
    assert.equal(session?.reasoningEffort, "high");
    assert.equal(session?.webSearchMode, "live");
    assert.equal(session?.networkAccessEnabled, false);
    assert.equal(session?.skipGitRepoCheck, false);
    assert.deepEqual(session?.additionalDirectories, ["/repo/shared"]);
    assert.equal(session?.runtimeStatus, "idle");
    assert.equal(session?.outputMessageId, null);
    assert.equal(existsSync(legacyDbPath), false);
    assert.equal(existsSync(`${legacyDbPath}-wal`), false);
    assert.equal(existsSync(`${legacyDbPath}-shm`), false);

    writeFileSync(legacyDbPath, "stale legacy db", "utf8");
    writeFileSync(`${legacyDbPath}-wal`, "stale wal", "utf8");
    writeFileSync(`${legacyDbPath}-journal`, "stale journal", "utf8");

    const secondRun = migrateLegacySqliteState({
      storage,
      legacyDbPath,
    });
    assert.equal(secondRun.imported, false);
    assert.equal(existsSync(legacyDbPath), false);
    assert.equal(existsSync(`${legacyDbPath}-wal`), false);
    assert.equal(existsSync(`${legacyDbPath}-journal`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy SQLite import is additive and does not overwrite existing file-backed state", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "telecodex-db-test-"));
  const legacyDbPath = path.join(dir, "state.sqlite");
  const stateDir = path.join(dir, "state");

  try {
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec(`
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE projects (
        chat_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE sessions (
        session_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        message_thread_id TEXT,
        codex_thread_id TEXT,
        cwd TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    legacy.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "authorized_user_id",
      "101",
      "2026-04-15T00:00:00.000Z",
    );
    legacy.prepare("INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)").run(
      "codex_config_overrides",
      '{"model_verbosity":"high"}',
      "2026-04-15T00:00:00.000Z",
    );
    legacy.prepare("INSERT INTO projects (chat_id, name, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "-100",
      "legacy-project",
      "/legacy/project",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    );
    legacy.prepare(`
      INSERT INTO sessions (session_key, chat_id, message_thread_id, codex_thread_id, cwd, model, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "-100:9",
      "-100",
      "9",
      "thread-legacy",
      "/legacy/project",
      "gpt-5.4",
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z",
    );
    legacy.close();

    const storage = new FileStateStorage(stateDir);
    storage.setAppState("authorized_user_id", "202");
    storage.upsertProject({
      chatId: "-100",
      cwd: "/current/project",
      name: "current-project",
    });
    storage.putSession({
      sessionKey: "-100:9",
      chatId: "-100",
      messageThreadId: "9",
      telegramTopicName: "Current Topic",
      codexThreadId: "thread-current",
      cwd: "/current/project",
      model: "gpt-5.4",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      reasoningEffort: null,
      webSearchMode: null,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      additionalDirectories: [],
      outputSchema: null,
      createdAt: "2026-04-15T01:00:00.000Z",
      updatedAt: "2026-04-15T01:00:00.000Z",
    });

    const result = migrateLegacySqliteState({
      storage,
      legacyDbPath,
    });
    assert.equal(result.imported, true);

    const store = new SessionStore(storage);
    const projects = new ProjectStore(storage);
    assert.equal(store.getAuthorizedUserId(), 202);
    assert.equal(store.getAppState("codex_config_overrides"), '{"model_verbosity":"high"}');
    assert.equal(projects.get("-100")?.cwd, "/current/project");
    assert.equal(store.get("-100:9")?.codexThreadId, "thread-current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
