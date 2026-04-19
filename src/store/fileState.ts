import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
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

const FILE_STATE_VERSION = 1;
const require = createRequire(import.meta.url);
const writeFileAtomic = require("write-file-atomic") as (
  filePath: string,
  data: string,
  options?: { encoding?: BufferEncoding; fsync?: boolean },
) => Promise<void>;

interface AppStateFile {
  version: number;
  values: Record<string, string>;
}

interface WorkspacesFile {
  version: number;
  workspaces: StoredWorkspaceBinding[];
}

interface SessionsFile {
  version: number;
  sessions: StoredSessionRecord[];
}

export interface StoredWorkspaceBinding {
  chatId: string;
  name: string;
  workingRoot: string;
  createdAt: string;
  updatedAt: string;
}

export type StoredProjectBinding = StoredWorkspaceBinding;

export interface StoredSessionRecord {
  sessionKey: string;
  chatId: string;
  messageThreadId: string | null;
  telegramTopicName: string | null;
  codexThreadId: string | null;
  model: string;
  sandboxMode: SessionSandboxMode;
  approvalPolicy: SessionApprovalPolicy;
  reasoningEffort: SessionReasoningEffort | null;
  webSearchMode: SessionWebSearchMode | null;
  networkAccessEnabled: boolean;
  skipGitRepoCheck: boolean;
  additionalDirectories: string[];
  outputSchema: string | null;
  createdAt: string;
  updatedAt: string;
}

export class FileStateStorage {
  private readonly appPath: string;
  private readonly workspacesPath: string;
  private readonly legacyProjectsPath: string;
  private readonly sessionsPath: string;
  private readonly appState = new Map<string, string>();
  private readonly workspaces = new Map<string, StoredWorkspaceBinding>();
  private readonly sessions = new Map<string, StoredSessionRecord>();
  private readonly flushStateByPath = new Map<string, PendingFlushState>();

  constructor(private readonly rootDir: string, options?: { createIfMissing?: boolean }) {
    if (options?.createIfMissing !== false) {
      mkdirSync(rootDir, { recursive: true });
    }
    this.appPath = path.join(rootDir, "app.json");
    this.workspacesPath = path.join(rootDir, "workspaces.json");
    this.legacyProjectsPath = path.join(rootDir, "projects.json");
    this.sessionsPath = path.join(rootDir, "sessions.json");

    for (const [key, value] of Object.entries(loadAppStateFile(this.appPath).values)) {
      this.appState.set(key, value);
    }
    const loadedWorkspaces = loadWorkspacesFile(this.workspacesPath, this.legacyProjectsPath);
    for (const workspace of loadedWorkspaces.workspaces) {
      this.workspaces.set(workspace.chatId, normalizeStoredWorkspaceBinding(workspace));
    }
    for (const session of loadSessionsFile(this.sessionsPath).sessions) {
      this.sessions.set(session.sessionKey, normalizeStoredSessionRecord(session));
    }
    if (!existsSync(this.workspacesPath) && loadedWorkspaces.workspaces.length > 0) {
      this.flushWorkspaces();
    }
  }

  getAppState(key: string): string | null {
    return this.appState.get(key) ?? null;
  }

  setAppState(key: string, value: string): void {
    this.appState.set(key, value);
    this.flushAppState();
  }

  deleteAppState(key: string): void {
    if (!this.appState.delete(key)) return;
    this.flushAppState();
  }

  mergeImportedAppState(values: Record<string, string>): void {
    let changed = false;
    for (const [key, value] of Object.entries(values)) {
      if (this.appState.has(key)) continue;
      this.appState.set(key, value);
      changed = true;
    }
    if (changed) this.flushAppState();
  }

  getWorkspace(chatId: string): StoredWorkspaceBinding | null {
    return cloneWorkspaceBinding(this.workspaces.get(chatId) ?? null);
  }

  getProject(chatId: string): StoredWorkspaceBinding | null {
    return this.getWorkspace(chatId);
  }

