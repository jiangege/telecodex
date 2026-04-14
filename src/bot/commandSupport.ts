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
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { Thread } from "../generated/codex-app-server/v2/Thread.js";
import type { ProjectBinding, ProjectStore } from "../store/projects.js";
import { makeSessionKey, type SessionStore, type TelegramSession } from "../store/sessions.js";
import { sendPlainChunks } from "../telegram/delivery.js";
import { escapeHtml } from "../telegram/renderer.js";
import { formatSessionRuntimeStatus } from "../runtime/sessionRuntime.js";
import type { Logger } from "../runtime/logger.js";
import { truncateSingleLine } from "./sessionFlow.js";
import { numericChatId, numericMessageThreadId, sessionFromContext } from "./session.js";

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
      "",
      "先在项目群里执行：",
      "/project bind <绝对路径>",
      "",
      "然后在群里管理 threads：",
      "/thread list [关键词]",
      "/thread resume <threadId>",
      "/thread new <topic 名称>",
      "/threads",
      "/resume <threadId>",
      "/newthread <topic 名称>",
      "",
      "topic 内直接聊天：",
      "/ask <内容>",
      "/status",
      "/queue",
      "/queue drop <id>",
      "/queue clear",
      "/tty",
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
    "/thread list [关键词] 列出当前项目下可恢复的历史 threads",
    "/thread resume <threadId> 自动创建 topic 并绑定到已有 thread",
    "/thread new <topic 名称> 自动创建一个新 topic；首条消息时创建新的 thread",
    "/threads 等价于 /thread list",
    "/resume <threadId> 等价于 /thread resume <threadId>",
    "/newthread <topic 名称> 等价于 /thread new <topic 名称>",
    "/ask <内容> 通过命令发送一条消息给当前 thread",
    "/status 查看当前 topic 状态",
    "/queue 查看当前 topic 的排队消息",
    "/queue drop <id> 删除一条排队消息",
    "/queue clear 清空当前 topic 队列",
    "/tty 查看或控制当前等待输入的终端进程",
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
  const deliveries = store.getTurnDeliveryStats();
  return [
    "telecodex 管理入口",
    `authorized telegram user id: ${store.getAuthorizedUserId() ?? "未绑定"}`,
    `deliveries: ${formatTurnDeliveryStats(deliveries)}`,
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

export function formatTurnDeliveryStats(
  stats: { pending: number; delivering: number; delivered: number; failed: number } | null,
): string {
  if (!stats) return "无";
  return `pending ${stats.pending} / delivering ${stats.delivering} / failed ${stats.failed} / delivered ${stats.delivered}`;
}

export async function listProjectThreads(
  gateway: CodexGateway,
  project: ProjectBinding,
  searchTerm: string,
): Promise<Thread[]> {
  const results: Thread[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 4 && results.length < 8; page += 1) {
    const response = await gateway.listThreads({
      cursor,
      limit: 30,
      searchTerm,
      archived: false,
    });
    for (const thread of response.data) {
      if (!isPathWithinRoot(thread.cwd, project.cwd)) continue;
      results.push(thread);
      if (results.length >= 8) break;
    }
    if (!response.nextCursor) break;
    cursor = response.nextCursor;
  }

  return results;
}

export function ensureTopicSession(input: {
  store: SessionStore;
  config: AppConfig;
  project: ProjectBinding;
  chatId: number;
  messageThreadId: number;
  topicName?: string | null;
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
  if (!isPathWithinRoot(session.cwd, input.project.cwd)) {
    input.store.setCwd(session.sessionKey, input.project.cwd);
    return input.store.get(session.sessionKey) ?? session;
  }
  return session;
}

export async function postTopicReadyMessage(bot: Bot, session: TelegramSession, text: string): Promise<void> {
  await sendPlainChunks(bot, {
    chatId: numericChatId(session),
    messageThreadId: numericMessageThreadId(session),
    text,
  });
}

export function formatThreadList(project: ProjectBinding, threads: Thread[]): string {
  if (threads.length === 0) {
    return [
      "当前项目下没有找到可恢复的 threads。",
      `project root: ${project.cwd}`,
      "如果桌面端 thread 使用的是这个项目根目录下的子目录，也会被包含；否则请检查项目绑定路径。",
    ].join("\n");
  }

  return [
    `<b>可恢复的 threads (${escapeHtml(project.name)})</b>`,
    ...threads.map((thread, index) =>
      [
        `<b>${index + 1}. ${escapeHtml(thread.name?.trim() || truncateSingleLine(thread.preview, 48) || "(untitled)")}</b>`,
        `ID: <code>${escapeHtml(thread.id)}</code>`,
        `Preview: ${escapeHtml(truncateSingleLine(thread.preview, 120) || "(no preview)")}`,
      ].join("\n"),
    ),
    "",
    "复制上面的 ID，然后执行 <code>/thread resume YOUR_THREAD_ID</code>。",
  ].join("\n\n");
}

export function formatThreadResumeResult(thread: Thread, topicName: string): string {
  return [
    "这个 topic 已绑定到已有 thread。",
    `topic: ${topicName}`,
    `thread: ${thread.id}`,
    `thread path: ${thread.path ?? "(unavailable)"}`,
    `name: ${thread.name?.trim() || "(untitled)"}`,
    `cwd: ${thread.cwd}`,
    `updated: ${formatTimestamp(thread.updatedAt)}`,
  ].join("\n");
}

export function formatThreadResumeAck(thread: Thread, topicName: string, topicId: number): string {
  return [
    "已创建 topic 并恢复 thread。",
    `topic: ${topicName}`,
    `topic id: ${topicId}`,
    `thread: ${thread.id}`,
    `thread path: ${thread.path ?? "(unavailable)"}`,
  ].join("\n");
}

export function formatExistingThreadBinding(threadId: string, session: TelegramSession): string {
  return [
    "这个 Codex thread 已经绑定到 Telegram topic，未重复恢复。",
    `thread: ${threadId}`,
    `bound: ${describeSessionTarget(session)}`,
  ].join("\n");
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

export function formatTopicName(name: string | null | undefined, preview: string, fallback: string): string {
  const raw = name?.trim() || truncateSingleLine(preview, 60) || fallback;
  return raw.slice(0, 128);
}

export function resolveExistingDirectory(input: string): string {
  const resolved = path.resolve(input.trim());
  if (!resolved) {
    throw new Error("项目路径不能为空。");
  }
  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) {
    throw new Error(`不是有效目录: ${resolved}`);
  }
  return resolved;
}

export function assertProjectScopedPath(input: string, projectRoot: string): string {
  const resolved = resolveExistingDirectory(input);
  if (!isPathWithinRoot(resolved, projectRoot)) {
    throw new Error(`目录超出当前项目根目录: ${resolved}`);
  }
  return resolved;
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function hasTopicContext(ctx: Context): boolean {
  const threadId = ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null;
  return threadId != null;
}

export function isPrivateChat(ctx: Context): boolean {
  return ctx.chat?.type === "private";
}

export function isSupergroupChat(ctx: Context): boolean {
  return ctx.chat?.type === "supergroup";
}

export async function safeCall<T>(call: () => Promise<T>): Promise<T | Error> {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

export function formatThreadPathSummary(thread: Thread | Error | null, threadId: string | null): string {
  if (threadId == null) {
    return "待创建";
  }
  if (thread instanceof Error) {
    return `(read failed: ${thread.message})`;
  }
  return thread?.path ?? "(unavailable)";
}

export function formatAccount(value: unknown): string {
  if (value instanceof Error) return `error: ${value.message}`;
  const account = value as { account?: { type?: string; email?: string; planType?: string } | null } | null;
  if (!account?.account) return "未登录或不需要登录";
  return [account.account.type, account.account.email, account.account.planType].filter(Boolean).join(" / ");
}

export function formatRateLimits(value: unknown): string {
  if (value instanceof Error) return `error: ${value.message}`;
  const limits = value as {
    rateLimits?: { primary?: { usedPercent?: number } | null; secondary?: { usedPercent?: number } | null };
  } | null;
  if (!limits?.rateLimits) return "未知";
  const primary = limits.rateLimits.primary?.usedPercent;
  const secondary = limits.rateLimits.secondary?.usedPercent;
  return `primary ${primary ?? "?"}%, secondary ${secondary ?? "?"}%`;
}

export function formatProfileReply(prefix: string, sandboxMode: string, approvalPolicy: string): string {
  return [prefix, `sandbox: ${sandboxMode}`, `approval: ${approvalPolicy}`].join("\n");
}

export function formatReasoningEffort(value: SessionReasoningEffort | null): string {
  return value ?? "codex-default";
}

export function isYoloEnabled(session: TelegramSession): boolean {
  return session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
}

export function contextLogFields(ctx: Context): Record<string, number | string | null> {
  return {
    chatId: ctx.chat?.id ?? null,
    chatType: ctx.chat?.type ?? null,
    messageThreadId: ctx.message?.message_thread_id ?? ctx.callbackQuery?.message?.message_thread_id ?? null,
    fromId: ctx.from?.id ?? null,
  };
}

function describeSessionTarget(session: TelegramSession): string {
  if (session.messageThreadId) {
    return `topic ${session.messageThreadId} (chat ${session.chatId})`;
  }
  return `chat ${session.chatId}`;
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("zh-CN", {
    hour12: false,
  });
}
