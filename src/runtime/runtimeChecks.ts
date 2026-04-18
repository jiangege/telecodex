import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Bot, GrammyError, HttpError } from "grammy";
import * as qrcodeTerminal from "qrcode-terminal";

export const MAC_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";

export interface CodexBinaryProbe {
  command: string;
  working: boolean;
  version: string | null;
  message: string;
}

export type TelegramTokenValidation =
  | {
      ok: true;
      username: string | null;
    }
  | {
      ok: false;
      error: string;
    };

export function listCodexBinCandidates(savedCandidate: string | null): string[] {
  const candidates = [savedCandidate, MAC_CODEX_BIN, "codex"];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    unique.add(resolveCodexCommand(candidate));
  }
  return [...unique];
}

export function findWorkingCodexBinary(candidates: string[]): CodexBinaryProbe | null {
  for (const candidate of candidates) {
    const probe = probeCodexBinary(candidate);
    if (probe.working) {
      return probe;
    }
  }
  return null;
}

export function probeCodexBinary(candidate: string): CodexBinaryProbe {
  const command = resolveCodexCommand(candidate);
  if (command !== "codex" && !existsSync(command)) {
    return {
      command,
      working: false,
      version: null,
      message: "not found",
    };
  }

  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" | ");

  if (result.error) {
    return {
      command,
      working: false,
      version: null,
      message: result.error.message,
    };
  }

  if (result.status !== 0) {
    return {
      command,
      working: false,
      version: null,
      message: output || `exited with status ${result.status}`,
    };
  }

  return {
    command,
    working: true,
    version: firstLine(output),
    message: firstLine(output) ?? "ok",
  };
}

export function readCodexLoginStatus(codexBin: string): { loggedIn: boolean; message: string } {
  const result = spawnSync(codexBin, ["login", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const message = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join(" | ");
  return {
    loggedIn: result.status === 0 && /logged in/i.test(message),
    message,
  };
}

export async function validateTelegramBotToken(token: string): Promise<TelegramTokenValidation> {
  try {
    const bot = new Bot(token);
    const me = await bot.api.getMe();
    return {
      ok: true,
      username: me.username ?? null,
    };
  } catch (error) {
    if (error instanceof GrammyError) {
      return {
        ok: false,
        error: `Telegram returned an error: ${error.description}`,
      };
    }
    if (error instanceof HttpError) {
      return {
        ok: false,
        error: `Unable to reach Telegram: ${error.message}`,
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildTelegramStartLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=${code}`;
}

export async function renderTerminalQrCode(content: string): Promise<string> {
  return await new Promise((resolve) => {
    qrcodeTerminal.generate(content, { small: true }, (value) => {
      resolve(value.trimEnd());
    });
  });
}

function resolveCodexCommand(candidate: string): string {
  return candidate === "codex" ? candidate : path.resolve(candidate);
}

function firstLine(value: string): string | null {
  if (!value) return null;
  return value.split(/\r?\n/u)[0]?.trim() || null;
}