  upsertWorkspace(input: { chatId: string; workingRoot: string; name: string; now?: string }): StoredWorkspaceBinding {
    const existing = this.workspaces.get(input.chatId);
    const now = input.now ?? new Date().toISOString();
    const workspace: StoredWorkspaceBinding = {
      chatId: input.chatId,
      workingRoot: path.resolve(input.workingRoot),
      name: input.name.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.workspaces.set(workspace.chatId, workspace);
    this.flushWorkspaces();
    return cloneWorkspaceBinding(workspace)!;
  }

  upsertProject(input: { chatId: string; cwd: string; name: string; now?: string }): StoredWorkspaceBinding {
    return this.upsertWorkspace({
      chatId: input.chatId,
      workingRoot: input.cwd,
      name: input.name,
      ...(input.now ? { now: input.now } : {}),
    });
  }

  removeWorkspace(chatId: string): void {
    if (!this.workspaces.delete(chatId)) return;
    this.flushWorkspaces();
  }

  removeProject(chatId: string): void {
    this.removeWorkspace(chatId);
  }

  listWorkspaces(): StoredWorkspaceBinding[] {
    return [...this.workspaces.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((workspace) => cloneWorkspaceBinding(workspace)!)
      .filter((workspace): workspace is StoredWorkspaceBinding => workspace != null);
  }

  listProjects(): StoredWorkspaceBinding[] {
    return this.listWorkspaces();
  }

  mergeImportedWorkspaces(workspaces: StoredWorkspaceBinding[]): void {
    let changed = false;
    for (const workspace of workspaces) {
      if (this.workspaces.has(workspace.chatId)) continue;
      this.workspaces.set(workspace.chatId, normalizeStoredWorkspaceBinding(workspace));
      changed = true;
    }
    if (changed) this.flushWorkspaces();
  }

  mergeImportedProjects(projects: StoredWorkspaceBinding[]): void {
    this.mergeImportedWorkspaces(projects);
  }

  getSession(sessionKey: string): StoredSessionRecord | null {
    return cloneSessionRecord(this.sessions.get(sessionKey) ?? null);
  }

  listSessions(): StoredSessionRecord[] {
    return [...this.sessions.values()]
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
      .map((session) => cloneSessionRecord(session)!)
      .filter((session): session is StoredSessionRecord => session != null);
  }

  getSessionByThreadId(threadId: string): StoredSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.codexThreadId === threadId) {
        return cloneSessionRecord(session);
      }
    }
    return null;
  }

  putSession(session: StoredSessionRecord): StoredSessionRecord {
    const normalized = normalizeStoredSessionRecord(session);
    this.sessions.set(normalized.sessionKey, normalized);
    this.flushSessions();
    return cloneSessionRecord(normalized)!;
  }

  patchSession(sessionKey: string, patch: Partial<Omit<StoredSessionRecord, "sessionKey" | "createdAt">>): StoredSessionRecord | null {
    const existing = this.sessions.get(sessionKey);
    if (!existing) return null;
    const next = normalizeStoredSessionRecord({
      ...existing,
      ...patch,
      sessionKey,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    });
    this.sessions.set(sessionKey, next);
    this.flushSessions();
    return cloneSessionRecord(next)!;
  }

  removeSession(sessionKey: string): void {
    if (!this.sessions.delete(sessionKey)) return;
    this.flushSessions();
  }

  mergeImportedSessions(sessions: StoredSessionRecord[]): void {
    let changed = false;
    for (const session of sessions) {
      if (this.sessions.has(session.sessionKey)) continue;
      this.sessions.set(session.sessionKey, normalizeStoredSessionRecord(session));
      changed = true;
    }
    if (changed) this.flushSessions();
  }

  private flushAppState(): void {
    this.scheduleJsonWrite(this.appPath, {
      version: FILE_STATE_VERSION,
      values: Object.fromEntries([...this.appState.entries()].sort(([left], [right]) => left.localeCompare(right))),
    } satisfies AppStateFile);
  }

  private flushWorkspaces(): void {
    this.scheduleJsonWrite(this.workspacesPath, {
      version: FILE_STATE_VERSION,
      workspaces: [...this.workspaces.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    } satisfies WorkspacesFile);
  }

  private flushSessions(): void {
    this.scheduleJsonWrite(this.sessionsPath, {
      version: FILE_STATE_VERSION,
      sessions: [...this.sessions.values()].sort((left, right) => left.sessionKey.localeCompare(right.sessionKey)),
    } satisfies SessionsFile);
  }

  async flush(): Promise<void> {
    for (;;) {
      await Promise.resolve();
      const active = [...this.flushStateByPath.values()].map((state) => state.draining).filter((entry): entry is Promise<void> => entry != null);
      if (active.length > 0) {
        await Promise.all(active);
        continue;
      }

      this.throwPendingFlushErrors();
      let started = false;
      for (const [filePath, state] of this.flushStateByPath.entries()) {
        if (state.scheduled || state.draining || state.pendingJson === undefined) continue;
        this.startDrainWhenReady(filePath, state);
        started = true;
      }
      if (!started && [...this.flushStateByPath.values()].every((state) => !state.scheduled && state.pendingJson === undefined)) {
        this.throwPendingFlushErrors();
        return;
      }
    }
  }

  private scheduleJsonWrite(filePath: string, value: unknown): void {
    const state = this.getOrCreateFlushState(filePath);
    state.pendingJson = `${JSON.stringify(value, null, 2)}\n`;
    state.error = null;
    this.startDrainWhenReady(filePath, state);
  }

  private startDrainWhenReady(filePath: string, state: PendingFlushState): void {
    if (state.scheduled || state.draining) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      if (state.draining) return;
      state.draining = this.drainJsonWrites(filePath, state)
        .catch((error) => {
          state.error = error;
        })
        .finally(() => {
          state.draining = null;
          if (state.pendingJson !== undefined && !state.scheduled && state.error == null) {
            this.startDrainWhenReady(filePath, state);
          }
        });
    });
  }

  private getOrCreateFlushState(filePath: string): PendingFlushState {
    let state = this.flushStateByPath.get(filePath);
    if (state) return state;
    state = {
      pendingJson: undefined,
      scheduled: false,
      draining: null,
      error: null,
    };
    this.flushStateByPath.set(filePath, state);
    return state;
  }

  private async drainJsonWrites(filePath: string, state: PendingFlushState): Promise<void> {
    for (;;) {
      const nextJson = state.pendingJson;
      if (nextJson === undefined) {
        return;
      }
      state.pendingJson = undefined;
      try {
        await writeJsonFile(filePath, nextJson);
      } catch (error) {
        if (state.pendingJson === undefined) {
          state.pendingJson = nextJson;
        }
        throw error;
      }
    }
  }

  private throwPendingFlushErrors(): void {
    for (const state of this.flushStateByPath.values()) {
      if (state.error == null) continue;
      const error = state.error;
      state.error = null;
      throw error;
    }
  }
}

