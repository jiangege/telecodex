import {
  DEFAULT_SESSION_PROFILE,
  type SessionApprovalPolicy,
  type SessionReasoningEffort,
  type SessionSandboxMode,
  type SessionWebSearchMode,
} from "../config.js";
import { FileStateStorage, type StoredSessionRecord } from "./fileState.js";

export type StoredCodexInput = string | Array<StoredTextInput | StoredLocalImageInput>;
export type BindingCodeMode = "bootstrap" | "rebind";

export const BINDING_CODE_TTL_MS = 15 * 60 * 1000;
export const BINDING_CODE_MAX_ATTEMPTS = 5;

export interface StoredTextInput {
  type: "text";
  text: string;
}

export interface StoredLocalImageInput {
  type: "local_image";
  path: string;
}

export interface BindingCodeState {
  code: string;
  mode: BindingCodeMode;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  issuedByUserId: number | null;
}

export interface BindingCodeAttemptResult {
  attempts: number;
  remaining: number;
  exhausted: boolean;
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
}

export interface TelegramSession extends StoredSessionRecord {
  runtimeStatus: SessionRuntimeStatus;
  runtimeStatusDetail: string | null;
  runtimeStatusUpdatedAt: string;
  outputMessageId: number | null;
}

export interface QueuedInput {
  id: number;
  sessionKey: string;
  text: string;
  input: StoredCodexInput;
  createdAt: string;
  updatedAt: string;
}

export class SessionStore {
  private readonly runtimeStateBySession = new Map<string, SessionRuntimeState>();
  private readonly outputMessageBySession = new Map<string, number | null>();
  private readonly queueBySession = new Map<string, QueuedInput[]>();
  private nextQueuedInputId = 1;

  constructor(private readonly storage: FileStateStorage) {}

  flush(): Promise<void> {
    return this.storage.flush();
  }

  getAppState(key: string): string | null {
    return this.storage.getAppState(key);
  }

  setAppState(key: string, value: string): void {
    this.storage.setAppState(key, value);
  }

  deleteAppState(key: string): void {
    this.storage.deleteAppState(key);
  }

  getAuthorizedUserId(): number | null {
    const value = this.getAppState("authorized_user_id");
    if (value == null) return null;
    const userId = Number(value);
    return Number.isSafeInteger(userId) ? userId : null;
  }

  getBootstrapCode(): string | null {
    const binding = this.getBindingCodeState();
    return binding?.mode === "bootstrap" ? binding.code : null;
  }

  setBootstrapCode(code: string): void {
    this.issueBindingCode({
      code,
      mode: "bootstrap",
    });
  }

  clearBootstrapCode(): void {
    this.clearBindingCode();
  }

  getBindingCodeState(now = new Date()): BindingCodeState | null {
    const code = this.getAppState("bootstrap_code");
    const createdAt = this.getAppState("binding_code_created_at");
    const expiresAt = this.getAppState("binding_code_expires_at");
    if (!code || !createdAt || !expiresAt) return null;

    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) {
      this.clearBindingCode();
      return null;
    }

    const attempts = normalizeNonNegativeInteger(this.getAppState("binding_code_attempts"));
    if (attempts >= BINDING_CODE_MAX_ATTEMPTS) {
      this.clearBindingCode();
      return null;
    }

