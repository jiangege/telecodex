import { createReadStream, existsSync, opendirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Logger } from "../runtime/logger.js";

export interface CodexThreadSummary {
  id: string;
  cwd: string;
  createdAt: string | null;
  updatedAt: string;
  preview: string;
  source: string | null;
  modelProvider: string | null;
  sessionPath: string;
}

export interface CodexThreadCatalog {
  listProjectThreads(input: { projectRoot: string; limit?: number }): Promise<CodexThreadSummary[]>;
  findProjectThreadById(input: { projectRoot: string; threadId: string }): Promise<CodexThreadSummary | null>;
}

interface SessionMetaPayload {
  id: string;
  cwd: string;
  timestamp?: string;
  source?: string;
  model_provider?: string;
}

export class CodexSessionCatalog implements CodexThreadCatalog {
  private readonly sessionsRoot: string;
  private readonly cacheTtlMs: number;
  private readonly index = new Map<string, CachedSessionSummary>();
  private sortedPaths: string[] = [];
  private readonly pathByThreadId = new Map<string, string>();
  private refreshPromise: Promise<void> | null = null;
  private lastRefreshedAt = 0;

  constructor(input?: { sessionsRoot?: string; logger?: Logger; cacheTtlMs?: number }) {
    this.sessionsRoot = input?.sessionsRoot ?? defaultSessionsRoot();
    this.logger = input?.logger;
    this.cacheTtlMs = Math.max(0, input?.cacheTtlMs ?? 5_000);
  }

  private readonly logger: Logger | undefined;

  async listProjectThreads(input: { projectRoot: string; limit?: number }): Promise<CodexThreadSummary[]> {
    await this.ensureIndexFresh();
    const projectRoot = canonicalizePath(input.projectRoot);
    const limit = Math.max(1, input.limit ?? 8);
    const matches: CodexThreadSummary[] = [];

    for (const filePath of this.sortedPaths) {
      const summary = this.index.get(filePath)?.summary ?? null;
      if (!summary) continue;
      if (!isPathWithinRoot(summary.cwd, projectRoot)) continue;
      matches.push(summary);
      if (matches.length >= limit) break;
    }

    return matches;
  }

  async findProjectThreadById(input: { projectRoot: string; threadId: string }): Promise<CodexThreadSummary | null> {
    await this.ensureIndexFresh();
    const projectRoot = canonicalizePath(input.projectRoot);
    const threadId = input.threadId.trim();
    if (!threadId) return null;

    const filePath = this.pathByThreadId.get(threadId);
    const summary = filePath ? this.index.get(filePath)?.summary ?? null : null;
    if (summary) {
      if (!isPathWithinRoot(summary.cwd, projectRoot)) return null;
      return summary;
    }

    this.logger?.debug("codex thread not found in saved sessions", {
      projectRoot,
      threadId,
      sessionsRoot: this.sessionsRoot,
    });
    return null;
  }

  private async ensureIndexFresh(): Promise<void> {
    if (this.refreshPromise) {
      await this.refreshPromise;
    } else {
      const now = Date.now();
      if (now - this.lastRefreshedAt >= this.cacheTtlMs || this.sortedPaths.length === 0) {
        this.refreshPromise = this.refreshIndex().finally(() => {
          this.lastRefreshedAt = Date.now();
          this.refreshPromise = null;
        });
        await this.refreshPromise;
      }
    }
  }

  private async refreshIndex(): Promise<void> {
    const files = listSessionFiles(this.sessionsRoot).filter((entry) => entry.mtimeMs > 0);
    const seenPaths = new Set(files.map((entry) => entry.path));

    for (const existingPath of this.index.keys()) {
      if (!seenPaths.has(existingPath)) {
        this.index.delete(existingPath);
      }
    }

    for (const file of files) {
      const cached = this.index.get(file.path);
      if (cached && cached.mtimeMs === file.mtimeMs) {
        if (cached.updatedAt !== file.updatedAt) {
          cached.updatedAt = file.updatedAt;
        }
        continue;
      }
      this.index.set(file.path, {
        path: file.path,
        mtimeMs: file.mtimeMs,
        updatedAt: file.updatedAt,
        summary: await readSessionSummary(file.path, file.updatedAt),
      });
    }

    this.rebuildDerivedIndexes();
  }

