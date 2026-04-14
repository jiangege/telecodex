import type { CommandContext, Context } from "grammy";
import { sendHtmlChunks } from "../../telegram/delivery.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  ensureTopicSession,
  formatExistingThreadBinding,
  formatPrivateProjectList,
  formatProjectStatus,
  formatThreadList,
  formatThreadPathSummary,
  formatThreadResumeAck,
  formatThreadResumeResult,
  formatTopicName,
  getProjectForContext,
  getScopedSession,
  hasTopicContext,
  isPathWithinRoot,
  isPrivateChat,
  isSupergroupChat,
  listProjectThreads,
  parseSubcommand,
  postTopicReadyMessage,
  resolveExistingDirectory,
  safeCall,
} from "../commandSupport.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { refreshTopicStatusPin, sessionLogFields, syncSessionFromCodexRuntime } from "../sessionFlow.js";

const PROJECT_REQUIRED_MESSAGE = "当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>";
type ProjectCommandContext = CommandContext<Context>;

export function registerProjectHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, gateway, logger } = deps;

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
        if (session && !isPathWithinRoot(session.cwd, project.cwd)) {
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
        const threadDetails =
          session.codexThreadId == null ? null : await safeCall(() => gateway.readThread(session.codexThreadId!, false));
        await ctx.reply(
          [
            `当前 thread: ${session.codexThreadId ?? "待创建"}`,
            `thread path: ${formatThreadPathSummary(threadDetails, session.codexThreadId)}`,
            `state: ${formatSessionRuntimeStatus(session.runtimeStatus)}`,
            `state detail: ${session.runtimeStatusDetail ?? "无"}`,
            `queue: ${store.getQueuedInputCount(session.sessionKey)}`,
            `cwd: ${session.cwd}`,
            "在当前项目中管理 threads：",
            "/thread list [关键词]",
            "/thread resume <threadId>",
            "/thread new <topic 名称>",
          ].join("\n"),
        );
        return;
      }
      await ctx.reply("用法:\n/thread list [关键词]\n/thread resume <threadId>\n/thread new <topic 名称>");
      return;
    }

    if (command === "list") {
      await replyProjectThreadList(ctx, deps, args);
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

    await ctx.reply("用法:\n/thread list [关键词]\n/thread resume <threadId>\n/thread new <topic 名称>");
  });

  bot.command("threads", async (ctx) => {
    await replyProjectThreadList(ctx, deps, ctx.match.trim());
  });

  bot.command("resume", async (ctx) => {
    const threadId = ctx.match.trim();
    if (!threadId) {
      await ctx.reply("用法: /resume <threadId>");
      return;
    }
    await resumeThreadIntoTopic(ctx, deps, threadId);
  });

  bot.command(["newthread", "new"], async (ctx) => {
    await createFreshThreadTopic(ctx, deps, ctx.match.trim());
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
    await refreshTopicStatusPin(bot, store, session, logger);
    logger?.info("updated telegram topic name from service message", {
      ...contextLogFields(ctx),
      sessionKey,
      topicName,
      codexThreadId: session.codexThreadId,
    });
  });
}

async function replyProjectThreadList(ctx: ProjectCommandContext, deps: BotHandlerDeps, searchTerm: string): Promise<void> {
  const { bot, projects, gateway, logger } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const threads = await safeCall(() => listProjectThreads(gateway, project, searchTerm));
  if (threads instanceof Error) {
    logger?.warn("list project threads failed", {
      ...contextLogFields(ctx),
      project: project.name,
      projectRoot: project.cwd,
      searchTerm: searchTerm || null,
      error: threads,
    });
    await ctx.reply(`读取 thread 列表失败: ${threads.message}`);
    return;
  }

  await sendHtmlChunks(
    bot,
    {
      chatId: ctx.chat.id,
      messageThreadId: ctx.message?.message_thread_id ?? null,
      text: formatThreadList(project, threads),
    },
    logger,
  );
}

