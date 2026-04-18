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
import path from "node:path";
import { buildConfig, type AppConfig } from "../config.js";
import { AdminStore, BINDING_CODE_MAX_ATTEMPTS } from "../store/adminStore.js";
import { AppStateStore } from "../store/appStateStore.js";
import { FileStateStorage } from "../store/fileState.js";
import { migrateLegacySqliteState } from "../store/legacyMigration.js";
import { ProjectStore } from "../store/projectStore.js";
import { SessionStore } from "../store/sessionStore.js";
import { getLegacyStateDbPath, getStateDir } from "./appPaths.js";
import { generateBindingCode } from "./bindingCodes.js";
import {
  PLAINTEXT_TOKEN_FALLBACK_ENV,
  SecretStore,
  type TokenStorageMode,
} from "./secrets.js";
import {
  MAC_CODEX_BIN,
  buildTelegramStartLink,
  findWorkingCodexBinary,
  listCodexBinCandidates,
  probeCodexBinary,
  readCodexLoginStatus,
  renderTerminalQrCode,
  validateTelegramBotToken,
} from "./runtimeChecks.js";

export interface BootstrapResult {
  config: AppConfig;
  sessions: SessionStore;
  projects: ProjectStore;
  admin: AdminStore;
  appState: AppStateStore;
  bootstrapCode: string | null;
  botUsername: string | null;
}

export interface RuntimePersistence {
  storage: FileStateStorage;
  sessions: SessionStore;
  projects: ProjectStore;
  admin: AdminStore;
  appState: AppStateStore;
  secrets: SecretStore;
}

export interface BootstrapBindingState {
  code: string;
  expiresAt: string;
  maxAttempts: number;
}

export interface BootstrapBindingDisplay {
  noteText: string;
  clipboardText: string;
  deepLink: string | null;
  qrCode: string | null;
  projectBindCommand: string;
}

export async function bootstrapRuntime(): Promise<BootstrapResult> {
  intro("telecodex");

  const { sessions, projects, admin, appState, secrets } = initializeRuntimePersistence();

  const codexBin = await ensureCodexBin(appState);
  await ensureCodexLogin(codexBin);

  const { token, botUsername, storageMode } = await ensureTelegramBotToken(secrets);
  if (storageMode === "plaintext-fallback") {
    note("System keychain unavailable. Telegram bot token fell back to local state storage.", "Token Storage");
  }

  const config = buildConfig({
    telegramBotToken: token,
    defaultCwd: process.cwd(),
    codexBin,
  });

  const binding = resolveBootstrapBindingState(admin);
  const bootstrapCode = binding?.code ?? null;
  if (binding) {
    await showBootstrapBindingNote({
      binding,
      botUsername,
      workspace: config.defaultCwd,
    });
  }

  return {
    config,
    sessions,
    projects,
    admin,
    appState,
    bootstrapCode,
    botUsername,
  };
}

export function initializeRuntimePersistence(input?: {
  stateDir?: string;
  allowPlaintextFallback?: boolean;
  migrateLegacyState?: boolean;
  createStateDir?: boolean;
}): RuntimePersistence {
  const stateDir = input?.stateDir ?? getStateDir();
  const storage = new FileStateStorage(stateDir, {
    createIfMissing: input?.createStateDir !== false,
  });
  if (input?.migrateLegacyState !== false) {
    migrateLegacySqliteState({
      storage,
      legacyDbPath: getLegacyStateDbPath(),
    });
  }

  const appState = new AppStateStore(storage);
  const admin = new AdminStore(storage);
  const sessions = new SessionStore(storage);
  const projects = new ProjectStore(storage);
  const secrets = new SecretStore(appState, {
    allowPlaintextFallback: input?.allowPlaintextFallback ?? process.env[PLAINTEXT_TOKEN_FALLBACK_ENV] === "1",
  });

  return {
    storage,
    sessions,
    projects,
    admin,
    appState,
    secrets,
  };
}

