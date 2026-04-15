import { existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { FileStateStorage, type StoredProjectBinding, type StoredSessionRecord } from "./fileState.js";
import {
  DEFAULT_SESSION_PROFILE,
  isSessionApprovalPolicy,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  isSessionWebSearchMode,
} from "../config.js";

const LEGACY_IMPORT_MARKER_KEY = "__telecodex_legacy_sqlite_import_completed_at";
const LEGACY_SQLITE_ARTIFACT_SUFFIXES = ["", "-shm", "-wal", "-journal"] as const;

export function migrateLegacySqliteState(input: {
  storage: FileStateStorage;
  legacyDbPath: string;
}): { imported: boolean } {
  if (input.storage.getAppState(LEGACY_IMPORT_MARKER_KEY) != null) {
    cleanupLegacySqliteArtifacts(input.legacyDbPath);
    return { imported: false };
  }
  if (!existsSync(input.legacyDbPath)) {
    return { imported: false };
  }

  let imported = false;
  const db = new DatabaseSync(input.legacyDbPath);
  try {
    const appState = hasTable(db, "app_state") ? readAppState(db) : {};
    const projects = hasTable(db, "projects") ? readProjects(db) : [];
    const sessions = hasTable(db, "sessions") ? readSessions(db) : [];

    input.storage.mergeImportedAppState(appState);
    input.storage.mergeImportedProjects(projects);
    input.storage.mergeImportedSessions(sessions);
    input.storage.setAppState(LEGACY_IMPORT_MARKER_KEY, new Date().toISOString());
    imported = true;
  } finally {
    db.close();
  }
  cleanupLegacySqliteArtifacts(input.legacyDbPath);
  return { imported };
}

function readAppState(db: DatabaseSync): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM app_state").all() as Array<{ key?: string; value?: string }>;
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.key !== "string" || typeof row.value !== "string") continue;
    values[row.key] = row.value;
  }
  return values;
}

function readProjects(db: DatabaseSync): StoredProjectBinding[] {
  const rows = db.prepare("SELECT * FROM projects").all() as Array<Record<string, unknown>>;
  const projects: StoredProjectBinding[] = [];
  for (const row of rows) {
    if (typeof row.chat_id !== "string" || typeof row.cwd !== "string") continue;
    const cwd = row.cwd.trim();
    if (!cwd) continue;
    const now = new Date().toISOString();
    projects.push({
      chatId: row.chat_id,
      name: typeof row.name === "string" && row.name.trim() ? row.name : cwd,
      cwd,
      createdAt: typeof row.created_at === "string" ? row.created_at : now,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : now,
    });
  }
  return projects;
}

function readSessions(db: DatabaseSync): StoredSessionRecord[] {
  const rows = db.prepare("SELECT * FROM sessions").all() as Array<Record<string, unknown>>;
  const sessions: StoredSessionRecord[] = [];
  for (const row of rows) {
    if (
      typeof row.session_key !== "string" ||
      typeof row.chat_id !== "string" ||
      typeof row.cwd !== "string" ||
      typeof row.model !== "string"
    ) {
      continue;
    }

    const now = new Date().toISOString();
    sessions.push({
      sessionKey: row.session_key,
      chatId: row.chat_id,
      messageThreadId: typeof row.message_thread_id === "string" ? row.message_thread_id : null,
      telegramTopicName: typeof row.telegram_topic_name === "string" ? row.telegram_topic_name : null,
      codexThreadId: typeof row.codex_thread_id === "string" ? row.codex_thread_id : null,
      cwd: row.cwd,
      model: row.model,
      sandboxMode: normalizeSandboxMode(row.sandbox_mode, row.mode),
      approvalPolicy: normalizeApprovalPolicy(row.approval_policy),
      reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
      webSearchMode: normalizeWebSearchMode(row.web_search_mode),
      networkAccessEnabled: normalizeBoolean(row.network_access_enabled, true),
      skipGitRepoCheck: normalizeBoolean(row.skip_git_repo_check, true),
      additionalDirectories: normalizeStringArray(row.additional_directories),
      outputSchema: normalizeOutputSchema(row.output_schema),
      createdAt: typeof row.created_at === "string" ? row.created_at : now,
      updatedAt: typeof row.updated_at === "string" ? row.updated_at : now,
    });
  }
  return sessions;
}

function hasTable(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName) as { name?: string } | undefined;
  return typeof row?.name === "string";
}

function normalizeSandboxMode(current: unknown, legacyMode: unknown): StoredSessionRecord["sandboxMode"] {
  if (typeof current === "string" && isSessionSandboxMode(current)) return current;
  if (legacyMode === "write") return "workspace-write";
  return DEFAULT_SESSION_PROFILE.sandboxMode;
}

function normalizeApprovalPolicy(value: unknown): StoredSessionRecord["approvalPolicy"] {
  return typeof value === "string" && isSessionApprovalPolicy(value) ? value : DEFAULT_SESSION_PROFILE.approvalPolicy;
}

function normalizeReasoningEffort(value: unknown): StoredSessionRecord["reasoningEffort"] {
  return typeof value === "string" && isSessionReasoningEffort(value) ? value : null;
}

function normalizeWebSearchMode(value: unknown): StoredSessionRecord["webSearchMode"] {
  return typeof value === "string" && isSessionWebSearchMode(value) ? value : null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return Number(value) !== 0;
  return fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}

function normalizeOutputSchema(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function cleanupLegacySqliteArtifacts(legacyDbPath: string): void {
  for (const suffix of LEGACY_SQLITE_ARTIFACT_SUFFIXES) {
    const filePath = `${legacyDbPath}${suffix}`;
    if (!existsSync(filePath)) continue;
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Retry on the next startup; legacy files are no longer a source of truth.
    }
  }
}
