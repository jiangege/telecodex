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
            "/thread list",
            "/thread resume <threadId>",
            "/thread new <topic-name>",
          ].join("\n"),
        );
        return;
      }
      await ctx.reply("Usage:\n/thread list\n/thread resume <threadId>\n/thread new <topic-name>");
      return;
    }

    if (command === "list") {
      await listProjectThreads(ctx, deps);
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

    await ctx.reply("Usage:\n/thread list\n/thread resume <threadId>\n/thread new <topic-name>");
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
  const { bot, config, store, projects, logger, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const thread = await threadCatalog.findProjectThreadById({
    projectRoot: project.cwd,
    threadId,
  });
  if (!thread) {
    await ctx.reply(
      [
        "Could not find a saved Codex thread with that id under this project.",
        `project root: ${project.cwd}`,
        `thread: ${threadId}`,
        "Run /thread list to inspect the saved project threads first.",
      ].join("\n"),
    );
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

  await ctx.reply(
    [
      "Created a topic and bound it to the existing thread id.",
      `topic: ${forumTopic.name}`,
      `topic id: ${forumTopic.message_thread_id}`,
      `thread: ${thread.id}`,
      `cwd: ${thread.cwd}`,
      "Future messages in this topic will continue on that thread through the Codex SDK.",
    ].join("\n"),
  );

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

async function listProjectThreads(ctx: ProjectCommandContext, deps: BotHandlerDeps): Promise<void> {
  const { projects, store, threadCatalog } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const threads = await threadCatalog.listProjectThreads({
    projectRoot: project.cwd,
    limit: 8,
  });
  if (threads.length === 0) {
    await ctx.reply(
      [
        "No saved Codex threads were found for this project yet.",
        `project root: ${project.cwd}`,
      ].join("\n"),
    );
    return;
  }

  const lines = [
    `Saved Codex threads for ${project.name}:`,
    ...threads.flatMap((thread, index) => {
      const relativeCwd = path.relative(project.cwd, thread.cwd) || ".";
      const bound = store.getByThreadId(thread.id);
      return [
        `${index + 1}. ${thread.preview}`,
        `   id: ${thread.id}`,
        `   cwd: ${relativeCwd}`,
        `   updated: ${thread.updatedAt}`,
        `   source: ${thread.source ?? "unknown"}`,
        ...(bound
          ? [`   bound: ${bound.telegramTopicName ?? bound.messageThreadId ?? bound.sessionKey}`]
          : []),
      ];
    }),
    "",
    "Resume one with /thread resume <threadId>",
  ];
  await ctx.reply(lines.join("\n"));
}
