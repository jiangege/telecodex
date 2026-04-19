import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { CodexThreadCatalog } from "../codex/sessionCatalog.js";
import type { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import type { Logger } from "../runtime/logger.js";
import type { AdminStore } from "../store/adminStore.js";
import type { AppStateStore } from "../store/appStateStore.js";
import type { SessionStore } from "../store/sessionStore.js";
import type { WorkspaceStore } from "../store/workspaceStore.js";
import type { TelegramAttachmentIo } from "../telegram/attachments.js";
import type { MessageBuffer } from "../telegram/messageBuffer.js";

export interface BotHandlerDeps {
  bot: Bot;
  config: AppConfig;
  sessions: SessionStore;
  workspaces?: WorkspaceStore;
  projects?: WorkspaceStore;
  admin: AdminStore;
  appState: AppStateStore;
  codex: CodexSdkRuntime;
  threadCatalog: CodexThreadCatalog;
  buffers: MessageBuffer;
  attachmentIo?: Partial<TelegramAttachmentIo>;
  logger?: Logger;
}
