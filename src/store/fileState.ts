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

interface ProjectsFile {
  version: number;
  projects: StoredProjectBinding[];
}

interface SessionsFile {
  version: number;
  sessions: StoredSessionRecord[];
}

export interface StoredProjectBinding {
  chatId: string;
  name: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSessionRecord {
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
  createdAt: string;
  updatedAt: string;
}

export class FileStateStorage {
  private readonly appPath: string;
  private readonly projectsPath: string;
  private readonly sessionsPath: string;
  private readonly appState = new Map<string, string>();
  private readonly projects = new Map<string, StoredProjectBinding>();
  private readonly sessions = new Map<string, StoredSessionRecord>();
  private readonly flushStateByPath = new Map<string, PendingFlushState>();

  constructor(private readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true });
    this.appPath = path.join(rootDir, "app.json");
    this.projectsPath = path.join(rootDir, "projects.json");
    this.sessionsPath = path.join(rootDir, "sessions.json");

    for (const [key, value] of Object.entries(loadAppStateFile(this.appPath).values)) {
      this.appState.set(key, value);
    }
    for (const project of loadProjectsFile(this.projectsPath).projects) {
      this.projects.set(project.chatId, normalizeStoredProjectBinding(project));
    }
    for (const session of loadSessionsFile(this.sessionsPath).sessions) {
      this.sessions.set(session.sessionKey, normalizeStoredSessionRecord(session));
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

  getProject(chatId: string): StoredProjectBinding | null {
    return cloneProjectBinding(this.projects.get(chatId) ?? null);
  }

  upsertProject(input: { chatId: string; cwd: string; name: string; now?: string }): StoredProjectBinding {
    const existing = this.projects.get(input.chatId);
    const now = input.now ?? new Date().toISOString();
    const project: StoredProjectBinding = {
      chatId: input.chatId,
      cwd: path.resolve(input.cwd),
      name: input.name.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.projects.set(project.chatId, project);
    this.flushProjects();
    return cloneProjectBinding(project)!;
  }

  removeProject(chatId: string): void {
    if (!this.projects.delete(chatId)) return;
    this.flushProjects();
  }

  listProjects(): StoredProjectBinding[] {
    return [...this.projects.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((project) => cloneProjectBinding(project)!)
      .filter((project): project is StoredProjectBinding => project != null);
  }

  mergeImportedProjects(projects: StoredProjectBinding[]): void {
    let changed = false;
    for (const project of projects) {
      if (this.projects.has(project.chatId)) continue;
      this.projects.set(project.chatId, normalizeStoredProjectBinding(project));
      changed = true;
    }
    if (changed) this.flushProjects();
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

  private flushProjects(): void {
    this.scheduleJsonWrite(this.projectsPath, {
      version: FILE_STATE_VERSION,
      projects: [...this.projects.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    } satisfies ProjectsFile);
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

function loadProjectsFile(filePath: string): ProjectsFile {
  try {
    const parsed = readJsonFile(filePath);
    if (!parsed) {
      return {
        version: FILE_STATE_VERSION,
        projects: [],
      };
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
      throw new Error(`Invalid projects state file: ${filePath}`);
    }
    return {
      version: FILE_STATE_VERSION,
      projects: parsed.projects.map((project) => normalizeStoredProjectBinding(project)),
    };
  } catch (error) {
    recoverCorruptStateFile(filePath, error);
    return {
      version: FILE_STATE_VERSION,
      projects: [],
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

function normalizeStoredProjectBinding(value: unknown): StoredProjectBinding {
  if (!isRecord(value)) {
    throw new Error("Invalid stored project binding");
  }
  if (typeof value.chatId !== "string" || typeof value.cwd !== "string") {
    throw new Error("Stored project binding is missing required fields");
  }
  const cwd = path.resolve(value.cwd);
  const now = new Date().toISOString();
  return {
    chatId: value.chatId,
    cwd,
    name: typeof value.name === "string" && value.name.trim() ? value.name : path.basename(cwd) || cwd,
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
    typeof value.cwd !== "string" ||
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
    cwd: path.resolve(value.cwd),
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

function cloneProjectBinding(project: StoredProjectBinding | null): StoredProjectBinding | null {
  return project ? { ...project } : null;
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
