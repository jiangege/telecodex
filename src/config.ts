import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";

export type SessionMode = "read" | "write";

export interface AppConfig {
  telegramBotToken: string;
  defaultCwd: string;
  allowedCwds: string[];
  defaultModel: string;
  dbPath: string;
  codexBin: string;
  updateIntervalMs: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseAllowedCwds(value: string | undefined, defaultCwd: string): string[] {
  const roots = (value ?? defaultCwd)
    .split(",")
    .map((entry) => path.resolve(entry.trim()))
    .filter(Boolean);
  return roots.length > 0 ? roots : [path.resolve(defaultCwd)];
}

function resolveCodexBin(): string {
  const fromEnv = process.env.CODEX_BIN?.trim();
  if (fromEnv) return fromEnv;

  const commonMacPath = "/Applications/Codex.app/Contents/Resources/codex";
  if (existsSync(commonMacPath)) return commonMacPath;

  return "codex";
}

export function loadConfig(): AppConfig {
  const defaultCwd = path.resolve(process.env.TELECODEX_DEFAULT_CWD?.trim() || process.cwd());
  const dbPath = path.resolve(process.env.TELECODEX_DB_PATH?.trim() || ".telecodex/telecodex.sqlite");

  return {
    telegramBotToken: requiredEnv("TELEGRAM_BOT_TOKEN"),
    defaultCwd,
    allowedCwds: parseAllowedCwds(process.env.TELECODEX_ALLOWED_CWDS, defaultCwd),
    defaultModel: process.env.TELECODEX_DEFAULT_MODEL?.trim() || "gpt-5.4",
    dbPath,
    codexBin: resolveCodexBin(),
    updateIntervalMs: Number(process.env.TELECODEX_UPDATE_INTERVAL_MS ?? "700"),
  };
}

export function assertAllowedCwd(cwd: string, allowedCwds: string[]): string {
  const resolved = path.resolve(cwd);
  const isAllowed = allowedCwds.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
  });
  if (!isAllowed) {
    throw new Error(`Workspace is outside TELECODEX_ALLOWED_CWDS: ${resolved}`);
  }
  return resolved;
}