async function resumeThreadIntoTopic(
  ctx: ProjectCommandContext,
  deps: BotHandlerDeps,
  threadId: string,
): Promise<void> {
  const { bot, config, store, projects, gateway, logger } = deps;
  const project = getProjectForContext(ctx, projects);
  if (!project) {
    await ctx.reply(PROJECT_REQUIRED_MESSAGE);
    return;
  }

  const thread = await safeCall(() => gateway.readThread(threadId, false));
  if (thread instanceof Error) {
    logger?.warn("read thread failed", {
      ...contextLogFields(ctx),
      threadId,
      error: thread,
    });
    await ctx.reply(`读取 thread 失败: ${thread.message}`);
    return;
  }
  if (!isPathWithinRoot(thread.cwd, project.cwd)) {
    await ctx.reply(
      [
        "这个 thread 不属于当前项目。",
        `project root: ${project.cwd}`,
        `thread cwd: ${thread.cwd}`,
      ].join("\n"),
    );
    return;
  }

  const existingBinding = store.getByThreadId(thread.id);
  if (existingBinding) {
    if (existingBinding.chatId === String(ctx.chat.id) && existingBinding.messageThreadId == null) {
      store.setThread(existingBinding.sessionKey, null);
    } else {
      await ctx.reply(formatExistingThreadBinding(thread.id, existingBinding));
      return;
    }
  }

  const topicName = formatTopicName(thread.name, thread.preview, "Resumed Thread");
  const forumTopic = await safeCall(() => bot.api.createForumTopic(ctx.chat.id, topicName));
  if (forumTopic instanceof Error) {
    logger?.error("create forum topic for resume failed", {
      ...contextLogFields(ctx),
      topicName,
      threadId: thread.id,
      error: forumTopic,
    });
    await ctx.reply(`创建 topic 失败: ${forumTopic.message}`);
    return;
  }

  const session = ensureTopicSession({
    store,
    config,
    project,
    chatId: ctx.chat.id,
    messageThreadId: forumTopic.message_thread_id,
    topicName: forumTopic.name,
  });

  const resumed = await safeCall(() =>
    gateway.resumeThread(thread.id, {
      cwd: thread.cwd,
      model: session.model,
      sandboxMode: session.sandboxMode,
      approvalPolicy: session.approvalPolicy,
      reasoningEffort: session.reasoningEffort,
    }),
  );
  if (resumed instanceof Error) {
    logger?.error("resume thread failed", {
      ...contextLogFields(ctx),
      ...sessionLogFields(session),
      threadId: thread.id,
      error: resumed,
    });
    await ctx.reply(`恢复 thread 失败: ${resumed.message}`);
    return;
  }

  store.setThread(session.sessionKey, thread.id);
  syncSessionFromCodexRuntime(store, session.sessionKey, resumed);
  store.setCwd(session.sessionKey, thread.cwd);
  const latestSession = await refreshTopicStatusPin(bot, store, session, logger);
  logger?.info("thread resumed into topic", {
    ...contextLogFields(ctx),
    ...sessionLogFields(latestSession),
    threadId: thread.id,
    threadCwd: thread.cwd,
    topicName: forumTopic.name,
  });
  await postTopicReadyMessage(bot, session, formatThreadResumeResult(thread, forumTopic.name));
  await ctx.reply(formatThreadResumeAck(thread, forumTopic.name, forumTopic.message_thread_id));
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

  const topicName = formatTopicName(requestedName, "", "New Thread");
  const forumTopic = await safeCall(() => bot.api.createForumTopic(ctx.chat.id, topicName));
  if (forumTopic instanceof Error) {
    logger?.error("create forum topic for new thread failed", {
      ...contextLogFields(ctx),
      topicName,
      error: forumTopic,
    });
    await ctx.reply(`创建 topic 失败: ${forumTopic.message}`);
    return;
  }

  const session = ensureTopicSession({
    store,
    config,
    project,
    chatId: ctx.chat.id,
    messageThreadId: forumTopic.message_thread_id,
    topicName: forumTopic.name,
  });

  store.setThread(session.sessionKey, null);
  store.setCwd(session.sessionKey, project.cwd);
  await refreshTopicStatusPin(bot, store, session, logger);
  logger?.info("new topic created for fresh thread", {
    ...contextLogFields(ctx),
    ...sessionLogFields(session),
    topicName: forumTopic.name,
    project: project.name,
    projectRoot: project.cwd,
  });

  await postTopicReadyMessage(
    bot,
    session,
    [
      "新 topic 已创建。",
      "首条消息会在这里创建一个新的 Codex thread。",
      `project: ${project.name}`,
      `cwd: ${project.cwd}`,
      "普通文本如果没有送达 bot，可以先用 /ask <内容>。",
    ].join("\n"),
  );
  await ctx.reply(`已创建 topic: ${forumTopic.name}\ntopic id: ${forumTopic.message_thread_id}`);
}
