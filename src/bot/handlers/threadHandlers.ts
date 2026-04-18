import type { CommandContext, Context } from "grammy";
import path from "node:path";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { codeField, replyDocument, replyNotice, replyUsage, textField } from "../../telegram/replyDocument.js";
import {
  contextLogFields,
  getProjectForContext,
  hasTopicContext,
  isPrivateChat,
  parseSubcommand,
  requireScopedSession,
} from "../commandContext.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import { isSessionBusy } from "../sessionState.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";
import { makeSessionKey, type SessionStore, type TelegramSession } from "../../store/sessionStore.js";

const PROJECT_REQUIRED_MESSAGE = "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.";
type ProjectCommandContext = CommandContext<Context>;

export function registerThreadHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, projects, logger } = deps;

  bot.command("thread", wrapUserFacingHandler("thread", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, "The thread command is only available inside project supergroups.");
      return;
    }

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      if (hasTopicContext(ctx)) {
        const session = await requireScopedSession(ctx, sessions, projects, config);
        if (!session) return;
        await replyDocument(ctx, {
          title: "Current thread",
          fields: [
            codeField("thread", session.codexThreadId ?? "not created"),
            textField("state", formatSessionRuntimeStatus(session.runtimeStatus)),
            textField("state detail", session.runtimeStatusDetail ?? "none"),
            codeField("cwd", session.cwd),
          ],
          footer: ["Manage threads in this project:", "/thread list", "/thread new", "/thread resume <threadId>"],
        });
        return;
      }
      await replyNotice(
        ctx,
        [
          "Use /thread list in the root chat.",
          "Create or open a Telegram forum topic, then use /thread new or /thread resume <threadId> inside that topic.",
        ].join("\n"),
      );
      return;
    }

    if (command === "list") {
      await listProjectThreads(ctx, deps);
      return;
    }
    if (command === "resume") {
      if (!args) {
        await replyUsage(ctx, "/thread resume <threadId>");
        return;
      }
      if (!hasTopicContext(ctx)) {
        await replyNotice(ctx, "Create or open a Telegram forum topic, then run /thread resume <threadId> inside that topic.");
        return;
      }
      await resumeThreadInCurrentTopic(ctx, deps, args);
      return;
    }
    if (command === "new") {
      if (args) {
        await replyUsage(ctx, "/thread new");
        return;
      }
      if (!hasTopicContext(ctx)) {
        await replyNotice(ctx, "Create or open a Telegram forum topic, then run /thread new inside that topic.");
        return;
      }
      await startFreshThreadInCurrentTopic(ctx, deps);
      return;
    }

    await replyUsage(ctx, ["/thread list", "/thread new", "/thread resume <threadId>"]);
  }));

  bot.on(["message:forum_topic_created", "message:forum_topic_edited"], async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (threadId == null) return;

    const topicName = ctx.message.forum_topic_created?.name ?? ctx.message.forum_topic_edited?.name ?? null;
    if (!topicName) return;

    const sessionKey = makeSessionKey(ctx.chat.id, threadId);
    const session = sessions.get(sessionKey);
    if (!session) return;

    sessions.setTelegramTopicName(sessionKey, topicName);
  });
}

