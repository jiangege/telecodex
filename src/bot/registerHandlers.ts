import type { Bot } from "grammy";
import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  isSessionApprovalPolicy,
  isSessionModePreset,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  presetFromProfile,
  profileFromPreset,
  type AppConfig,
} from "../config.js";
import type { CodexGateway } from "../codex/CodexGateway.js";
import { ApprovalManager } from "../codex/approvals.js";
import type { ProjectStore } from "../store/projects.js";
import type { SessionStore } from "../store/sessions.js";
import { sendHtmlChunks } from "../telegram/delivery.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import type { Logger } from "../runtime/logger.js";
import { formatSessionRuntimeStatus } from "../runtime/sessionRuntime.js";
import { handleUserText, refreshSessionIfActiveTurnIsStale } from "./inputService.js";
import {
  assertProjectScopedPath,
  contextLogFields,
  ensureTopicSession,
  formatAccount,
  formatExistingThreadBinding,
  formatHelpText,
  formatPrivateProjectList,
  formatPrivateStatus,
  formatProfileReply,
  formatProjectStatus,
  formatRateLimits,
  formatReasoningEffort,
  formatThreadList,
  formatThreadPathSummary,
  formatThreadResumeAck,
  formatThreadResumeResult,
  formatTurnDeliveryStats,
  formatTopicName,
  getProjectForContext,
  getScopedSession,
  hasTopicContext,
  isPathWithinRoot,
  isPrivateChat,
  isSupergroupChat,
  isYoloEnabled,
  listProjectThreads,
  parseSubcommand,
  postTopicReadyMessage,
  resolveExistingDirectory,
  safeCall,
} from "./commandSupport.js";
import { formatIsoTimestamp, refreshTopicStatusPin, sessionLogFields, syncSessionFromCodexRuntime } from "./sessionFlow.js";