export function resolveBootstrapBindingState(
  admin: AdminStore,
  generateCode: () => string = () => generateBindingCode("bootstrap"),
): BootstrapBindingState | null {
  if (admin.getAuthorizedUserId() != null) {
    if (admin.getBindingCodeState()?.mode === "bootstrap") {
      admin.clearBindingCode();
    }
    return null;
  }

  let binding = admin.getBindingCodeState();
  if (!binding || binding.mode !== "bootstrap") {
    binding = admin.issueBindingCode({
      code: generateCode(),
      mode: "bootstrap",
    });
  }

  return {
    code: binding.code,
    expiresAt: binding.expiresAt,
    maxAttempts: binding.maxAttempts,
  };
}

async function ensureTelegramBotToken(
  secrets: SecretStore,
): Promise<{ token: string; botUsername: string | null; storageMode: TokenStorageMode }> {
  const existing = secrets.getTelegramBotToken();
  if (existing) {
    const validated = await validateTelegramBotToken(existing);
    if (validated.ok) {
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
    if (!validated.ok) {
      validating.stop("Telegram bot token validation failed");
      note(validated.error, "Telegram");
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

async function ensureCodexBin(appState: AppStateStore): Promise<string> {
  const detected = findWorkingCodexBinary(listCodexBinCandidates(appState.get("codex_bin")));
  if (detected) {
    appState.set("codex_bin", detected.command);
    return detected.command;
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
    const probe = probeCodexBinary(candidate);
    if (!probe.working) {
      note("That path is not an executable Codex binary.", "Codex");
      continue;
    }
    appState.set("codex_bin", probe.command);
    return probe.command;
  }
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

async function copyBootstrapCode(code: string): Promise<boolean> {
  try {
    await clipboard.write(code);
    return true;
  } catch {
    return false;
  }
}

export async function buildBootstrapBindingDisplay(input: {
  binding: BootstrapBindingState;
  botUsername: string | null;
  workspace: string;
  renderQrCode?: (content: string) => Promise<string>;
}): Promise<BootstrapBindingDisplay> {
  const projectBindCommand = `/project bind ${input.workspace}`;
  const deepLink = input.botUsername ? buildTelegramStartLink(input.botUsername, input.binding.code) : null;
  const qrCode = deepLink
    ? await (input.renderQrCode ?? renderTerminalQrCode)(deepLink)
    : null;

  const lines = [
    `Bot: ${input.botUsername ? `@${input.botUsername}` : "unknown"}`,
    `Workspace: ${input.workspace}`,
    `Binding code expires at: ${input.binding.expiresAt}`,
    `Max failed attempts: ${input.binding.maxAttempts ?? BINDING_CODE_MAX_ATTEMPTS}`,
    `Once the bot is bound, run this in your forum supergroup: ${projectBindCommand}`,
    "",
  ];

  if (deepLink) {
    lines.push(
      "Open the deep link below or scan the QR code to finish the one-time admin binding.",
      deepLink,
      "",
    );
    if (qrCode) {
      lines.push(qrCode, "");
    }
    lines.push(
      "Fallback: send this one-time code to the bot in a private chat:",
      input.binding.code,
    );
  } else {
    lines.push(
      "Open the bot in a private chat and send this one-time binding code:",
      "",
      input.binding.code,
    );
  }

  return {
    noteText: lines.join("\n"),
    clipboardText: deepLink ?? input.binding.code,
    deepLink,
    qrCode,
    projectBindCommand,
  };
}

async function showBootstrapBindingNote(input: {
  binding: BootstrapBindingState;
  botUsername: string | null;
  workspace: string;
}): Promise<void> {
  const display = await buildBootstrapBindingDisplay(input);
  const copied = await copyBootstrapCode(display.clipboardText);
  const clipboardStatus = display.deepLink
    ? copied
      ? "Binding link copied to the clipboard."
      : "Failed to copy the binding link. Copy it manually."
    : copied
      ? "Binding code copied to the clipboard."
      : "Failed to copy the binding code. Copy it manually.";

  note([clipboardStatus, "", display.noteText].join("\n"), "Admin Binding");
}

function requirePromptValue(value: string | symbol): string {
  if (isCancel(value)) exitCancelled();
  return String(value);
}

function exitCancelled(): never {
  cancel("Cancelled");
  process.exit(0);
}
