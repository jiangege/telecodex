import type { CommandContext, Context } from "grammy";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  ensureTopicSession,
  formatPrivateProjectList,
  formatProjectStatus,
  formatTopicName,
  getProjectForContext,
  getScopedSession,
  hasTopicContext,
  isPrivateChat,
  isSupergroupChat,
  parseSubcommand,
  postTopicReadyMessage,
  resolveExistingDirectory,
} from "../commandSupport.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";

const PROJECT_REQUIRED_MESSAGE = "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.";
type ProjectCommandContext = CommandContext<Context>;

export function registerProjectHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, logger } = deps;

  bot.command("project", async (ctx) => {
    const { command, args } = parseSubcommand(ctx.match.trim());

    if (isPrivateChat(ctx)) {
      if (!command || command === "list" || command === "status") {
        await ctx.reply(formatPrivateProjectList(projects));
        return;
      }
      await ctx.reply("Use /project bind inside a supergroup with topics enabled. Private chat is only for admin entry points.");
      return;
    }

    if (!isSupergroupChat(ctx)) {
      await ctx.reply("Use telecodex inside a supergroup with forum topics enabled.");
      return;
    }

    if (!command || command === "status") {
      const project = getProjectForContext(ctx, projects);
      await ctx.reply(project ? formatProjectStatus(project) : PROJECT_REQUIRED_MESSAGE);
      return;
    }

    if (command === "bind") {
      if (!args) {
        await ctx.reply("Usage: /project bind <absolute-path>");
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
        const session = getScopedSession(ctx, store, projects, config, { requireTopic: false });
        if (session && session.cwd !== project.cwd) {
          store.setCwd(session.sessionKey, project.cwd);
        }
        await ctx.reply(
          [
            "Project binding updated.",
            `project: ${project.name}`,
            `root: ${project.cwd}`,
            "This supergroup now represents one project, and each topic maps to one Codex thread.",
          ].join("\n"),
        );
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "unbind") {
      logger?.info("project unbound", {
        ...contextLogFields(ctx),
      });
      projects.remove(String(ctx.chat.id));
      await ctx.reply("Removed the project binding for this supergroup.");
      return;
    }

    await ctx.reply("Usage:\n/project\n/project bind <absolute-path>\n/project unbind");
  });

  bot.command("thread", async (ctx) => {
    if (isPrivateChat(ctx)) {
      await ctx.reply("The thread command is only available inside project supergroups.");
      return;
    }

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      if (hasTopicContext(ctx)) {
        const session = getScopedSession(ctx, store, projects, config);
        if (!session) return;
        await ctx.reply(
          [
            `Current thread: ${session.codexThreadId ?? "not created"}`,
            `state: ${formatSessionRuntimeStatus(session.runtimeStatus)}`,
            `state detail: ${session.runtimeStatusDetail ?? "none"}`,
            `queue: ${store.getQueuedInputCount(session.sessionKey)}`,
            `cwd: ${session.cwd}`,
            "Manage threads in this project:",
            "/thread resume <threadId>",
            "/thread new <topic-name>",
          ].join("\n"),
        );
        return;
      }
      await ctx.reply("Usage:\n/thread resume <threadId>\n/thread new <topic-name>");
      return;
    }

    if (command === "resume") {
      if (!args) {
        await ctx.reply("Usage: /thread resume <threadId>");
        return;
      }
      await resumeThreadIntoTopic(ctx, deps, args);
      return;
    }
    if (command === "new") {
      await createFreshThreadTopic(ctx, deps, args);
      return;
    }

    await ctx.reply("Usage:\n/thread resume <threadId>\n/thread new <topic-name>");
  });

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
  const { bot, config, store, projects, logger } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const topicName = formatTopicName(`Resumed ${threadId.slice(0, 8)}`, "Resumed Thread");
  const forumTopic = await bot.api.createForumTopic(ctx.chat.id, topicName);
  const session = ensureTopicSession({
    store,
    config,
    project,
    chatId: ctx.chat.id,
    messageThreadId: forumTopic.message_thread_id,
    topicName: forumTopic.name,
    threadId,
  });

  logger?.info("thread id bound into topic", {
    ...contextLogFields(ctx),
    sessionKey: session.sessionKey,
    threadId,
    topicName: forumTopic.name,
  });

  await ctx.reply(
    [
      "Created a topic and bound it to the existing thread id.",
      `topic: ${forumTopic.name}`,
      `topic id: ${forumTopic.message_thread_id}`,
      `thread: ${threadId}`,
      "Future messages in this topic will continue on that thread through the Codex SDK.",
    ].join("\n"),
  );

  await postTopicReadyMessage(
    bot,
    session,
    [
      "This topic is now bound to an existing Codex thread id.",
      `thread: ${threadId}`,
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
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
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

  await ctx.reply(
    [
      "Created a new topic.",
      `topic: ${forumTopic.name}`,
      `topic id: ${forumTopic.message_thread_id}`,
      "Your first normal message will start a new Codex SDK thread.",
    ].join("\n"),
  );

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
