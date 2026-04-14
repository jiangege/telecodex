import { statSync } from "node:fs";
import path from "node:path";
import type { Bot, Context } from "grammy";
import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type AppConfig,
  type SessionReasoningEffort,
} from "../config.js";
import type { Logger } from "../runtime/logger.js";
import type { ProjectBinding, ProjectStore } from "../store/projects.js";
import { makeSessionKey, type SessionStore, type TelegramSession } from "../store/sessions.js";
import { sendPlainChunks } from "../telegram/delivery.js";
import { numericChatId, numericMessageThreadId, sessionFromContext } from "./session.js";
import { truncateSingleLine } from "./sessionFlow.js";

export function getProjectForContext(ctx: Context, projects: ProjectStore): ProjectBinding | null {
  const chatId = ctx.chat?.id;
  if (chatId == null || isPrivateChat(ctx)) return null;
  return projects.get(String(chatId));
}

export function getScopedSession(
  ctx: Context,
  store: SessionStore,
  projects: ProjectStore,
  config: AppConfig,
  options?: { requireTopic?: boolean },
): TelegramSession | null {
  if (isPrivateChat(ctx)) {
    void ctx.reply("私聊只用于管理员绑定和查看项目。实际工作请在项目 supergroup 的 topic 中进行。");
    return null;
  }

  const project = getProjectForContext(ctx, projects);
  if (!project) {
    void ctx.reply("当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
    return null;
  }

  const requireTopic = options?.requireTopic ?? true;
  if (requireTopic && !hasTopicContext(ctx)) {
    void ctx.reply("请在 forum topic 中使用。根聊天只负责项目级命令，具体工作放在 topic 里。");
    return null;
  }

  const session = sessionFromContext(ctx, store, config);
  if (!isPathWithinRoot(session.cwd, project.cwd)) {
    store.setCwd(session.sessionKey, project.cwd);
    return store.get(session.sessionKey) ?? session;
  }
  return session;
}

export function formatHelpText(ctx: Context, projects: ProjectStore): string {
  if (isPrivateChat(ctx)) {
    return [
      "telecodex 已启动。",
      "",
      "主工作流：",
      "1. 一个 forum supergroup = 一个项目",
      "2. 一个 topic = 一个 Codex thread",
      "3. 在 topic 里直接发送普通消息",
      "",
      "先在项目群里执行：",
      "/project bind <绝对路径>",
      "",
      "然后在群里管理 threads：",
      "/thread new <topic 名称>",
      "/thread resume <threadId>",
      "",
      "topic 内直接发消息：",
      "/status",
      "/queue",
      "/queue drop <id>",
      "/queue clear",
      "/stop",
      "",
      formatPrivateProjectSummary(projects),
    ].join("\n");
  }

  const project = getProjectForContext(ctx, projects);
  if (!project) {
    return [
      "这个 supergroup 还没有绑定项目。",
      "",
      "先执行：",
      "/project bind <绝对路径>",
      "",
      "绑定后，每个 topic 都会作为一个独立的 Codex thread。",
    ].join("\n");
  }

  return [
    "telecodex 已启动。",
    "",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "",
    "/project 查看项目绑定",
    "/project bind <绝对路径> 更新项目根目录",
    "/thread new <topic 名称> 自动创建一个新 topic；首条消息时创建新的 thread",
    "/thread resume <threadId> 自动创建 topic 并绑定到已有 thread",
    "topic 内直接发送普通消息给当前 thread",
    "/status 查看当前 topic 状态、最近 SDK 事件和队列",
    "/queue 查看当前 topic 的排队消息",
    "/queue drop <id> 删除一条排队消息",
    "/queue clear 清空当前 topic 队列",
    "/stop 中断当前 SDK run",
    "/cwd <path> 在项目根目录内切换工作子目录",
    `/mode ${MODE_PRESETS.join("|")}`,
    `/sandbox ${SANDBOX_MODES.join("|")}`,
    `/approval ${APPROVAL_POLICIES.join("|")}`,
    "/yolo on|off",
    "/model <id>",
    `/effort default|${REASONING_EFFORTS.join("|")}`,
  ].join("\n");
}

export function formatPrivateStatus(store: SessionStore, projects: ProjectStore): string {
  return [
    "telecodex 管理入口",
    `authorized telegram user id: ${store.getAuthorizedUserId() ?? "未绑定"}`,
    "",
    formatPrivateProjectSummary(projects),
  ].join("\n");
}

export function formatPrivateProjectSummary(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "当前还没有绑定任何项目 supergroup。";
  }
  return `已绑定项目群: ${bound.length}`;
}