    return {
      code,
      mode: normalizeBindingCodeMode(this.getAppState("binding_code_mode")),
      createdAt,
      expiresAt,
      attempts,
      maxAttempts: BINDING_CODE_MAX_ATTEMPTS,
      issuedByUserId: normalizeOptionalUserId(this.getAppState("binding_code_issued_by_user_id")),
    };
  }

  issueBindingCode(input: {
    code: string;
    mode: BindingCodeMode;
    now?: Date;
    ttlMs?: number;
    issuedByUserId?: number | null;
  }): BindingCodeState {
    const now = input.now ?? new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + (input.ttlMs ?? BINDING_CODE_TTL_MS)).toISOString();
    this.setAppState("bootstrap_code", input.code);
    this.setAppState("binding_code_mode", input.mode);
    this.setAppState("binding_code_created_at", createdAt);
    this.setAppState("binding_code_expires_at", expiresAt);
    this.setAppState("binding_code_attempts", "0");
    if (input.issuedByUserId == null) {
      this.deleteAppState("binding_code_issued_by_user_id");
    } else {
      this.setAppState("binding_code_issued_by_user_id", String(input.issuedByUserId));
    }
    return {
      code: input.code,
      mode: input.mode,
      createdAt,
      expiresAt,
      attempts: 0,
      maxAttempts: BINDING_CODE_MAX_ATTEMPTS,
      issuedByUserId: input.issuedByUserId ?? null,
    };
  }

  recordBindingCodeFailure(now = new Date()): BindingCodeAttemptResult | null {
    const state = this.getBindingCodeState(now);
    if (!state) return null;

    const attempts = state.attempts + 1;
    if (attempts >= state.maxAttempts) {
      this.clearBindingCode();
      return {
        attempts,
        remaining: 0,
        exhausted: true,
      };
    }

    this.setAppState("binding_code_attempts", String(attempts));
    return {
      attempts,
      remaining: state.maxAttempts - attempts,
      exhausted: false,
    };
  }

  clearBindingCode(): void {
    this.deleteAppState("bootstrap_code");
    this.deleteAppState("binding_code_mode");
    this.deleteAppState("binding_code_created_at");
    this.deleteAppState("binding_code_expires_at");
    this.deleteAppState("binding_code_attempts");
    this.deleteAppState("binding_code_issued_by_user_id");
  }

  claimAuthorizedUserId(userId: number): number {
    const existing = this.getAuthorizedUserId();
    if (existing != null) return existing;
    this.setAppState("authorized_user_id", String(userId));
    this.clearBindingCode();
    const current = this.getAuthorizedUserId();
    if (current == null) throw new Error("Failed to persist authorized Telegram user id");
    return current;
  }

  rebindAuthorizedUserId(userId: number): void {
    this.setAppState("authorized_user_id", String(userId));
    this.clearBindingCode();
  }

  clearAuthorizedUserId(): void {
    this.deleteAppState("authorized_user_id");
    this.clearBindingCode();
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
    this.storage.putSession({
      sessionKey: input.sessionKey,
      chatId: input.chatId,
      messageThreadId: input.messageThreadId,
      telegramTopicName: input.telegramTopicName ?? null,
      codexThreadId: null,
      cwd: input.defaultCwd,
      model: input.defaultModel,
      sandboxMode: DEFAULT_SESSION_PROFILE.sandboxMode,
      approvalPolicy: DEFAULT_SESSION_PROFILE.approvalPolicy,
      reasoningEffort: null,
      webSearchMode: null,
      networkAccessEnabled: true,
      skipGitRepoCheck: true,
      additionalDirectories: [],
      outputSchema: null,
      createdAt: now,
      updatedAt: now,
    });

    const created = this.get(input.sessionKey);
    if (!created) throw new Error("Session insert failed");
    return created;
  }

  get(sessionKey: string): TelegramSession | null {
    const stored = this.storage.getSession(sessionKey);
    return mapStoredSession(stored, this.runtimeStateBySession.get(sessionKey), this.outputMessageBySession.get(sessionKey));
  }

  getByThreadId(threadId: string): TelegramSession | null {
    const stored = this.storage.getSessionByThreadId(threadId);
    return stored ? mapStoredSession(stored, this.runtimeStateBySession.get(stored.sessionKey), this.outputMessageBySession.get(stored.sessionKey)) : null;
  }

  listTopicSessions(): TelegramSession[] {
    return this.storage
      .listSessions()
      .filter((session) => session.messageThreadId != null)
      .map((session) => mapStoredSession(session, this.runtimeStateBySession.get(session.sessionKey), this.outputMessageBySession.get(session.sessionKey)))
      .filter((session): session is TelegramSession => session != null);
  }

  remove(sessionKey: string): void {
    this.queueBySession.delete(sessionKey);
    this.runtimeStateBySession.delete(sessionKey);
    this.outputMessageBySession.delete(sessionKey);
    this.storage.removeSession(sessionKey);
  }

  enqueueInput(sessionKey: string, input: StoredCodexInput): QueuedInput {
    const now = new Date().toISOString();
    const queued: QueuedInput = {
      id: this.nextQueuedInputId,
      sessionKey,
      text: formatCodexInputPreview(input),
      input: cloneStoredCodexInput(input),
      createdAt: now,
      updatedAt: now,
    };
    this.nextQueuedInputId += 1;
    const queue = this.queueBySession.get(sessionKey) ?? [];
    queue.push(queued);
    this.queueBySession.set(sessionKey, queue);
    return cloneQueuedInput(queued);
  }

  getQueuedInput(id: number): QueuedInput | null {
    for (const queue of this.queueBySession.values()) {
      const match = queue.find((item) => item.id === id);
      if (match) return cloneQueuedInput(match);
    }
    return null;
  }

  getQueuedInputCount(sessionKey: string): number {
    return this.queueBySession.get(sessionKey)?.length ?? 0;
  }

  peekNextQueuedInput(sessionKey: string): QueuedInput | null {
    const queue = this.queueBySession.get(sessionKey);
    const [next] = queue ?? [];
    return next ? cloneQueuedInput(next) : null;
  }

  listQueuedInputs(sessionKey: string, limit = 5): QueuedInput[] {
    const queue = this.queueBySession.get(sessionKey) ?? [];
    return queue.slice(0, limit).map(cloneQueuedInput);
  }

  removeQueuedInput(id: number): void {
    for (const [sessionKey, queue] of this.queueBySession.entries()) {
      const index = queue.findIndex((item) => item.id === id);
      if (index < 0) continue;
      queue.splice(index, 1);
      if (queue.length === 0) {
        this.queueBySession.delete(sessionKey);
      }
      return;
    }
  }

  removeQueuedInputForSession(sessionKey: string, id: number): boolean {
    const queue = this.queueBySession.get(sessionKey);
    if (!queue) return false;
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) {
      this.queueBySession.delete(sessionKey);
    }
    return true;
  }

  clearQueuedInputs(sessionKey: string): number {
    const queue = this.queueBySession.get(sessionKey) ?? [];
    this.queueBySession.delete(sessionKey);
    return queue.length;
  }

  bindThread(sessionKey: string, threadId: string | null): void {
    this.patchDurableSession(sessionKey, {
      codexThreadId: threadId,
    });
  }

  setTelegramTopicName(sessionKey: string, topicName: string | null): void {
    this.patchDurableSession(sessionKey, {
      telegramTopicName: topicName,
    });
  }

  setRuntimeState(sessionKey: string, state: SessionRuntimeState): void {
    this.runtimeStateBySession.set(sessionKey, state);
  }

  setOutputMessage(sessionKey: string, messageId: number | null): void {
    if (messageId == null) {
      this.outputMessageBySession.delete(sessionKey);
      return;
    }
    this.outputMessageBySession.set(sessionKey, messageId);
  }

  setCwd(sessionKey: string, cwd: string): void {
    this.patchDurableSession(sessionKey, { cwd });
  }

  setModel(sessionKey: string, model: string): void {
    this.patchDurableSession(sessionKey, { model });
  }

  setSandboxMode(sessionKey: string, sandboxMode: SessionSandboxMode): void {
    this.patchDurableSession(sessionKey, { sandboxMode });
  }

  setApprovalPolicy(sessionKey: string, approvalPolicy: SessionApprovalPolicy): void {
    this.patchDurableSession(sessionKey, { approvalPolicy });
  }

  setReasoningEffort(sessionKey: string, reasoningEffort: SessionReasoningEffort | null): void {
    this.patchDurableSession(sessionKey, { reasoningEffort });
  }

  setWebSearchMode(sessionKey: string, webSearchMode: SessionWebSearchMode | null): void {
    this.patchDurableSession(sessionKey, { webSearchMode });
  }

  setNetworkAccessEnabled(sessionKey: string, enabled: boolean): void {
    this.patchDurableSession(sessionKey, { networkAccessEnabled: enabled });
  }

  setSkipGitRepoCheck(sessionKey: string, skip: boolean): void {
    this.patchDurableSession(sessionKey, { skipGitRepoCheck: skip });
  }

  setAdditionalDirectories(sessionKey: string, directories: string[]): void {
    this.patchDurableSession(sessionKey, { additionalDirectories: [...directories] });
  }

  setOutputSchema(sessionKey: string, outputSchema: string | null): void {
    this.patchDurableSession(sessionKey, { outputSchema });
  }

  private patchDurableSession(
    sessionKey: string,
    patch: Partial<Omit<StoredSessionRecord, "sessionKey" | "createdAt">>,
  ): void {
    this.storage.patchSession(sessionKey, patch);
  }
}