export function registerHandlers(input: {
  bot: Bot;
  approvals: ApprovalManager;
  config: AppConfig;
  store: SessionStore;
  projects: ProjectStore;
  gateway: CodexGateway;
  buffers: MessageBuffer;
  logger?: Logger;
}): void {
  const { bot, approvals, config, store, projects, gateway, buffers, logger } = input;

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(formatHelpText(ctx, projects));
  });

  bot.command("status", async (ctx) => {
    if (isPrivateChat(ctx)) {
      await ctx.reply(formatPrivateStatus(store, projects));
      return;
    }

    const project = getProjectForContext(ctx, projects);
    if (!project) {
      await ctx.reply("当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
      return;
    }

    if (!hasTopicContext(ctx)) {
      await ctx.reply(formatProjectStatus(project));
      return;
    }

    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const latestSession = await refreshTopicStatusPin(bot, store, session, logger);
    const threadDetails =
      latestSession.codexThreadId == null ? null : await safeCall(() => gateway.readThread(latestSession.codexThreadId!, false));
    const deliveryStats = latestSession.codexThreadId ? store.getTurnDeliveryStatsForThread(latestSession.codexThreadId) : null;
    const queueDepth = store.getQueuedInputCount(latestSession.sessionKey);
    const account = await safeCall(() => gateway.account());
    const rateLimits = await safeCall(() => gateway.rateLimits());
    await ctx.reply(
      [
        "状态",
        `project: ${project.name}`,
        `root: ${project.cwd}`,
        `thread: ${latestSession.codexThreadId ?? "待创建"}`,
        `thread path: ${formatThreadPathSummary(threadDetails, latestSession.codexThreadId)}`,
        `state: ${formatSessionRuntimeStatus(latestSession.runtimeStatus)}`,
        `state detail: ${latestSession.runtimeStatusDetail ?? "无"}`,
        `state updated: ${formatIsoTimestamp(latestSession.runtimeStatusUpdatedAt)}`,
        `active turn: ${latestSession.activeTurnId ?? "无"}`,
        `queue: ${queueDepth}`,
        `cwd: ${latestSession.cwd}`,
        `preset: ${presetFromProfile(latestSession)}`,
        `sandbox: ${latestSession.sandboxMode}`,
        `approval: ${latestSession.approvalPolicy}`,
        `model: ${latestSession.model}`,
        `effort: ${formatReasoningEffort(latestSession.reasoningEffort)}`,
        `yolo: ${isYoloEnabled(latestSession) ? "on" : "off"}`,
        `deliveries: ${formatTurnDeliveryStats(deliveryStats)}`,
        `account: ${formatAccount(account)}`,
        `rate: ${formatRateLimits(rateLimits)}`,
      ].join("\n"),
    );
  });

  bot.command("ask", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply("用法: /ask <内容>");
      return;
    }
    logger?.info("received telegram ask command", {
      ...contextLogFields(ctx),
      textLength: text.length,
      sessionKey: session.sessionKey,
      codexThreadId: session.codexThreadId,
    });
    await handleUserText({
      text,
      session,
      store,
      gateway,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  });

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
      await ctx.reply(project ? formatProjectStatus(project) : "当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
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
      const project = getProjectForContext(ctx, projects);
      if (!project) {
        await ctx.reply("当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
        return;
      }
      const threads = await safeCall(() => listProjectThreads(gateway, project, args));
      if (threads instanceof Error) {
        logger?.warn("list project threads failed", {
          ...contextLogFields(ctx),
          project: project.name,
          projectRoot: project.cwd,
          searchTerm: args || null,
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
      return;
    }

    if (command === "resume") {
      const project = getProjectForContext(ctx, projects);
      if (!project) {
        await ctx.reply("当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
        return;
      }
      if (!args) {
        await ctx.reply("用法: /thread resume <threadId>");
        return;
      }

      const thread = await safeCall(() => gateway.readThread(args, false));
      if (thread instanceof Error) {
        logger?.warn("read thread failed", {
          ...contextLogFields(ctx),
          threadId: args,
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
      return;
    }

    if (command === "new") {
      const project = getProjectForContext(ctx, projects);
      if (!project) {
        await ctx.reply("当前 supergroup 还没有绑定项目。\n先执行 /project bind <绝对路径>");
        return;
      }

      const topicName = formatTopicName(args, "", "New Thread");
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
      return;
    }

    await ctx.reply("用法:\n/thread list [关键词]\n/thread resume <threadId>\n/thread new <topic 名称>");
  });

  bot.command("stop", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    if (session.runtimeStatus === "preparing" && !session.activeTurnId) {
      await ctx.reply("当前请求还在准备阶段，尚未拿到可中断的 turn。等几秒后再试 /stop。");
      return;
    }
    if (!session.codexThreadId || !session.activeTurnId) {
      await ctx.reply("当前没有正在运行的 Codex turn。");
      return;
    }
    try {
      await gateway.interruptTurn(session.codexThreadId, session.activeTurnId);
      await ctx.reply("已请求中断当前 turn，等待 Codex 确认停止。");
    } catch (error) {
      logger?.warn("interrupt turn failed", {
        ...contextLogFields(ctx),
        ...sessionLogFields(session),
        error,
      });
      const latest = await refreshSessionIfActiveTurnIsStale(session, store, gateway, buffers, bot, logger);
      if (!latest.activeTurnId) {
        await ctx.reply("当前 turn 已结束，本地状态已同步。");
        return;
      }
      await ctx.reply(`中断失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("cwd", async (ctx) => {
    const project = getProjectForContext(ctx, projects);
    const session = getScopedSession(ctx, store, projects, config);
    if (!project || !session) return;
    const cwd = ctx.match.trim();
    if (!cwd) {
      await ctx.reply(`当前目录: ${session.cwd}\n项目根目录: ${project.cwd}`);
      return;
    }
    try {
      const allowed = assertProjectScopedPath(cwd, project.cwd);
      store.setCwd(session.sessionKey, allowed);
      await refreshTopicStatusPin(bot, store, session, logger);
      await ctx.reply(`已设置 cwd:\n${allowed}`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
    }
  });

  bot.command("mode", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const preset = ctx.match.trim();
    if (!preset) {
      await ctx.reply(
        [
          `当前预设: ${presetFromProfile(session)}`,
          `sandbox: ${session.sandboxMode}`,
          `approval: ${session.approvalPolicy}`,
          `用法: /mode ${MODE_PRESETS.join("|")}`,
        ].join("\n"),
      );
      return;
    }
    if (!isSessionModePreset(preset)) {
      await ctx.reply(`无效预设。\n用法: /mode ${MODE_PRESETS.join("|")}`);
      return;
    }
    const profile = profileFromPreset(preset);
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(formatProfileReply("已切换预设。", profile.sandboxMode, profile.approvalPolicy));
  });

  bot.command("sandbox", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const sandboxMode = ctx.match.trim();
    if (!sandboxMode) {
      await ctx.reply(`当前 sandbox: ${session.sandboxMode}\n用法: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }
    if (!isSessionSandboxMode(sandboxMode)) {
      await ctx.reply(`无效 sandbox。\n用法: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }
    store.setSandboxMode(session.sessionKey, sandboxMode);
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(formatProfileReply("已更新 sandbox。", sandboxMode, session.approvalPolicy));
  });

  bot.command("approval", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const approvalPolicy = ctx.match.trim();
    if (!approvalPolicy) {
      await ctx.reply(`当前 approval: ${session.approvalPolicy}\n用法: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }
    if (!isSessionApprovalPolicy(approvalPolicy)) {
      await ctx.reply(`无效 approval policy。\n用法: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }
    store.setApprovalPolicy(session.sessionKey, approvalPolicy);
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(formatProfileReply("已更新 approval policy。", session.sandboxMode, approvalPolicy));
  });

  bot.command("yolo", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      const enabled = session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
      await ctx.reply(`当前 yolo: ${enabled ? "on" : "off"}\n用法: /yolo on 或 /yolo off`);
      return;
    }
    if (value !== "on" && value !== "off") {
      await ctx.reply("用法: /yolo on 或 /yolo off");
      return;
    }
    const profile = profileFromPreset(value === "on" ? "yolo" : "write");
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(
      formatProfileReply(
        value === "on" ? "已开启 yolo。" : "已关闭 yolo，恢复到 write 预设。",
        profile.sandboxMode,
        profile.approvalPolicy,
      ),
    );
  });

  bot.command("model", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const model = ctx.match.trim();
    if (!model) {
      await ctx.reply(`当前模型: ${session.model}`);
      return;
    }
    store.setModel(session.sessionKey, model);
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(`已设置模型: ${model}`);
  });

  bot.command("effort", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;
    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`当前思考程度: ${formatReasoningEffort(session.reasoningEffort)}\n用法: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }
    if (value !== "default" && !isSessionReasoningEffort(value)) {
      await ctx.reply(`无效思考程度。\n用法: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }
    if (value === "default") {
      store.setReasoningEffort(session.sessionKey, null);
    } else {
      store.setReasoningEffort(session.sessionKey, value);
    }
    await refreshTopicStatusPin(bot, store, session, logger);
    await ctx.reply(`已设置思考程度: ${value === "default" ? "codex-default" : value}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const handled = await approvals.handleCallback(ctx);
    if (!handled) await ctx.answerCallbackQuery();
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

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    logger?.info("received telegram text message", {
      ...contextLogFields(ctx),
      textLength: text.length,
      isCommand: text.startsWith("/"),
    });
    if (text.startsWith("/")) return;
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) {
      logger?.warn("ignored telegram text message because no scoped session was available", {
        ...contextLogFields(ctx),
        textLength: text.length,
      });
      return;
    }
    await handleUserText({
      text,
      session,
      store,
      gateway,
      buffers,
      bot,
      ...(logger ? { logger } : {}),
    });
  });
}
