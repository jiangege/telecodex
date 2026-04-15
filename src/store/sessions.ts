import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SESSION_PROFILE,
  isSessionApprovalPolicy,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  isSessionWebSearchMode,
  type SessionApprovalPolicy,
  type SessionReasoningEffort,
  type SessionSandboxMode,
  type SessionWebSearchMode,
} from "../config.js";

export type StoredCodexInput = string | Array<StoredTextInput | StoredLocalImageInput>;

export interface StoredTextInput {
  type: "text";
  text: string;
}

export interface StoredLocalImageInput {
  type: "local_image";
  path: string;
}

export interface TelegramSession {
  sessionKey: string;
  chatId: string;
  messageThreadId: string | null;
  telegramTopicName: string | null;
  codexThreadId: string | null;
  cwd: string;
  model: string;
  sandboxMode: SessionSandboxMode;
  approvalPolicy: SessionApprovalPolicy;
  reasoningEffort: SessionReasoningEffort | null;
  webSearchMode: SessionWebSearchMode | null;
  networkAccessEnabled: boolean;
  skipGitRepoCheck: boolean;
  additionalDirectories: string[];
  outputSchema: string | null;
  runtimeStatus: SessionRuntimeStatus;
  runtimeStatusDetail: string | null;
  runtimeStatusUpdatedAt: string;
  activeTurnId: string | null;
  outputMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionRuntimeStatus =
  | "idle"
  | "preparing"
  | "running"
  | "failed";

export interface SessionRuntimeState {
  status: SessionRuntimeStatus;
  detail: string | null;
  updatedAt: string;
  activeTurnId: string | null;
}

export interface QueuedInput {
  id: number;
  sessionKey: string;
  text: string;
  input: StoredCodexInput;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  session_key: string;
  chat_id: string;
  message_thread_id: string | null;
  telegram_topic_name?: string | null;
  codex_thread_id: string | null;
  cwd: string;
  model: string;
  sandbox_mode?: string | null;
  approval_policy?: string | null;
  reasoning_effort?: string | null;
  web_search_mode?: string | null;
  network_access_enabled?: number | bigint | null;
  skip_git_repo_check?: number | bigint | null;
  additional_directories?: string | null;
  output_schema?: string | null;
  runtime_status?: string | null;
  runtime_status_detail?: string | null;
  runtime_status_updated_at?: string | null;
  active_turn_id: string | null;
  output_message_id: number | null;
  created_at: string;
  updated_at: string;
}

interface QueuedInputRow {
  id: number;
  session_key: string;
  text: string;
  input_json?: string | null;
  created_at: string;
  updated_at: string;
}

export class SessionStore {
  constructor(private readonly db: DatabaseSync) {}

  getAppState(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_state WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setAppState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, new Date().toISOString());
  }

  deleteAppState(key: string): void {
    this.db.prepare("DELETE FROM app_state WHERE key = ?").run(key);
  }

  getAuthorizedUserId(): number | null {
    const value = this.getAppState("authorized_user_id");
    if (value == null) return null;
    const userId = Number(value);
    return Number.isSafeInteger(userId) ? userId : null;
  }

  getBootstrapCode(): string | null {
    return this.getAppState("bootstrap_code");
  }

  setBootstrapCode(code: string): void {
    this.setAppState("bootstrap_code", code);
  }

  clearBootstrapCode(): void {
    this.deleteAppState("bootstrap_code");
  }

  claimAuthorizedUserId(userId: number): number {
    const existing = this.getAuthorizedUserId();
    if (existing != null) return existing;

    this.db.prepare("INSERT OR IGNORE INTO app_state (key, value, updated_at) VALUES ('authorized_user_id', ?, ?)").run(
      String(userId),
      new Date().toISOString(),
    );

    const current = this.getAuthorizedUserId();
    if (current == null) throw new Error("Failed to persist authorized Telegram user id");
    this.clearBootstrapCode();
    return current;
  }

  clearAuthorizedUserId(): void {
    this.deleteAppState("authorized_user_id");
  }

  getOrCreate(input: {
    sessionKey: string;
    chatId: string;
    messageThreadId: string | null;
    telegramTopicName?: string | null;
    defaultCwd: string;
    defaultModel: string;
  }): TelegramSession {
    const existing = this.get(input.sessionKey);
    if (existing) return existing;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (
          session_key, chat_id, message_thread_id, telegram_topic_name, cwd, model, sandbox_mode, approval_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionKey,
        input.chatId,
        input.messageThreadId,
        input.telegramTopicName ?? null,
        input.defaultCwd,
        input.defaultModel,
        DEFAULT_SESSION_PROFILE.sandboxMode,
        DEFAULT_SESSION_PROFILE.approvalPolicy,
        now,
        now,
      );

    const created = this.get(input.sessionKey);
    if (!created) throw new Error("Session insert failed");
    return created;
  }

