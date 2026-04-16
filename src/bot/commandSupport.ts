import { realpathSync, statSync } from "node:fs";
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
import { replyNotice, sendReplyNotice } from "../telegram/formatted.js";
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
  const project = getProjectForContext(ctx, projects);
  if (!project || isPrivateChat(ctx)) return null;

  const requireTopic = options?.requireTopic ?? true;
  if (requireTopic && !hasTopicContext(ctx)) return null;

  const session = sessionFromContext(ctx, store, config);
  if (!isPathWithinRoot(session.cwd, project.cwd)) {
    store.setCwd(session.sessionKey, project.cwd);
    return store.get(session.sessionKey) ?? session;
  }
  return session;
}

export async function requireScopedSession(
  ctx: Context,
  store: SessionStore,
  projects: ProjectStore,
  config: AppConfig,
  options?: { requireTopic?: boolean },
): Promise<TelegramSession | null> {
  const session = getScopedSession(ctx, store, projects, config, options);
  if (session) return session;
  await replyScopedSessionRequirement(ctx, projects, options);
  return null;
}

export function formatHelpText(ctx: Context, projects: ProjectStore): string {
  if (isPrivateChat(ctx)) {
    return [
      "telecodex is ready.",
      "",
      "Primary workflow:",
      "1. One forum supergroup = one project",
      "2. Create or open a Telegram topic yourself",
      "3. Send normal messages directly inside the topic",
      "",
      "Run this first in the project group:",
      "/project bind <absolute-path>",
      "",
      "Then inspect saved threads in the group:",
      "/thread list",
      "",
      "Inside a topic, send messages directly:",
      "/thread new",
      "/thread resume <threadId>",
      "/status",
      "/queue",
      "/queue drop <id>",
      "/queue clear",
      "/stop",
      "/admin",
      "",
      formatPrivateProjectSummary(projects),
    ].join("\n");
  }

  const project = getProjectForContext(ctx, projects);
  if (!project) {
    return [
      "This supergroup has no project bound yet.",
      "",
      "Run this first:",
      "/project bind <absolute-path>",
      "",
      "After binding, each topic acts as an independent Codex thread.",
    ].join("\n");
  }

  return [
    "telecodex is ready.",
    "",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "",
    "/project show the project binding",
    "/project bind <absolute-path> update the project root",
    "/thread list show saved Codex threads already recorded for this project",
    "/thread new reset the current topic so the next message starts a new thread",
    "/thread resume <threadId> bind the current topic to an existing thread",
    "send a normal message inside a topic to the current thread",
    "/status show topic state, recent SDK events, and queue depth",
    "/queue show queued messages for the current topic",
    "/queue drop <id> remove one queued message",
    "/queue clear clear the current topic queue",
    "/stop interrupt the current SDK run",
    "/cwd <path> switch to a working subdirectory inside the project root",
    `/mode ${MODE_PRESETS.join("|")}`,
    `/sandbox ${SANDBOX_MODES.join("|")}`,
    `/approval ${APPROVAL_POLICIES.join("|")}`,
    "/yolo on|off",
    "/model <id>",
    `/effort default|${REASONING_EFFORTS.join("|")}`,
    "/web default|disabled|cached|live",
    "/network on|off",
    "/gitcheck skip|enforce",
    "/adddir list|add|add-external|drop|clear",
    "/schema show|set|clear",
    "/codexconfig show|set|clear",
  ].join("\n");
}

export function formatPrivateStatus(store: SessionStore, projects: ProjectStore): string {
  const binding = store.getBindingCodeState();
  return [
    "telecodex admin",
    `authorized telegram user id: ${store.getAuthorizedUserId() ?? "not bound"}`,
    binding?.mode === "rebind" ? `pending handoff: active until ${binding.expiresAt}` : "pending handoff: none",
    "",
    formatPrivateProjectSummary(projects),
  ].join("\n");
}

export function formatPrivateProjectSummary(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "No project supergroups are currently bound.";
  }
  return `Bound project supergroups: ${bound.length}`;
}

export function formatPrivateProjectList(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "No project supergroups are currently bound.";
  }
  return [
    "Bound projects:",
    ...bound.map((project, index) => `${index + 1}. ${project.name}\n   root: ${project.cwd}\n   chat: ${project.chatId}`),
  ].join("\n");
}

export function formatProjectStatus(project: ProjectBinding): string {
  return [
    "Project status",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "This supergroup represents one project. Create or open a Telegram topic, then use /thread new or /thread resume inside that topic.",
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
  await sendReplyNotice(
    bot,
    {
      chatId: numericChatId(session),
      messageThreadId: numericMessageThreadId(session),
    },
    text,
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
    throw new Error("Project path cannot be empty.");
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  return canonicalizeBoundaryPath(resolved);
}

export function assertProjectScopedPath(input: string, projectRoot: string): string {
  const resolved = resolveExistingDirectory(input);
  const canonicalRoot = resolveExistingDirectory(projectRoot);
  if (!isPathWithinRoot(resolved, canonicalRoot)) {
    throw new Error(["Path must stay within the project root.", `project root: ${projectRoot}`, `input: ${resolved}`].join("\n"));
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
  const resolvedCandidate = canonicalizeBoundaryPath(candidate);
  const resolvedRoot = canonicalizeBoundaryPath(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function canonicalizeBoundaryPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function replyScopedSessionRequirement(
  ctx: Context,
  projects: ProjectStore,
  options?: { requireTopic?: boolean },
): Promise<void> {
  if (isPrivateChat(ctx)) {
    await replyNotice(ctx, "Private chat is only for admin binding and project overview. Do actual work inside project supergroup topics.");
    return;
  }

  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.");
    return;
  }

  const requireTopic = options?.requireTopic ?? true;
  if (requireTopic && !hasTopicContext(ctx)) {
    await replyNotice(ctx, "Use this inside a forum topic. The root chat is only for project-level commands; work happens inside topics.");
  }
}
