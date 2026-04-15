import type { CommandContext, Context } from "grammy";
import path from "node:path";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  ensureTopicSession,
  formatPrivateProjectList,
  formatProjectStatus,
  formatTopicName,
  getProjectForContext,
  hasTopicContext,
  isPrivateChat,
  isSupergroupChat,
  parseSubcommand,
  postTopicReadyMessage,
  requireScopedSession,
  resolveExistingDirectory,
} from "../commandSupport.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
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
          footer: ["Manage threads in this project:", "/thread list", "/thread resume <threadId>", "/thread new <topic-name>"],
        });
        return;
      }
      await replyUsage(ctx, ["/thread list", "/thread resume <threadId>", "/thread new <topic-name>"]);
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
      await resumeThreadIntoTopic(ctx, deps, args);
      return;
    }
    if (command === "new") {
      await createFreshThreadTopic(ctx, deps, args);
      return;
    }

    await replyUsage(ctx, ["/thread list", "/thread resume <threadId>", "/thread new <topic-name>"]);
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

async function resumeThreadIntoTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  threadId: string,
): Promise<void> {
  const { bot, config, store, projects, logger, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, PROJECT_REQUIRED_MESSAGE);
    return;
  }

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

  const topicName = formatTopicName(thread.preview, `Resumed ${thread.id.slice(0, 8)}`);
  const forumTopic = await bot.api.createForumTopic(ctx.chat.id, topicName);
  const session = ensureTopicSession({
    store,
    config,
    project,
    chatId: ctx.chat.id,
    messageThreadId: forumTopic.message_thread_id,
    topicName: forumTopic.name,
    threadId: thread.id,
  });

  logger?.info("thread id bound into topic", {
    ...contextLogFields(ctx),
    sessionKey: session.sessionKey,
    threadId: thread.id,
    topicName: forumTopic.name,
  });

  await replyDocument(ctx, {
    title: "Created a topic and bound it to the existing thread id.",
    fields: [
      textField("topic", forumTopic.name),
      textField("topic id", forumTopic.message_thread_id),
      codeField("thread", thread.id),
      codeField("cwd", thread.cwd),
    ],
    footer: "Future messages in this topic will continue on that thread through the Codex SDK.",
  });

  await postTopicReadyMessage(
    bot,
    session,
    [
      "This topic is now bound to an existing Codex thread id.",
      `thread: ${thread.id}`,
      "Send a message to continue.",
    ].join("\n"),
  );
}

async function createFreshThreadTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  requestedName: string,
): Promise<void> {
  const { bot, config, store, projects, logger } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await replyNotice(ctx, PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const topicName = formatTopicName(requestedName, "New Thread");
  const forumTopic = await bot.api.createForumTopic(ctx.chat.id, topicName);
  const session = ensureTopicSession({
    store,
    config,
    project,
    chatId: ctx.chat.id,
    messageThreadId: forumTopic.message_thread_id,
    topicName: forumTopic.name,
  });

  logger?.info("new thread topic created", {
    ...contextLogFields(ctx),
    sessionKey: session.sessionKey,
    topicName: forumTopic.name,
  });

  await replyDocument(ctx, {
    title: "Created a new topic.",
    fields: [
      textField("topic", forumTopic.name),
      textField("topic id", forumTopic.message_thread_id),
    ],
    footer: "Your first normal message will start a new Codex SDK thread.",
  });

  await postTopicReadyMessage(
    bot,
    session,
    [
      "New topic created.",
      "Send a message to start a new Codex thread.",
      `cwd: ${session.cwd}`,
      `model: ${session.model}`,
    ].join("\n"),
  );
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