export function makeSessionKey(chatId: number | string, messageThreadId?: number | string | null): string {
  return messageThreadId == null ? String(chatId) : `${chatId}:${messageThreadId}`;
}

function mapStoredSession(
  stored: StoredSessionRecord | null,
  runtimeState: SessionRuntimeState | undefined,
  outputMessageId: number | null | undefined,
): TelegramSession | null {
  if (!stored) return null;
  const runtime = runtimeState ?? {
    status: "idle" as const,
    detail: null,
    updatedAt: stored.updatedAt,
  };
  return {
    ...stored,
    additionalDirectories: [...stored.additionalDirectories],
    runtimeStatus: runtime.status,
    runtimeStatusDetail: runtime.detail,
    runtimeStatusUpdatedAt: runtime.updatedAt,
    outputMessageId: outputMessageId ?? null,
  };
}

function cloneQueuedInput(input: QueuedInput): QueuedInput {
  return {
    ...input,
    input: cloneStoredCodexInput(input.input),
  };
}

function cloneStoredCodexInput(input: StoredCodexInput): StoredCodexInput {
  return typeof input === "string" ? input : input.map((item) => ({ ...item }));
}

function normalizeBindingCodeMode(value: string | null): BindingCodeMode {
  return value === "rebind" ? "rebind" : "bootstrap";
}

function normalizeNonNegativeInteger(value: string | null): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeOptionalUserId(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function formatCodexInputPreview(input: StoredCodexInput): string {
  if (typeof input === "string") return input;
  const parts = input.map((item) => (item.type === "text" ? item.text : `[image: ${item.path}]`));
  return parts.join(" ").trim() || "[image]";
}
