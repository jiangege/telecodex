import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SESSION_PROFILE,
  isSessionApprovalPolicy,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  type SessionApprovalPolicy,
  type SessionReasoningEffort,
  type SessionSandboxMode,
} from "../config.js";

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
  runtimeStatus: SessionRuntimeStatus;
  runtimeStatusDetail: string | null;
  runtimeStatusUpdatedAt: string;
  activeTurnId: string | null;
  outputMessageId: number | null;
  pinnedStatusMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type SessionRuntimeStatus =
  | "idle"
  | "preparing"
  | "running"
  | "waiting_approval"
  | "waiting_input"
  | "recovering"
  | "failed";

export interface SessionRuntimeState {
  status: SessionRuntimeStatus;
  detail: string | null;
  updatedAt: string;
  activeTurnId: string | null;
}

export interface TurnDelivery {
  turnId: string;
  threadId: string;
  sessionKey: string;
  chatId: string;
  messageThreadId: string | null;
  outputMessageId: number | null;
  status: TurnDeliveryStatus;
  contentHash: string | null;
  failureCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  alertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TurnDeliveryStatus = "pending" | "delivering" | "delivered" | "failed";

export interface TurnDeliveryStats {
  pending: number;
  delivering: number;
  delivered: number;
  failed: number;
}

export interface QueuedInput {
  id: number;
  sessionKey: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export type PendingInteractionKind =
  | "approval"
  | "permissions"
  | "tool_user_input"
  | "mcp_elicitation_form"
  | "mcp_elicitation_url"
  | "terminal_stdin";

export interface PendingInteraction {
  interactionId: string;
  sessionKey: string;
  kind: PendingInteractionKind;
  requestJson: string;
  messageId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  session_key: string;
  chat_id: string;
  message_thread_id: string | null;
  telegram_topic_name?: string | null;
  thread_bootstrap_state?: string | null;
  codex_thread_id: string | null;
  cwd: string;
  model: string;
  mode: string;
  sandbox_mode?: string | null;
  approval_policy?: string | null;
  reasoning_effort?: string | null;
  runtime_status?: string | null;
  runtime_status_detail?: string | null;
  runtime_status_updated_at?: string | null;
  active_turn_id: string | null;
  output_message_id: number | null;
  pinned_status_message_id?: number | null;
  created_at: string;
  updated_at: string;
}

interface TurnDeliveryRow {
  turn_id: string;
  thread_id: string;
  session_key: string;
  chat_id: string;
  message_thread_id: string | null;
  output_message_id: number | null;
  status: string;
  content_hash: string | null;
  failure_count: number;
  last_error: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string | null;
  delivered_at: string | null;
  alerted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface QueuedInputRow {
  id: number;
  session_key: string;
  text: string;
  created_at: string;
  updated_at: string;
}

interface PendingInteractionRow {
  interaction_id: string;
  session_key: string;
  kind: string;
  request_json: string;
  message_id: number | null;
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
          session_key, chat_id, message_thread_id, telegram_topic_name, cwd, model, mode, sandbox_mode, approval_policy, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'read', ?, ?, ?, ?)`,
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
    return row ? mapRow(row) : null;
  }

  getByThreadId(threadId: string): TelegramSession | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE codex_thread_id = ? LIMIT 1")
      .get(threadId) as SessionRow | undefined;
    return row ? mapRow(row) : null;
  }

  listTopicSessions(): TelegramSession[] {
    const rows = this.db
      .prepare("SELECT * FROM sessions WHERE message_thread_id IS NOT NULL ORDER BY session_key ASC")
      .all() as unknown as SessionRow[];
    return rows.map(mapRow);
  }

  remove(sessionKey: string): void {
    this.db.prepare("DELETE FROM pending_interactions WHERE session_key = ?").run(sessionKey);
    this.db.prepare("DELETE FROM queued_inputs WHERE session_key = ?").run(sessionKey);
    this.db.prepare("DELETE FROM sessions WHERE session_key = ?").run(sessionKey);
  }

  getTurnDelivery(turnId: string): TurnDelivery | null {
    const row = this.db
      .prepare("SELECT * FROM turn_deliveries WHERE turn_id = ?")
      .get(turnId) as TurnDeliveryRow | undefined;
    return row ? mapTurnDeliveryRow(row) : null;
  }

  listTurnDeliveries(): TurnDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM turn_deliveries ORDER BY created_at ASC")
      .all() as unknown as TurnDeliveryRow[];
    return rows.map(mapTurnDeliveryRow);
  }

  listPendingTurnDeliveries(): TurnDelivery[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM turn_deliveries WHERE status IN ('pending', 'delivering', 'failed') ORDER BY created_at ASC",
      )
      .all() as unknown as TurnDeliveryRow[];
    return rows.map(mapTurnDeliveryRow);
  }

  listTurnDeliveriesForThread(threadId: string): TurnDelivery[] {
    const rows = this.db
      .prepare("SELECT * FROM turn_deliveries WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as unknown as TurnDeliveryRow[];
    return rows.map(mapTurnDeliveryRow);
  }

  enqueueInput(sessionKey: string, text: string): QueuedInput {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO queued_inputs (session_key, text, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(sessionKey, text, now, now) as { lastInsertRowid?: number | bigint };
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

  putPendingInteraction(input: {
    interactionId: string;
    sessionKey: string;
    kind: PendingInteractionKind;
    requestJson: string;
    messageId?: number | null;
  }): PendingInteraction {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pending_interactions (
          interaction_id, session_key, kind, request_json, message_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(interaction_id) DO UPDATE SET
          session_key = excluded.session_key,
          kind = excluded.kind,
          request_json = excluded.request_json,
          message_id = excluded.message_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.interactionId,
        input.sessionKey,
        input.kind,
        input.requestJson,
        input.messageId ?? null,
        now,
        now,
      );
    const interaction = this.getPendingInteraction(input.interactionId);
    if (!interaction) throw new Error("Pending interaction upsert failed");
    return interaction;
  }

  getPendingInteraction(interactionId: string): PendingInteraction | null {
    const row = this.db
      .prepare("SELECT * FROM pending_interactions WHERE interaction_id = ?")
      .get(interactionId) as PendingInteractionRow | undefined;
    return row ? mapPendingInteractionRow(row) : null;
  }

  getOldestPendingInteractionForSession(
    sessionKey: string,
    kinds?: PendingInteractionKind[],
  ): PendingInteraction | null {
    if (!kinds || kinds.length === 0) {
      const row = this.db
        .prepare("SELECT * FROM pending_interactions WHERE session_key = ? ORDER BY created_at ASC LIMIT 1")
        .get(sessionKey) as PendingInteractionRow | undefined;
      return row ? mapPendingInteractionRow(row) : null;
    }
    const placeholders = kinds.map(() => "?").join(", ");
    const row = this.db
      .prepare(
        `SELECT * FROM pending_interactions
         WHERE session_key = ? AND kind IN (${placeholders})
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(sessionKey, ...kinds) as PendingInteractionRow | undefined;
    return row ? mapPendingInteractionRow(row) : null;
  }

