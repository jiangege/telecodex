import {
  cancel,
  confirm,
  intro,
  isCancel,
  note,
  password,
  spinner,
  text,
} from "@clack/prompts";
import clipboard from "clipboardy";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Bot, GrammyError, HttpError } from "grammy";
import { buildConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../store/db.js";
import { ProjectStore } from "../store/projects.js";
import { BINDING_CODE_MAX_ATTEMPTS, SessionStore } from "../store/sessions.js";
import { getStateDbPath } from "./appPaths.js";
import { generateBindingCode } from "./bindingCodes.js";
import {
  PLAINTEXT_TOKEN_FALLBACK_ENV,
  SecretStore,
  type TokenStorageMode,
} from "./secrets.js";

const MAC_CODEX_BIN = "/Applications/Codex.app/Contents/Resources/codex";

export interface BootstrapResult {
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  bootstrapCode: string | null;
  botUsername: string | null;
}

export async function bootstrapRuntime(): Promise<BootstrapResult> {
  intro("telecodex");

  const dbPath = getStateDbPath();
  const db = openDatabase(dbPath);
  const store = new SessionStore(db);
  const projects = new ProjectStore(db);
  const secrets = new SecretStore(store, {
    allowPlaintextFallback: process.env[PLAINTEXT_TOKEN_FALLBACK_ENV] === "1",
  });

  const codexBin = await ensureCodexBin(store);
  await ensureCodexLogin(codexBin);

  const { token, botUsername, storageMode } = await ensureTelegramBotToken(secrets);
  if (storageMode === "plaintext-fallback") {
    note("System keychain unavailable. Telegram bot token fell back to local state storage.", "Token Storage");
  }

  const config = buildConfig({
    telegramBotToken: token,
    defaultCwd: process.cwd(),
    dbPath,
    codexBin,
  });

  let bootstrapCode: string | null = null;
  if (store.getAuthorizedUserId() == null) {
    let binding = store.getBindingCodeState();
    if (!binding || binding.mode !== "bootstrap") {
      binding = store.issueBindingCode({
        code: generateBindingCode("bootstrap"),
        mode: "bootstrap",
      });
    }
    bootstrapCode = binding.code;
  } else if (store.getBindingCodeState()?.mode === "bootstrap") {
    store.clearBindingCode();
  }
  if (bootstrapCode) {
    const binding = store.getBindingCodeState();
    const copied = await copyBootstrapCode(bootstrapCode);
    note(
      [
        `Bot: ${botUsername ? `@${botUsername}` : "unknown"}`,
        `Workspace: ${config.defaultCwd}`,
        copied ? "Binding code copied to the clipboard." : "Failed to copy the binding code. Copy it manually.",
        `Binding code expires at: ${binding?.expiresAt ?? "unknown"}`,
        `Max failed attempts: ${binding?.maxAttempts ?? BINDING_CODE_MAX_ATTEMPTS}`,
        "",
        bootstrapCode,
      ].join("\n"),
      "Admin Binding",
    );
  }

  return {
    config,
    store,
    projects,
    bootstrapCode,
    botUsername,
  };
}

async function ensureTelegramBotToken(
  secrets: SecretStore,
): Promise<{ token: string; botUsername: string | null; storageMode: TokenStorageMode }> {
  const existing = secrets.getTelegramBotToken();
  if (existing) {
    const validated = await validateTelegramBotToken(existing);
    if (validated) {
      return {
        token: existing,
        botUsername: validated.username,
        storageMode: "existing",
      };
    }
    note("The saved Telegram bot token failed validation. Enter it again.", "Telegram");
  }

  while (true) {
    const raw = await password({
      message: "Paste Telegram bot token",
      mask: "*",
    });
    const token = requirePromptValue(raw).trim();
    if (!token) {
      note("Bot token cannot be empty.", "Telegram");
      continue;
    }

    const validating = spinner();
    validating.start("Validating Telegram bot token");
    const validated = await validateTelegramBotToken(token);
    if (!validated) {
      validating.stop("Telegram bot token validation failed");
      continue;
    }

    const storageMode = secrets.setTelegramBotToken(token);
    validating.stop(`Telegram bot verified: @${validated.username ?? "unknown"}`);
    return {
      token,
      botUsername: validated.username,
      storageMode,
    };
  }
}

async function validateTelegramBotToken(token: string): Promise<{ username: string | null } | null> {
  try {
    const bot = new Bot(token);
    const me = await bot.api.getMe();
    return { username: me.username ?? null };
  } catch (error) {
    if (error instanceof GrammyError) {
      note(`Telegram returned an error: ${error.description}`, "Telegram");
      return null;
    }
    if (error instanceof HttpError) {
      note(`Unable to reach Telegram: ${error.message}`, "Telegram");
      return null;
    }
    note(error instanceof Error ? error.message : String(error), "Telegram");
    return null;
  }
}

async function ensureCodexBin(store: SessionStore): Promise<string> {
  const saved = store.getAppState("codex_bin");
  for (const candidate of [saved, MAC_CODEX_BIN, "codex"]) {
    if (!candidate) continue;
    if (isWorkingCodexBin(candidate)) {
      store.setAppState("codex_bin", candidate);
      return candidate;
    }
  }

  note("Could not automatically find a working Codex binary.", "Codex");
  while (true) {
    const raw = await text({
      message: "Path to codex binary",
      placeholder: MAC_CODEX_BIN,
    });
    const candidate = path.resolve(requirePromptValue(raw).trim());
    if (!candidate) {
      note("Codex path cannot be empty.", "Codex");
      continue;
    }
    if (!isWorkingCodexBin(candidate)) {
      note("That path is not an executable Codex binary.", "Codex");
      continue;
    }
    store.setAppState("codex_bin", candidate);
    return candidate;
  }
}

function isWorkingCodexBin(candidate: string): boolean {
  if (candidate !== "codex" && !existsSync(candidate)) return false;
  const result = spawnSync(candidate, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return !result.error && result.status === 0;
}

async function ensureCodexLogin(codexBin: string): Promise<void> {
  while (true) {
    const status = readCodexLoginStatus(codexBin);
    if (status.loggedIn) return;

    note(status.message || "Codex is not logged in.", "Codex Login");
    const shouldLogin = await confirm({
      message: "Run `codex login` now?",
      initialValue: true,
    });
    if (isCancel(shouldLogin)) exitCancelled();
    if (!shouldLogin) {
      throw new Error("Codex login is required before starting telecodex.");
    }

    const result = spawnSync(codexBin, ["login"], {
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`Failed to run codex login: ${result.error.message}`);
    }
  }
}

function readCodexLoginStatus(codexBin: string): { loggedIn: boolean; message: string } {
  const result = spawnSync(codexBin, ["login", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const message = [result.stdout, result.stderr].map((value) => value.trim()).filter(Boolean).join(" | ");
  return {
    loggedIn: result.status === 0 && /logged in/i.test(message),
    message,
  };
}

async function copyBootstrapCode(code: string): Promise<boolean> {
  try {
    await clipboard.write(code);
    return true;
  } catch {
    return false;
  }
}

function requirePromptValue(value: string | symbol): string {
  if (isCancel(value)) exitCancelled();
  return String(value);
}

function exitCancelled(): never {
  cancel("Cancelled");
  process.exit(0);
}