  private rebuildDerivedIndexes(): void {
    this.sortedPaths = [...this.index.values()]
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map((entry) => entry.path);
    this.pathByThreadId.clear();
    for (const filePath of this.sortedPaths) {
      const summary = this.index.get(filePath)?.summary ?? null;
      if (!summary || this.pathByThreadId.has(summary.id)) continue;
      this.pathByThreadId.set(summary.id, filePath);
    }
  }
}

interface CachedSessionSummary {
  path: string;
  mtimeMs: number;
  updatedAt: string;
  summary: CodexThreadSummary | null;
}

function defaultSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  const root = codexHome ? path.resolve(codexHome) : path.join(homedir(), ".codex");
  return path.join(root, "sessions");
}

function listSessionFiles(root: string): Array<{ path: string; updatedAt: string; mtimeMs: number }> {
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; updatedAt: string; mtimeMs: number }> = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let directory;
    try {
      directory = opendirSync(current);
    } catch {
      continue;
    }

    for (let entry = directory.readSync(); entry != null; entry = directory.readSync()) {
      const resolved = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(resolved);
        continue;
      }
      if (!entry.isFile() || !resolved.endsWith(".jsonl")) continue;
      try {
        const stat = statSync(resolved);
        files.push({
          path: resolved,
          updatedAt: stat.mtime.toISOString(),
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        continue;
      }
    }

    directory.closeSync();
  }

  return files;
}

async function readSessionSummary(filePath: string, updatedAt: string): Promise<CodexThreadSummary | null> {
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({
    input,
    crlfDelay: Infinity,
  });

  let meta: SessionMetaPayload | null = null;
  let preview = "";

  try {
    for await (const line of reader) {
      const parsed = parseJsonLine(line);
      if (!parsed) continue;

      if (!meta) {
        meta = parseSessionMeta(parsed);
      }

      if (!preview) {
        preview = parseUserPreview(parsed);
      }

      if (meta && preview) break;
    }
  } finally {
    reader.close();
    input.destroy();
  }

  if (!meta?.id || !meta.cwd) return null;

  return {
    id: meta.id,
    cwd: canonicalizePath(meta.cwd),
    createdAt: typeof meta.timestamp === "string" ? meta.timestamp : null,
    updatedAt,
    preview: preview || "(no user message preview)",
    source: typeof meta.source === "string" ? meta.source : null,
    modelProvider: typeof meta.model_provider === "string" ? meta.model_provider : null,
    sessionPath: filePath,
  };
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseSessionMeta(parsed: Record<string, unknown>): SessionMetaPayload | null {
  if (parsed.type !== "session_meta") return null;
  const payload = isRecord(parsed.payload) ? parsed.payload : null;
  if (!payload) return null;
  if (typeof payload.id !== "string" || typeof payload.cwd !== "string") return null;
  return {
    id: payload.id,
    cwd: payload.cwd,
    ...(typeof payload.timestamp === "string" ? { timestamp: payload.timestamp } : {}),
    ...(typeof payload.source === "string" ? { source: payload.source } : {}),
    ...(typeof payload.model_provider === "string" ? { model_provider: payload.model_provider } : {}),
  };
}

function parseUserPreview(parsed: Record<string, unknown>): string {
  if (parsed.type === "event_msg") {
    const payload = isRecord(parsed.payload) ? parsed.payload : null;
    if (payload?.type === "user_message" && typeof payload.message === "string") {
      return normalizePreview(payload.message);
    }
  }

  if (parsed.type !== "response_item") return "";
  const payload = isRecord(parsed.payload) ? parsed.payload : null;
  if (!payload || payload.type !== "message" || payload.role !== "user") return "";

  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const item of content) {
    if (!isRecord(item) || item.type !== "input_text" || typeof item.text !== "string") continue;
    const preview = normalizePreview(item.text);
    if (preview) return preview;
  }
  return "";
}

function normalizePreview(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (
    normalized.startsWith("# AGENTS.md instructions") ||
    normalized.startsWith("<environment_context>") ||
    normalized.startsWith("<app-context>") ||
    normalized.startsWith("<permissions instructions>")
  ) {
    return "";
  }
  if (normalized.length <= 96) return normalized;
  return `${normalized.slice(0, 93)}...`;
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function canonicalizePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