  listPendingInteractionsForSession(sessionKey: string, limit = 20): PendingInteraction[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_interactions
         WHERE session_key = ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(sessionKey, limit) as unknown as PendingInteractionRow[];
    return rows.map(mapPendingInteractionRow);
  }

  setPendingInteractionMessage(interactionId: string, messageId: number | null): void {
    this.db
      .prepare("UPDATE pending_interactions SET message_id = ?, updated_at = ? WHERE interaction_id = ?")
      .run(messageId, new Date().toISOString(), interactionId);
  }

  removePendingInteraction(interactionId: string): void {
    this.db.prepare("DELETE FROM pending_interactions WHERE interaction_id = ?").run(interactionId);
  }

  removePendingInteractionsForSession(sessionKey: string): void {
    this.db.prepare("DELETE FROM pending_interactions WHERE session_key = ?").run(sessionKey);
  }

  removePendingInteractionsForSessionKinds(sessionKey: string, kinds: PendingInteractionKind[]): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `DELETE FROM pending_interactions
         WHERE session_key = ? AND kind IN (${placeholders})`,
      )
      .run(sessionKey, ...kinds) as { changes?: number };
    return result.changes ?? 0;
  }

  getTurnDeliveryStats(): TurnDeliveryStats {
    return this.getTurnDeliveryStatsWhere();
  }

  getTurnDeliveryStatsForThread(threadId: string): TurnDeliveryStats {
    return this.getTurnDeliveryStatsWhere("thread_id = ?", threadId);
  }

  listRetryableTurnDeliveries(
    nowIso: string,
    maxFailureCount: number,
    deliveringStaleBeforeIso: string = nowIso,
  ): TurnDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turn_deliveries
         WHERE (
               (status IN ('pending', 'failed') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'delivering' AND (last_attempt_at IS NULL OR last_attempt_at <= ?))
         )
           AND failure_count < ?
         ORDER BY created_at ASC`,
      )
      .all(nowIso, deliveringStaleBeforeIso, maxFailureCount) as unknown as TurnDeliveryRow[];
    return rows.map(mapTurnDeliveryRow);
  }

  listExhaustedUnalertedTurnDeliveries(maxFailureCount: number): TurnDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM turn_deliveries
         WHERE status = 'failed'
           AND failure_count >= ?
           AND alerted_at IS NULL
         ORDER BY updated_at ASC`,
      )
      .all(maxFailureCount) as unknown as TurnDeliveryRow[];
    return rows.map(mapTurnDeliveryRow);
  }

  upsertTurnDelivery(input: {
    turnId: string;
    threadId: string;
    sessionKey: string;
    chatId: string;
    messageThreadId: string | null;
    outputMessageId: number | null;
  }): TurnDelivery {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO turn_deliveries (
          turn_id, thread_id, session_key, chat_id, message_thread_id, output_message_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(turn_id) DO UPDATE SET
          thread_id = excluded.thread_id,
          session_key = excluded.session_key,
          chat_id = excluded.chat_id,
          message_thread_id = excluded.message_thread_id,
          output_message_id = excluded.output_message_id,
          status = 'pending',
          content_hash = NULL,
          last_error = NULL,
          last_attempt_at = NULL,
          next_attempt_at = NULL,
          delivered_at = NULL,
          alerted_at = NULL,
          failure_count = 0,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.turnId,
        input.threadId,
        input.sessionKey,
        input.chatId,
        input.messageThreadId,
        input.outputMessageId,
        now,
        now,
      );

    const delivery = this.getTurnDelivery(input.turnId);
    if (!delivery) throw new Error("Turn delivery upsert failed");
    return delivery;
  }

  setTurnDeliveryMessage(turnId: string, messageId: number | null): void {
    this.db
      .prepare("UPDATE turn_deliveries SET output_message_id = ?, updated_at = ? WHERE turn_id = ?")
      .run(messageId, new Date().toISOString(), turnId);
  }

  markTurnDeliveryDelivering(turnId: string, contentHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE turn_deliveries
         SET status = 'delivering',
             content_hash = ?,
             last_error = NULL,
             last_attempt_at = ?,
             next_attempt_at = NULL,
             updated_at = ?
         WHERE turn_id = ?`,
      )
      .run(contentHash, now, now, turnId);
  }

  markTurnDeliveryDelivered(turnId: string, contentHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE turn_deliveries
         SET status = 'delivered',
             content_hash = ?,
             last_error = NULL,
             last_attempt_at = ?,
             next_attempt_at = NULL,
             delivered_at = ?,
             updated_at = ?
         WHERE turn_id = ?`,
      )
      .run(contentHash, now, now, now, turnId);
  }

  markTurnDeliveryFailed(turnId: string, input: { error: string; nextAttemptAt: string | null }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE turn_deliveries
         SET status = 'failed',
             failure_count = failure_count + 1,
             last_error = ?,
             last_attempt_at = ?,
             next_attempt_at = ?,
             updated_at = ?
         WHERE turn_id = ?`,
      )
      .run(input.error, now, input.nextAttemptAt, now, turnId);
  }

  markTurnDeliveryAlerted(turnId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE turn_deliveries SET alerted_at = ?, updated_at = ? WHERE turn_id = ?")
      .run(now, now, turnId);
  }

  removeTurnDelivery(turnId: string): void {
    this.db.prepare("DELETE FROM turn_deliveries WHERE turn_id = ?").run(turnId);
  }

  removeTurnDeliveriesForThread(threadId: string): void {
    this.db.prepare("DELETE FROM turn_deliveries WHERE thread_id = ?").run(threadId);
  }

  setThread(sessionKey: string, threadId: string | null): void {
    const now = new Date().toISOString();
    this.patch(sessionKey, {
      codex_thread_id: threadId,
      active_turn_id: null,
      output_message_id: null,
      runtime_status: "idle",
      runtime_status_detail: null,
      runtime_status_updated_at: now,
    });
  }

  setTelegramTopicName(sessionKey: string, topicName: string | null): void {
    this.patch(sessionKey, { telegram_topic_name: topicName });
  }

  setActiveTurn(sessionKey: string, turnId: string | null): void {
    this.patch(sessionKey, { active_turn_id: turnId });
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

  setPinnedStatusMessage(sessionKey: string, messageId: number | null): void {
    this.patch(sessionKey, { pinned_status_message_id: messageId });
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
      mode: sandboxMode === "workspace-write" || sandboxMode === "danger-full-access" ? "write" : "read",
    });
  }

  setApprovalPolicy(sessionKey: string, approvalPolicy: SessionApprovalPolicy): void {
    this.patch(sessionKey, { approval_policy: approvalPolicy });
  }

  setReasoningEffort(sessionKey: string, reasoningEffort: SessionReasoningEffort | null): void {
    this.patch(sessionKey, { reasoning_effort: reasoningEffort });
  }

  syncRuntimeConfig(
    sessionKey: string,
    input: {
      cwd?: string;
      model?: string;
      sandboxMode?: SessionSandboxMode;
      approvalPolicy?: SessionApprovalPolicy;
      reasoningEffort?: SessionReasoningEffort | null;
    },
  ): void {
    const fields: Record<string, string | number | null> = {};

    if (input.cwd !== undefined) {
      fields.cwd = input.cwd;
    }
    if (input.model !== undefined) {
      fields.model = input.model;
    }
    if (input.sandboxMode !== undefined) {
      fields.sandbox_mode = input.sandboxMode;
      fields.mode = input.sandboxMode === "workspace-write" || input.sandboxMode === "danger-full-access" ? "write" : "read";
    }
    if (input.approvalPolicy !== undefined) {
      fields.approval_policy = input.approvalPolicy;
    }
    if (input.reasoningEffort !== undefined) {
      fields.reasoning_effort = input.reasoningEffort;
    }

    this.patch(sessionKey, fields);
  }

  private patch(sessionKey: string, fields: Record<string, string | number | null>): void {
    const entries = Object.entries(fields);
    if (entries.length === 0) return;
    const setSql = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    values.push(new Date().toISOString(), sessionKey);
    this.db.prepare(`UPDATE sessions SET ${setSql}, updated_at = ? WHERE session_key = ?`).run(...values);
  }

  private getTurnDeliveryStatsWhere(whereSql?: string, value?: string): TurnDeliveryStats {
    const stats: TurnDeliveryStats = {
      pending: 0,
      delivering: 0,
      delivered: 0,
      failed: 0,
    };
    const query = whereSql
      ? `SELECT status, COUNT(*) AS count FROM turn_deliveries WHERE ${whereSql} GROUP BY status`
      : "SELECT status, COUNT(*) AS count FROM turn_deliveries GROUP BY status";
    const rows = (value === undefined ? this.db.prepare(query).all() : this.db.prepare(query).all(value)) as Array<{
      status: string;
      count: number;
    }>;
    for (const row of rows) {
      const status = normalizeTurnDeliveryStatus(row.status);
      stats[status] = row.count;
    }
    return stats;
  }
}

export function makeSessionKey(chatId: number | string, messageThreadId?: number | string | null): string {
  return messageThreadId == null ? String(chatId) : `${chatId}:${messageThreadId}`;
}

function mapRow(row: SessionRow): TelegramSession {
  return {
    sessionKey: row.session_key,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    telegramTopicName: row.telegram_topic_name ?? null,
    codexThreadId: row.codex_thread_id,
    cwd: row.cwd,
    model: row.model,
    sandboxMode: normalizeSandboxMode(row),
    approvalPolicy: normalizeApprovalPolicy(row.approval_policy),
    reasoningEffort: normalizeReasoningEffort(row.reasoning_effort),
    runtimeStatus: normalizeSessionRuntimeStatus(row.runtime_status, row.active_turn_id),
    runtimeStatusDetail: row.runtime_status_detail ?? null,
    runtimeStatusUpdatedAt: row.runtime_status_updated_at ?? row.updated_at,
    activeTurnId: row.active_turn_id,
    outputMessageId: row.output_message_id,
    pinnedStatusMessageId: row.pinned_status_message_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTurnDeliveryRow(row: TurnDeliveryRow): TurnDelivery {
  return {
    turnId: row.turn_id,
    threadId: row.thread_id,
    sessionKey: row.session_key,
    chatId: row.chat_id,
    messageThreadId: row.message_thread_id,
    outputMessageId: row.output_message_id,
    status: normalizeTurnDeliveryStatus(row.status),
    contentHash: row.content_hash,
    failureCount: row.failure_count,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    deliveredAt: row.delivered_at,
    alertedAt: row.alerted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapQueuedInputRow(row: QueuedInputRow): QueuedInput {
  return {
    id: row.id,
    sessionKey: row.session_key,
    text: row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPendingInteractionRow(row: PendingInteractionRow): PendingInteraction {
  return {
    interactionId: row.interaction_id,
    sessionKey: row.session_key,
    kind: normalizePendingInteractionKind(row.kind),
    requestJson: row.request_json,
    messageId: row.message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeSandboxMode(row: SessionRow): SessionSandboxMode {
  if (row.sandbox_mode && isSessionSandboxMode(row.sandbox_mode)) {
    return row.sandbox_mode;
  }
  return row.mode === "write" ? "workspace-write" : "read-only";
}

function normalizeApprovalPolicy(value: string | null | undefined): SessionApprovalPolicy {
  if (value && isSessionApprovalPolicy(value)) {
    return value;
  }
  return DEFAULT_SESSION_PROFILE.approvalPolicy;
}

function normalizeReasoningEffort(value: string | null | undefined): SessionReasoningEffort | null {
  if (value && isSessionReasoningEffort(value)) {
    return value;
  }
  return null;
}

function normalizeSessionRuntimeStatus(
  value: string | null | undefined,
  activeTurnId: string | null,
): SessionRuntimeStatus {
  switch (value) {
    case "idle":
    case "preparing":
    case "running":
    case "waiting_approval":
    case "waiting_input":
    case "recovering":
    case "failed":
      return value;
    default:
      return activeTurnId ? "running" : "idle";
  }
}

function normalizeTurnDeliveryStatus(value: string | null | undefined): TurnDeliveryStatus {
  switch (value) {
    case "pending":
    case "delivering":
    case "delivered":
    case "failed":
      return value;
    default:
      return "pending";
  }
}

function normalizePendingInteractionKind(value: string | null | undefined): PendingInteractionKind {
  switch (value) {
    case "approval":
    case "permissions":
    case "tool_user_input":
    case "mcp_elicitation_form":
    case "mcp_elicitation_url":
    case "terminal_stdin":
      return value;
    default:
      return "approval";
  }
}
