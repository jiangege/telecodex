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

const PROJECT_REQUIRED_MESSAGE = "当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>";
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
      await ctx.reply("请在启用了 topics 的 supergroup 中使用 /project bind。私聊只保留管理入口。");
      return;
    }

    if (!isSupergroupChat(ctx)) {
      await ctx.reply("请把 telecodex 放在启用了 forum topics 的 supergroup 中使用。");
      return;
    }

    if (!command || command === "status") {
      const project = getProjectForContext(ctx, projects);
      await ctx.reply(project ? formatProjectStatus(project) : PROJECT_REQUIRED_MESSAGE);
      return;
    }

    if (command === "bind") {
      if (!args) {
        await ctx.reply("用法: /project bind <绝对路径>");
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
            "项目绑定完成。",
            `project: ${project.name}`,
            `root: ${project.cwd}`,
            "这个 supergroup 现在代表一个项目；每个 topic 对应一个 Codex thread。",
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
      await ctx.reply("已解除当前 supergroup 的项目绑定。");
      return;
    }

    await ctx.reply("用法:\n/project\n/project bind <绝对路径>\n/project unbind");
  });

  bot.command("thread", async (ctx) => {
    if (isPrivateChat(ctx)) {
      await ctx.reply("thread 命令只在项目 supergroup 中使用。");
      return;
    }

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      if (hasTopicContext(ctx)) {
        const session = getScopedSession(ctx, store, projects, config);
        if (!session) return;
        await ctx.reply(
          [
            `当前 thread: ${session.codexThreadId ?? "待创建"}`,
            `state: ${formatSessionRuntimeStatus(session.runtimeStatus)}`,
            `state detail: ${session.runtimeStatusDetail ?? "无"}`,
            `queue: ${store.getQueuedInputCount(session.sessionKey)}`,
            `cwd: ${session.cwd}`,
            "在当前项目中管理 threads：",
            "/thread resume <threadId>",
            "/thread new <topic 名称>",
          ].join("\n"),
        );
        return;
      }
      await ctx.reply("用法:\n/thread resume <threadId>\n/thread new <topic 名称>");
      return;
    }

    if (command === "resume") {
      if (!args) {
        await ctx.reply("用法: /thread resume <threadId>");
        return;
      }
      await resumeThreadIntoTopic(ctx, deps, args);
      return;
    }
    if (command === "new") {
      await createFreshThreadTopic(ctx, deps, args);
      return;
    }

    await ctx.reply("用法:\n/thread resume <threadId>\n/thread new <topic 名称>");
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
      "已创建 topic 并绑定到已有 thread id。",
      `topic: ${forumTopic.name}`,
      `topic id: ${forumTopic.message_thread_id}`,
      `thread: ${threadId}`,
      "后续消息会通过 Codex SDK 在该 thread 上继续。",
    ].join("\n"),
  );

  await postTopicReadyMessage(
    bot,
    session,
    [
      "这个 topic 已绑定到已有 Codex thread id。",
      `thread: ${threadId}`,
      "直接发送消息即可继续。",
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
      "已创建新 topic。",
      `topic: ${forumTopic.name}`,
      `topic id: ${forumTopic.message_thread_id}`,
      "首条普通消息会启动一个新的 Codex SDK thread。",
    ].join("\n"),
  );

  await postTopicReadyMessage(
    bot,
    session,
    [
      "新 topic 已创建。",
      "直接发送消息即可开始一个新的 Codex thread。",
      `cwd: ${session.cwd}`,
      `model: ${session.model}`,
    ].join("\n"),
  );
}