async function resumeThreadInCurrentTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  threadId: string,
): Promise<void> {
  const { config, sessions, projects, logger, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const session = await requireScopedSession(ctx, sessions, projects, config);
  if (!session) return;
  const latest = await requireIdleThreadMutationTarget(ctx, deps, session);
  if (!latest) return;

  const thread = await threadCatalog.findProjectThreadById({
    projectRoot: project.cwd,
    threadId,
  });
  if (!thread) {
    await replyDocument(ctx, {
      title: "Could not find a saved Codex thread with that id under this project.",
      fields: [
        codeField("project root", project.cwd),
        codeField("thread", threadId),
      ],
      footer: "Run /thread list to inspect the saved project threads first.",
    });
    return;
  }

  if (latest.codexThreadId === thread.id) {
    await replyNotice(ctx, "This topic is already bound to that Codex thread.");
    return;
  }

  sessions.bindThread(latest.sessionKey, thread.id);
  resetTopicSessionState(sessions, latest.sessionKey);
  const updated = sessions.get(latest.sessionKey) ?? latest;

  logger?.info("thread id bound into current topic", {
    ...contextLogFields(ctx),
    sessionKey: updated.sessionKey,
    threadId: thread.id,
    topicName: updated.telegramTopicName,
  });

  await replyDocument(ctx, {
    title: "Current topic is now bound to the existing thread id.",
    fields: [
      textField("topic", updated.telegramTopicName ?? "current topic"),
      textField("topic id", updated.messageThreadId ?? "unknown"),
      codeField("thread", thread.id),
      codeField("cwd", updated.cwd),
    ],
    footer: "Future messages in this topic will continue on that thread through the Codex SDK.",
  });
}

async function startFreshThreadInCurrentTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
): Promise<void> {
  const { config, sessions, projects, logger } = deps;
  const session = await requireScopedSession(ctx, sessions, projects, config);
  if (!session) return;
  const latest = await requireIdleThreadMutationTarget(ctx, deps, session);
  if (!latest) return;

  sessions.bindThread(latest.sessionKey, null);
  resetTopicSessionState(sessions, latest.sessionKey);
  const updated = sessions.get(latest.sessionKey) ?? latest;

  logger?.info("current topic reset to a new codex thread", {
    ...contextLogFields(ctx),
    sessionKey: updated.sessionKey,
    previousThreadId: latest.codexThreadId,
    topicName: updated.telegramTopicName,
  });

  await replyDocument(ctx, {
    title: "Current topic is ready for a new thread.",
    fields: [
      textField("topic", updated.telegramTopicName ?? "current topic"),
      textField("topic id", updated.messageThreadId ?? "unknown"),
      codeField("thread", "not created"),
      codeField("cwd", updated.cwd),
    ],
    footer: "Your next normal message in this topic will start a new Codex thread.",
  });
}

async function listProjectThreads(ctx: ProjectCommandContext, deps: BotHandlerDeps): Promise<void> {
  const { projects, sessions, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const threads = await threadCatalog.listProjectThreads({
    projectRoot: project.cwd,
    limit: 8,
  });
  if (threads.length === 0) {
    await replyDocument(ctx, {
      title: "No saved Codex threads were found for this project yet.",
      fields: [codeField("project root", project.cwd)],
    });
    return;
  }

  await replyDocument(ctx, {
    title: "Saved Codex threads",
    fields: [
      codeField("project", project.name),
      codeField("root", project.cwd),
    ],
    sections: threads.map((thread, index) => {
      const relativeCwd = path.relative(project.cwd, thread.cwd) || ".";
      const bound = sessions.getByThreadId(thread.id);
      return {
        title: `${index + 1}. ${thread.preview}`,
        fields: [
          codeField("id", thread.id),
          codeField("resume", `/thread resume ${thread.id}`),
          codeField("cwd", relativeCwd),
          textField("updated", thread.updatedAt),
          textField("source", thread.source ?? "unknown"),
          ...(bound
            ? [textField("bound", bound.telegramTopicName ?? bound.messageThreadId ?? bound.sessionKey)]
            : []),
        ],
      };
    }),
    footer: "Copy an id or resume command from the code-formatted fields above.",
  });
}

async function requireIdleThreadMutationTarget(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  session: TelegramSession,
): Promise<TelegramSession | null> {
  const { sessions, codex } = deps;
  const latest = sessions.get(session.sessionKey) ?? session;
  if (isSessionBusy(latest) || codex.isRunning(latest.sessionKey)) {
    await replyNotice(ctx, "Stop the current run before changing the thread binding for this topic.");
    return null;
  }
  return latest;
}

function resetTopicSessionState(sessions: SessionStore, sessionKey: string): void {
  sessions.setOutputMessage(sessionKey, null);
  sessions.setRuntimeState(sessionKey, {
    status: "idle",
    detail: null,
    updatedAt: new Date().toISOString(),
  });
}