export function formatPrivateProjectList(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "当前还没有绑定任何项目 supergroup。";
  }
  return [
    "已绑定项目：",
    ...bound.map((project, index) => `${index + 1}. ${project.name}\n   root: ${project.cwd}\n   chat: ${project.chatId}`),
  ].join("\n");
}

export function formatProjectStatus(project: ProjectBinding): string {
  return [
    "项目状态",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "这个 supergroup 代表一个项目；用 /thread new 或 /thread resume 自动创建 topic。",
  ].join("\n");
}

export function ensureTopicSession(input: {
  store: SessionStore;
  config: AppConfig;
  project: ProjectBinding;
  chatId: number;
  messageThreadId: number;
  topicName?: string | null;
  threadId?: string | null;
}): TelegramSession {
  const sessionKey = makeSessionKey(input.chatId, input.messageThreadId);
  const session = input.store.getOrCreate({
    sessionKey,
    chatId: String(input.chatId),
    messageThreadId: String(input.messageThreadId),
    telegramTopicName: input.topicName ?? null,
    defaultCwd: input.project.cwd,
    defaultModel: input.config.defaultModel,
  });
  if (input.topicName && session.telegramTopicName !== input.topicName) {
    input.store.setTelegramTopicName(session.sessionKey, input.topicName);
  }
  if (input.threadId && session.codexThreadId !== input.threadId) {
    input.store.bindThread(session.sessionKey, input.threadId);
  }
  if (!isPathWithinRoot(session.cwd, input.project.cwd)) {
    input.store.setCwd(session.sessionKey, input.project.cwd);
    return input.store.get(session.sessionKey) ?? session;
  }
  return input.store.get(session.sessionKey) ?? session;
}

export async function postTopicReadyMessage(bot: Bot, session: TelegramSession, text: string, logger?: Logger): Promise<void> {
  await sendPlainChunks(
    bot,
    {
      chatId: numericChatId(session),
      messageThreadId: numericMessageThreadId(session),
      text,
    },
    logger,
  );
}

export function parseSubcommand(input: string): { command: string | null; args: string } {
  const trimmed = input.trim();
  if (!trimmed) return { command: null, args: "" };
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace < 0) {
    return {
      command: trimmed.toLowerCase(),
      args: "",
    };
  }
  return {
    command: trimmed.slice(0, firstSpace).toLowerCase(),
    args: trimmed.slice(firstSpace + 1).trim(),
  };
}

export function formatTopicName(rawName: string | null | undefined, fallback: string): string {
  const normalized = rawName?.trim() || fallback;
  return truncateSingleLine(normalized, 128);
}

export function resolveExistingDirectory(input: string): string {
  const resolved = path.resolve(input.trim());
  if (!resolved) {
    throw new Error("项目路径不能为空。");
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`目录不存在: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`不是目录: ${resolved}`);
  }

  return resolved;
}

export function assertProjectScopedPath(input: string, projectRoot: string): string {
  const resolved = path.resolve(input.trim());
  if (!isPathWithinRoot(resolved, projectRoot)) {
    throw new Error(["路径必须位于项目根目录内。", `project root: ${projectRoot}`, `input: ${resolved}`].join("\n"));
  }
  return resolved;
}

export function formatProfileReply(prefix: string, sandboxMode: string, approvalPolicy: string): string {
  return [prefix, `sandbox: ${sandboxMode}`, `approval: ${approvalPolicy}`].join("\n");
}

export function formatReasoningEffort(value: SessionReasoningEffort | null): string {
  return value ?? "codex-default";
}

export function contextLogFields(ctx: Context): Record<string, string | number | null> {
  return {
    chatId: ctx.chat?.id ?? null,
    chatType: ctx.chat?.type ?? null,
    messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
    fromId: ctx.from?.id ?? null,
    updateId: ctx.update.update_id,
  };
}

export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

export function isSupergroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "supergroup";
}

export function hasTopicContext(ctx: Context): boolean {
  return ctx.message?.message_thread_id != null || ctx.callbackQuery?.message?.message_thread_id != null;
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}
