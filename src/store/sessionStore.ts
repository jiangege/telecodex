import {
  DEFAULT_SESSION_PROFILE,
  type SessionApprovalPolicy,
  type SessionReasoningEffort,
  type SessionSandboxMode,
  type SessionWebSearchMode,
} from "../config.js";
import { FileStateStorage, type StoredSessionRecord } from "./fileState.js";

export type StoredCodexInput = string | Array<StoredTextInput | StoredLocalImageInput>;

export interface StoredTextInput {
  type: "text";
  text: string;
}

export interface StoredLocalImageInput {
  type: "local_image";
  path: string;
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

export class SessionStore {
  private readonly runtimeStateBySession = new Map<string, SessionRuntimeState>();
  private readonly outputMessageBySession = new Map<string, number | null>();

  constructor(private readonly storage: FileStateStorage) {}

  flush(): Promise<void> {
    return this.storage.flush();
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
    this.runtimeStateBySession.delete(sessionKey);
    this.outputMessageBySession.delete(sessionKey);
    this.storage.removeSession(sessionKey);
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