  get(sessionKey: string): TelegramSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE session_key = ?")
      .get(sessionKey) as SessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  getByThreadId(threadId: string): TelegramSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE codex_thread_id = ? LIMIT 1")
      .get(threadId) as SessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  listTopicSessions(): TelegramSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE message_thread_id IS NOT NULL ORDER BY session_key ASC")
      .all() as unknown as SessionRow[];
    return rows.map(mapSessionRow);
  }

  remove(sessionKey: string): void {
    this.db.prepare("DELETE FROM queued_inputs WHERE session_key = ?").run(sessionKey);
    this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
  }

  enqueueInput(sessionKey: string, input: StoredCodexInput): QueuedInput {
    const now = new Date().toISOString();
    const text = formatCodexInputPreview(input);
    const result = this.db
      .prepare(
        `INSERT INTO queued_inputs (session_key, text, input_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionKey, text, JSON.stringify(input), now, now) as { lastInsertRowid?: number | bigint };
    const id = Number(result.lastInsertRowid);
    const queued = this.getQueuedInput(id);
    if (!queued) throw new Error("Queued input insert failed");
    return queued;
  }

  getQueuedInput(id: number): QueuedInput | null {
    const row = this.db.prepare("SELECT * FROM queued_inputs WHERE id = ?").get(id) as QueuedInputRow | undefined;
    return row ? mapQueuedInputRow(row) : null;
  }

  getQueuedInputCount(sessionKey: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM queued_inputs WHERE session_key = ?")
      .get(sessionKey) as { count?: number } | undefined;
    return row?.count ?? 0;
  }

  peekNextQueuedInput(sessionKey: string): QueuedInput | null {
    const row = this.db
      .prepare("SELECT * FROM queued_inputs WHERE session_key = ? ORDER BY id ASC LIMIT 1")
      .get(sessionKey) as QueuedInputRow | undefined;
    return row ? mapQueuedInputRow(row) : null;
  }

  listQueuedInputs(sessionKey: string, limit = 5): QueuedInput[] {
    const rows = this.db
      .prepare("SELECT * FROM queued_inputs WHERE session_key = ? ORDER BY id ASC LIMIT ?")
      .all(sessionKey, limit) as unknown as QueuedInputRow[];
    return rows.map(mapQueuedInputRow);
  }

  removeQueuedInput(id: number): void {
    this.db.prepare("DELETE FROM queued_inputs WHERE id = ?").run(id);
  }

  removeQueuedInputForSession(sessionKey: string, id: number): boolean {
    const result = this.db
      .prepare("DELETE FROM queued_inputs WHERE session_key = ? AND id = ?")
      .run(sessionKey, id) as { changes?: number };
    return (result.changes ?? 0) > 0;
  }

  clearQueuedInputs(sessionKey: string): number {
    const result = this.db.prepare("DELETE FROM queued_inputs WHERE session_key = ?").run(sessionKey) as {
      changes?: number;
    };
    return result.changes ?? 0;
  }

  bindThread(sessionKey: string, threadId: string | null): void {
    this.patch(sessionKey, {
      codex_thread_id: threadId,
    });
  }

  setTelegramTopicName(sessionKey: string, topicName: string | null): void {
    this.patch(sessionKey, { telegram_topic_name: topicName });
  }

  setRuntimeState(sessionKey: string, state: SessionRuntimeState): void {
    this.patch(sessionKey, {
      runtime_status: state.status,
      runtime_status_detail: state.detail,
      runtime_status_updated_at: state.updatedAt,
      active_turn_id: state.activeTurnId,
    });
  }

  setOutputMessage(sessionKey: string, messageId: number | null): void {
    this.patch(sessionKey, { output_message_id: messageId });
  }

  setCwd(sessionKey: string, cwd: string): void {
    this.patch(sessionKey, { cwd });
  }

  setModel(sessionKey: string, model: string): void {
    this.patch(sessionKey, { model });
  }

  setSandboxMode(sessionKey: string, sandboxMode: SessionSandboxMode): void {
    this.patch(sessionKey, {
      sandbox_mode: sandboxMode,
    });
  }

  setApprovalPolicy(sessionKey: string, approvalPolicy: SessionApprovalPolicy): void {
    this.patch(sessionKey, { approval_policy: approvalPolicy });
  }

  setReasoningEffort(sessionKey: string, reasoningEffort: SessionReasoningEffort | null): void {
    this.patch(sessionKey, { reasoning_effort: reasoningEffort });
  }

  setWebSearchMode(sessionKey: string, webSearchMode: SessionWebSearchMode | null): void {
    this.patch(sessionKey, { web_search_mode: webSearchMode });
  }

  setNetworkAccessEnabled(sessionKey: string, enabled: boolean): void {
    this.patch(sessionKey, { network_access_enabled: enabled ? 1 : 0 });
  }

  setSkipGitRepoCheck(sessionKey: string, skip: boolean): void {
    this.patch(sessionKey, { skip_git_repo_check: skip ? 1 : 0 });
  }

  setAdditionalDirectories(sessionKey: string, directories: string[]): void {
    this.patch(sessionKey, { additional_directories: JSON.stringify(directories) });
  }

  setOutputSchema(sessionKey: string, outputSchema: string | null): void {
    this.patch(sessionKey, { output_schema: outputSchema });
  }

  private patch(sessionKey: string, fields: Record<string, string | number | null>): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    values.push(new Date().toISOString(), sessionKey);
    this.db.prepare(`UPDATE sessions SET ${setSql}, updated_at = ? WHERE session_key = ?`).run(...values);
  }
}

export function makeSessionKey(chatId: number | string, messageThreadId?: number | string | null): string {
  return messageThreadId == null ? String(chatId) : `${chatId}:${messageThreadId}`;
}

function mapSessionRow(row: SessionRow): TelegramSession {
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    telegramTopicName: row.telegram_topic_name ?? null,
    codexThreadId: row.codex_thread_id,
    cwd: row.cwd,
    model: row.model,
    sandboxMode: normalizeSandboxMode(row.sandbox_mode),
    approvalPolicy: normalizeApprovalPolicy(row.approval_policy),
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    webSearchMode: normalizeWebSearchMode(row.web_search_mode),
    networkAccessEnabled: normalizeBoolean(row.network_access_enabled, true),
    skipGitRepoCheck: normalizeBoolean(row.skip_git_repo_check, true),
    additionalDirectories: normalizeStringArray(row.additional_directories),
    outputSchema: normalizeOutputSchema(row.output_schema),
    runtimeStatus: normalizeRuntimeStatus(row.runtime_status, row.active_turn_id),
    runtimeStatusDetail: row.runtime_status_detail ?? null,
    runtimeStatusUpdatedAt: row.runtime_status_updated_at ?? row.updated_at,
    activeTurnId: row.active_turn_id,
    outputMessageId: row.output_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQueuedInputRow(row: QueuedInputRow): QueuedInput {
  return {
    id: row.id,
    sessionKey: row.session_key,
    text: row.text,
    input: parseStoredCodexInput(row.input_json, row.text),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSandboxMode(value: string | null | undefined): SessionSandboxMode {
  return value && isSessionSandboxMode(value) ? value : DEFAULT_SESSION_PROFILE.sandboxMode;
}

function normalizeApprovalPolicy(value: string | null | undefined): SessionApprovalPolicy {
  return value && isSessionApprovalPolicy(value) ? value : DEFAULT_SESSION_PROFILE.approvalPolicy;
}

function normalizeReasoningEffort(value: string | null | undefined): SessionReasoningEffort | null {
  return value && isSessionReasoningEffort(value) ? value : null;
}

function normalizeWebSearchMode(value: string | null | undefined): SessionWebSearchMode | null {
  return value && isSessionWebSearchMode(value) ? value : null;
}

function normalizeBoolean(value: number | bigint | null | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return Number(value) !== 0;
}

function normalizeStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  } catch {
    return [];
  }
}

function normalizeOutputSchema(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainObject(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function normalizeRuntimeStatus(value: string | null | undefined, activeTurnId: string | null): SessionRuntimeStatus {
  switch (value) {
    case "idle":
    case "preparing":
    case "running":
    case "failed":
      return value;
    default:
      return activeTurnId ? "running" : "idle";
  }
}

function parseStoredCodexInput(inputJson: string | null | undefined, fallbackText: string): StoredCodexInput {
  if (!inputJson) return fallbackText;
  try {
    const parsed = JSON.parse(inputJson) as unknown;
    return normalizeStoredCodexInput(parsed) ?? fallbackText;
  } catch {
    return fallbackText;
  }
}

function normalizeStoredCodexInput(value: unknown): StoredCodexInput | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const items: Array<StoredTextInput | StoredLocalImageInput> = [];
  for (const item of value) {
    if (!isPlainObject(item)) return null;
    if (item.type === "text" && typeof item.text === "string") {
      items.push({ type: "text", text: item.text });
    } else if (item.type === "local_image" && typeof item.path === "string") {
      items.push({ type: "local_image", path: item.path });
    } else {
      return null;
    }
  }
  return items;
}

export function formatCodexInputPreview(input: StoredCodexInput): string {
  if (typeof input === "string") return input;
  const parts = input.map((item) => (item.type === "text" ? item.text : `[image: ${item.path}]`));
  return parts.join(" ").trim() || "[image]";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
