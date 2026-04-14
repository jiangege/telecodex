import { presetFromProfile } from "../../config.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { formatActiveBlockerSummary, formatInputTargetForStatus, getSessionInputState } from "../inputTarget.js";
import { handleUserText, refreshSessionIfActiveTurnIsStale } from "../inputService.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  formatAccount,
  formatHelpText,
  formatPrivateStatus,
  formatProjectStatus,
  formatRateLimits,
  formatReasoningEffort,
  formatThreadPathSummary,
  formatTurnDeliveryStats,
  getProjectForContext,
  getScopedSession,
  hasTopicContext,
  isPrivateChat,
  isYoloEnabled,
  parseSubcommand,
  safeCall,
} from "../commandSupport.js";
import { formatIsoTimestamp, refreshTopicStatusPin, sessionLogFields } from "../sessionFlow.js";
import { formatTerminalSummary, handleTerminalCommand } from "../terminalBridge.js";

export function registerOperationalHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, gateway, buffers, logger } = deps;

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
    const queuedPreview = store.listQueuedInputs(latestSession.sessionKey, 3);
    const terminalSummary = formatTerminalSummary(store, latestSession.sessionKey);
    const inputState = getSessionInputState(store, latestSession);
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
        `input target: ${formatInputTargetForStatus(inputState)}`,
        `input summary: ${inputState.summary}`,
        `active blocker: ${formatActiveBlockerSummary(inputState)}`,
        `pending blockers: ${inputState.pendingBlockers}`,
        `queue: ${queueDepth}`,
        `queue next: ${formatQueuedPreview(queuedPreview)}`,
        `tty: ${terminalSummary}`,
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

  bot.command("queue", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      const queued = store.listQueuedInputs(session.sessionKey, 5);
      const queueDepth = store.getQueuedInputCount(session.sessionKey);
      const inputState = getSessionInputState(store, session);
      await ctx.reply(
        [
          "队列",
          `state: ${formatSessionRuntimeStatus(session.runtimeStatus)}`,
          `active turn: ${session.activeTurnId ?? "无"}`,
          `input target: ${formatInputTargetForStatus(inputState)}`,
          `input summary: ${inputState.summary}`,
          `queue: ${queueDepth}`,
          queued.length > 0 ? `items:\n${formatQueuedItems(queued)}` : "items: 空",
          "用法: /queue | /queue drop <id> | /queue clear",
        ].join("\n"),
      );
      return;
    }

    if (command === "clear") {
      const removed = store.clearQueuedInputs(session.sessionKey);
      await refreshTopicStatusPin(bot, store, session, logger);
      await ctx.reply(`已清空队列，删除 ${removed} 条待处理消息。`);
      return;
    }

    if (command === "drop") {
      const id = Number(args);
      if (!Number.isInteger(id) || id <= 0) {
        await ctx.reply("用法: /queue drop <id>");
        return;
      }
      const removed = store.removeQueuedInputForSession(session.sessionKey, id);
      await refreshTopicStatusPin(bot, store, session, logger);
      await ctx.reply(removed ? `已移除队列项 #${id}。` : `没有找到队列项 #${id}。`);
      return;
    }

    await ctx.reply("用法: /queue | /queue drop <id> | /queue clear");
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

  bot.command("tty", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    await handleTerminalCommand({
      ctx,
      session,
      store,
      gateway,
      ...(logger ? { logger } : {}),
    });
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
}

function formatQueuedPreview(items: Array<{ text: string }>): string {
  if (items.length === 0) return "空";
  return items.map((item) => singleLinePreview(item.text)).join(" | ");
}

function formatQueuedItems(items: Array<{ id: number; text: string; createdAt: string }>): string {
  return items.map((item) => `#${item.id} ${singleLinePreview(item.text)} (${formatIsoTimestamp(item.createdAt)})`).join("\n");
}

function singleLinePreview(text: string, maxLength = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
