import type { Bot } from "grammy";
import type { AppConfig } from "../config.js";
import type { ApprovalManager } from "../codex/approvals.js";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { Logger } from "../runtime/logger.js";
import type { ProjectStore } from "../store/projects.js";
import type { SessionStore } from "../store/sessions.js";
import type { MessageBuffer } from "../telegram/messageBuffer.js";

export interface BotHandlerDeps {
  bot: Bot;
  approvals: ApprovalManager;
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  gateway: CodexGateway;
  buffers: MessageBuffer;
  logger?: Logger;
}
