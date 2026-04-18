import type { Context } from "grammy";
import type { AppConfig } from "../config.js";
import { isPathWithinRoot } from "../pathScope.js";
import type { ProjectBinding, ProjectStore } from "../store/projectStore.js";
import { makeSessionKey, type SessionStore, type TelegramSession } from "../store/sessionStore.js";
import { replyNotice } from "../telegram/replyDocument.js";
import { sessionFromContext } from "./topicSession.js";

export interface SessionRequirementOptions {
  requireTopic?: boolean;
}

export function getProjectForContext(ctx: Context, projects: ProjectStore): ProjectBinding | null {
  const chatId = ctx.chat?.id;
  if (chatId == null || isPrivateChat(ctx)) return null;
  return projects.get(String(chatId));
}

export function getScopedSession(
  ctx: Context,
  sessions: SessionStore,
  projects: ProjectStore,
  config: AppConfig,
  options?: SessionRequirementOptions,
): TelegramSession | null {
  const project = getProjectForContext(ctx, projects);
  if (!project || isPrivateChat(ctx)) return null;

  const requireTopic = options?.requireTopic ?? true;
  if (requireTopic && !hasTopicContext(ctx)) return null;

  const session = sessionFromContext(ctx, sessions, config);
  if (!isPathWithinRoot(session.cwd, project.cwd)) {
    sessions.setCwd(session.sessionKey, project.cwd);
    return sessions.get(session.sessionKey) ?? session;
  }
  return session;
}

export async function requireScopedSession(
  ctx: Context,
  sessions: SessionStore,
  projects: ProjectStore,
  config: AppConfig,
  options?: SessionRequirementOptions,
): Promise<TelegramSession | null> {
  const session = getScopedSession(ctx, sessions, projects, config, options);
  if (session) return session;
  await replyScopedSessionRequirement(ctx, projects, options);
  return null;
}

export function ensureTopicSession(input: {
  sessions: SessionStore;
  config: AppConfig;
  project: ProjectBinding;
  chatId: number;
  messageThreadId: number;
  topicName?: string | null;
  threadId?: string | null;
}): TelegramSession {
  const sessionKey = makeSessionKey(input.chatId, input.messageThreadId);
  const session = input.sessions.getOrCreate({
    sessionKey,
    chatId: String(input.chatId),
    messageThreadId: String(input.messageThreadId),
    telegramTopicName: input.topicName ?? null,
    defaultCwd: input.project.cwd,
    defaultModel: input.config.defaultModel,
  });
  if (input.topicName && session.telegramTopicName !== input.topicName) {
    input.sessions.setTelegramTopicName(session.sessionKey, input.topicName);
  }
  if (input.threadId && session.codexThreadId !== input.threadId) {
    input.sessions.bindThread(session.sessionKey, input.threadId);
  }
  if (!isPathWithinRoot(session.cwd, input.project.cwd)) {
    input.sessions.setCwd(session.sessionKey, input.project.cwd);
    return input.sessions.get(session.sessionKey) ?? session;
  }
  return input.sessions.get(session.sessionKey) ?? session;
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

async function replyScopedSessionRequirement(
  ctx: Context,
  projects: ProjectStore,
  options?: SessionRequirementOptions,
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