interface PendingFlushState {
  pendingJson: string | undefined;
  scheduled: boolean;
  draining: Promise<void> | null;
  error: unknown | null;
}

function loadAppStateFile(filePath: string): AppStateFile {
  try {
    const parsed = readJsonFile(filePath);
    if (!parsed) {
      return {
        version: FILE_STATE_VERSION,
        values: {},
      };
    }
    if (!isRecord(parsed) || !isRecord(parsed.values)) {
      throw new Error(`Invalid app state file: ${filePath}`);
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.values)) {
      if (typeof value === "string") values[key] = value;
    }
    return {
      version: FILE_STATE_VERSION,
      values,
    };
  } catch (error) {
    recoverCorruptStateFile(filePath, error);
    return {
      version: FILE_STATE_VERSION,
      values: {},
    };
  }
}

function loadWorkspacesFile(filePath: string, legacyProjectsPath: string): WorkspacesFile {
  try {
    const parsed = readJsonFile(filePath);
    if (parsed) {
      if (!isRecord(parsed) || !Array.isArray(parsed.workspaces)) {
        throw new Error(`Invalid workspaces state file: ${filePath}`);
      }
      return {
        version: FILE_STATE_VERSION,
        workspaces: parsed.workspaces.map((workspace) => normalizeStoredWorkspaceBinding(workspace)),
      };
    }
  } catch (error) {
    recoverCorruptStateFile(filePath, error);
  }

  try {
    const parsed = readJsonFile(legacyProjectsPath);
    if (!parsed) {
      return {
        version: FILE_STATE_VERSION,
        workspaces: [],
      };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
      throw new Error(`Invalid legacy projects state file: ${legacyProjectsPath}`);
    }
    return {
      version: FILE_STATE_VERSION,
      workspaces: parsed.projects.map((workspace) => normalizeStoredWorkspaceBinding(workspace)),
    };
  } catch (error) {
    recoverCorruptStateFile(legacyProjectsPath, error);
    return {
      version: FILE_STATE_VERSION,
      workspaces: [],
    };
  }
}

