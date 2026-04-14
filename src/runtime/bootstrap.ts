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
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { Bot, GrammyError, HttpError } from "grammy";
import { buildConfig, type AppConfig } from "../config.js";
import { openDatabase } from "../store/db.js";
import { ProjectStore } from "../store/projects.js";
import { SessionStore } from "../store/sessions.js";
import { getStateDbPath } from "./appPaths.js";
import { SecretStore, type TokenStorageMode } from "./secrets.js";

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
  const secrets = new SecretStore(store);

  const codexBin = await ensureCodexBin(store);
  await ensureCodexLogin(codexBin);

  const { token, botUsername, storageMode } = await ensureTelegramBotToken(secrets);
  if (storageMode === "plaintext-fallback") {
    note("系统 keychain 不可用。Telegram bot token 已回退保存到本地状态库。", "Token Storage");
  }

  const config = buildConfig({
    telegramBotToken: token,
    defaultCwd: process.cwd(),
    dbPath,
    codexBin,
  });

  let bootstrapCode: string | null = null;
  if (store.getAuthorizedUserId() == null) {
    bootstrapCode = store.getBootstrapCode();
    if (!bootstrapCode) {
      bootstrapCode = generateBootstrapCode();
      store.setBootstrapCode(bootstrapCode);
    }
  }
  if (bootstrapCode) {
    const copied = await copyBootstrapCode(bootstrapCode);
    note(
      [
        `Bot: ${botUsername ? `@${botUsername}` : "unknown"}`,
        `Workspace: ${config.defaultCwd}`,
        copied ? "绑定码已复制到剪贴板。" : "绑定码复制失败，请手动复制。",
        "该绑定码会一直有效，直到有管理员成功绑定。",
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
    note("已保存的 Telegram bot token 无法通过校验，请重新输入。", "Telegram");
  }

  while (true) {
    const raw = await password({
      message: "Paste Telegram bot token",
      mask: "*",
    });
    const token = requirePromptValue(raw).trim();
    if (!token) {
      note("Bot token 不能为空。", "Telegram");
      continue;
    }

    const validating = spinner();
    validating.start("正在验证 Telegram bot token");
    const validated = await validateTelegramBotToken(token);
    if (!validated) {
      validating.stop("Telegram bot token 验证失败");
      continue;
    }

    const storageMode = secrets.setTelegramBotToken(token);
    validating.stop(`Telegram bot 已验证: @${validated.username ?? "unknown"}`);
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
      note(`Telegram 返回错误: ${error.description}`, "Telegram");
      return null;
    }
    if (error instanceof HttpError) {
      note(`无法连接 Telegram: ${error.message}`, "Telegram");
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

  note("未能自动找到可用的 Codex 可执行文件。", "Codex");
  while (true) {
    const raw = await text({
      message: "Path to codex binary",
      placeholder: MAC_CODEX_BIN,
    });
    const candidate = path.resolve(requirePromptValue(raw).trim());
    if (!candidate) {
      note("Codex 路径不能为空。", "Codex");
      continue;
    }
    if (!isWorkingCodexBin(candidate)) {
      note("该路径不是可执行的 Codex 二进制。", "Codex");
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

    note(status.message || "Codex 尚未登录。", "Codex Login");
    const shouldLogin = await confirm({
      message: "现在运行 `codex login` 吗？",
      initialValue: true,
    });
    if (isCancel(shouldLogin)) exitCancelled();
    if (!shouldLogin) {
      throw new Error("Codex 登录是启动 telecodex 的前置条件。");
    }

    const result = spawnSync(codexBin, ["login"], {
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`运行 codex login 失败: ${result.error.message}`);
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

function generateBootstrapCode(): string {
  return `bind-${randomBytes(6).toString("base64url")}`;
}
