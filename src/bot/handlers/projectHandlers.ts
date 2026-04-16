import type { CommandContext, Context } from "grammy";
import path from "node:path";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  ensureTopicSession,
  formatPrivateProjectList,
  formatProjectStatus,
  getProjectForContext,
  hasTopicContext,
  isPrivateChat,
  isSupergroupChat,
  parseSubcommand,
  requireScopedSession,
  resolveExistingDirectory,
} from "../commandSupport.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { isSessionBusy } from "../sessionFlow.js";
import { codeField, replyDocument, replyError, replyNotice, replyUsage, textField } from "../../telegram/formatted.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

const PROJECT_REQUIRED_MESSAGE = "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.";
type ProjectCommandContext = CommandContext<Context>;

export function registerProjectHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, logger } = deps;

  bot.command("project", wrapUserFacingHandler("project", logger, async (ctx) => {
    const { command, args } = parseSubcommand(ctx.match.trim());

    if (isPrivateChat(ctx)) {
      if (!command || command === "list" || command === "status") {
        await replyNotice(ctx, formatPrivateProjectList(projects));
        return;
      }
      await replyNotice(ctx, "Use /project bind inside a supergroup with topics enabled. Private chat is only for admin entry points.");
      return;
    }

    if (!isSupergroupChat(ctx)) {
      await replyNotice(ctx, "Use telecodex inside a supergroup with forum topics enabled.");
      return;
    }

    if (!command || command === "status") {
      const project = getProjectForContext(ctx, projects);
      await replyNotice(ctx, project ? formatProjectStatus(project) : PROJECT_REQUIRED_MESSAGE);
      return;
    }

    if (command === "bind") {
      if (!args) {
        await replyUsage(ctx, "/project bind <absolute-path>");
        return;
      }
      try {
        const cwd = resolveExistingDirectory(args);
        const project = projects.upsert({
          chatId: String(ctx.chat.id),
          cwd,
        });
        logger?.info("project bound", {
          ...contextLogFields(ctx),
          project: project.name,
          cwd: project.cwd,
        });
        const session = await requireScopedSession(ctx, store, projects, config, { requireTopic: false });
        if (session && session.cwd !== project.cwd) {
          store.setCwd(session.sessionKey, project.cwd);
        }
        await replyDocument(ctx, {
          title: "Project binding updated.",
          fields: [
            codeField("project", project.name),
            codeField("root", project.cwd),
          ],
          footer: "This supergroup now represents one project, and each topic maps to one Codex thread.",
        });
      } catch (error) {
        await replyError(ctx, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "unbind") {
      logger?.info("project unbound", {
        ...contextLogFields(ctx),
      });
      projects.remove(String(ctx.chat.id));
      await replyNotice(ctx, "Removed the project binding for this supergroup.");
      return;
    }

    await replyUsage(ctx, ["/project", "/project bind <absolute-path>", "/project unbind"]);
  }));

  bot.command("thread", wrapUserFacingHandler("thread", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, "The thread command is only available inside project supergroups.");
      return;
    }

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      if (hasTopicContext(ctx)) {
        const session = await requireScopedSession(ctx, store, projects, config);
        if (!session) return;
        await replyDocument(ctx, {
          title: "Current thread",
          fields: [
            codeField("thread", session.codexThreadId ?? "not created"),
            textField("state", formatSessionRuntimeStatus(session.runtimeStatus)),
            textField("state detail", session.runtimeStatusDetail ?? "none"),
            textField("queue", store.getQueuedInputCount(session.sessionKey)),
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

    const sessionKey = `${ctx.chat.id}:${threadId}`;
    const session = store.get(sessionKey);
    if (!session) return;

    store.setTelegramTopicName(sessionKey, topicName);
  });
}

async function resumeThreadInCurrentTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  threadId: string,
): Promise<void> {
  const { config, store, projects, logger, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const session = await requireScopedSession(ctx, store, projects, config);
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

  store.bindThread(latest.sessionKey, thread.id);
  resetTopicSessionState(store, latest.sessionKey);
  const updated = store.get(latest.sessionKey) ?? latest;

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
  const { config, store, projects, logger } = deps;
  const session = await requireScopedSession(ctx, store, projects, config);
  if (!session) return;
  const latest = await requireIdleThreadMutationTarget(ctx, deps, session);
  if (!latest) return;

  store.bindThread(latest.sessionKey, null);
  resetTopicSessionState(store, latest.sessionKey);
  const updated = store.get(latest.sessionKey) ?? latest;

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
  const { projects, store, threadCatalog } = deps;
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
      const bound = store.getByThreadId(thread.id);
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
  session: ReturnType<typeof ensureTopicSession>,
): Promise<ReturnType<typeof ensureTopicSession> | null> {
  const { store, codex } = deps;
  const latest = store.get(session.sessionKey) ?? session;
  if (isSessionBusy(latest) || codex.isRunning(latest.sessionKey)) {
    await replyNotice(ctx, "Stop the current run before changing the thread binding for this topic.");
    return null;
  }
  const queueDepth = store.getQueuedInputCount(latest.sessionKey);
  if (queueDepth > 0) {
    await replyNotice(ctx, `Clear ${queueDepth} queued message(s) before changing the thread binding for this topic.`);
    return null;
  }
  return latest;
}

function resetTopicSessionState(store: BotHandlerDeps["store"], sessionKey: string): void {
  store.setOutputMessage(sessionKey, null);
  store.setRuntimeState(sessionKey, {
    status: "idle",
    detail: null,
    updatedAt: new Date().toISOString(),
  });
}