function loadSessionsFile(filePath: string): SessionsFile {
  try {
    const parsed = readJsonFile(filePath);
    if (!parsed) {
      return {
        version: FILE_STATE_VERSION,
        sessions: [],
      };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.sessions)) {
      throw new Error(`Invalid sessions state file: ${filePath}`);
    }
    return {
      version: FILE_STATE_VERSION,
      sessions: parsed.sessions.map((session) => normalizeStoredSessionRecord(session)),
    };
  } catch (error) {
    recoverCorruptStateFile(filePath, error);
    return {
      version: FILE_STATE_VERSION,
      sessions: [],
    };
  }
}

function normalizeStoredWorkspaceBinding(value: unknown): StoredWorkspaceBinding {
  if (!isRecord(value)) {
    throw new Error("Invalid stored workspace binding");
  }
  const workingRootInput =
    typeof value.workingRoot === "string"
      ? value.workingRoot
      : typeof value.cwd === "string"
        ? value.cwd
        : null;
  if (typeof value.chatId !== "string" || workingRootInput == null) {
    throw new Error("Stored workspace binding is missing required fields");
  }
  const workingRoot = path.resolve(workingRootInput);
  const now = new Date().toISOString();
  return {
    chatId: value.chatId,
    workingRoot,
    name: typeof value.name === "string" && value.name.trim() ? value.name : path.basename(workingRoot) || workingRoot,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

function normalizeStoredSessionRecord(value: unknown): StoredSessionRecord {
  if (!isRecord(value)) {
    throw new Error("Invalid stored session");
  }
  if (
    typeof value.sessionKey !== "string" ||
    typeof value.chatId !== "string" ||
    typeof value.model !== "string"
  ) {
    throw new Error("Stored session is missing required fields");
  }

  const now = new Date().toISOString();
  return {
    sessionKey: value.sessionKey,
    chatId: value.chatId,
    messageThreadId: typeof value.messageThreadId === "string" ? value.messageThreadId : null,
    telegramTopicName: typeof value.telegramTopicName === "string" ? value.telegramTopicName : null,
    codexThreadId: typeof value.codexThreadId === "string" ? value.codexThreadId : null,
    model: value.model.trim() || "gpt-5.4",
    sandboxMode: normalizeSandboxMode(value.sandboxMode),
    approvalPolicy: normalizeApprovalPolicy(value.approvalPolicy),
    reasoningEffort: normalizeReasoningEffort(value.reasoningEffort),
    webSearchMode: normalizeWebSearchMode(value.webSearchMode),
    networkAccessEnabled: normalizeBoolean(value.networkAccessEnabled, true),
    skipGitRepoCheck: normalizeBoolean(value.skipGitRepoCheck, true),
    additionalDirectories: normalizeStringArray(value.additionalDirectories),
    outputSchema: normalizeOutputSchema(value.outputSchema),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  };
}

async function writeJsonFile(filePath: string, value: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, value, {
    encoding: "utf8",
  });
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function recoverCorruptStateFile(filePath: string, error: unknown): void {
  if (isMissingFileError(error) || !existsSync(filePath)) return;
  const recoveredPath = `${filePath}.corrupt-${Date.now()}`;
  try {
    renameSync(filePath, recoveredPath);
  } catch {
    // Keep startup resilient even if the corrupt file cannot be moved.
  }
}

function cloneWorkspaceBinding(workspace: StoredWorkspaceBinding | null): StoredWorkspaceBinding | null {
  return workspace ? { ...workspace } : null;
}

function cloneSessionRecord(session: StoredSessionRecord | null): StoredSessionRecord | null {
  return session
    ? {
        ...session,
        additionalDirectories: [...session.additionalDirectories],
      }
    : null;
}

function normalizeSandboxMode(value: unknown): SessionSandboxMode {
  return typeof value === "string" && isSessionSandboxMode(value) ? value : DEFAULT_SESSION_PROFILE.sandboxMode;
}

function normalizeApprovalPolicy(value: unknown): SessionApprovalPolicy {
  return typeof value === "string" && isSessionApprovalPolicy(value) ? value : DEFAULT_SESSION_PROFILE.approvalPolicy;
}

function normalizeReasoningEffort(value: unknown): SessionReasoningEffort | null {
  return typeof value === "string" && isSessionReasoningEffort(value) ? value : null;
}

function normalizeWebSearchMode(value: unknown): SessionWebSearchMode | null {
  return typeof value === "string" && isSessionWebSearchMode(value) ? value : null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") return Number(value) !== 0;
  return fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function normalizeOutputSchema(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? JSON.stringify(parsed) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
