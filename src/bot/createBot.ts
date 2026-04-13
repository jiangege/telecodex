import { Bot } from "grammy";
import type { AppConfig, SessionMode } from "../config.js";
import { assertAllowedCwd } from "../config.js";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { ServerNotification } from "../generated/codex-app-server/index.js";
import { ApprovalManager } from "../codex/approvals.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { authMiddleware } from "./auth.js";
import { numericChatId, numericMessageThreadId, sessionFromContext } from "./session.js";

export function createBot(input: {
  config: AppConfig;
  store: SessionStore;
  gateway: CodexGateway;
  bootstrapCode: string | null;
}): Bot {
  const { config, store, gateway, bootstrapCode } = input;
  const bot = new Bot(config.telegramBotToken);
  const buffers = new MessageBuffer(bot, config.updateIntervalMs);
  const approvals = new ApprovalManager(bot, gateway, store);

  bot.use(
    authMiddleware({
      bootstrapCode,
      store,
    }),
  );

  gateway.onNotification((event) => {
    void handleCodexNotification(event, store, buffers);
  });
  gateway.onServerRequest((request) => {
    void approvals.handleServerRequest(request);
  });

  bot.command(["start", "help"], async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    await ctx.reply(
      [
        "telecodex 已启动。",
        "",
        `当前目录: ${session.cwd}`,
        `模式: ${session.mode}`,
        `模型: ${session.model}`,
        "",
        "/new 新建会话",
        "/status 查看状态",
        "/stop 中断当前任务",
        "/cwd <path> 设置工作目录",
        "/mode read|write 切换读写模式",
        "/model <id> 设置模型",
      ].join("\n"),
    );
  });

  bot.command("status", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    const account = await safeCall(() => gateway.account());
    const rateLimits = await safeCall(() => gateway.rateLimits());
    await ctx.reply(
      [
        "状态",
        `thread: ${session.codexThreadId ?? "未创建"}`,
        `active turn: ${session.activeTurnId ?? "无"}`,
        `cwd: ${session.cwd}`,
        `mode: ${session.mode}`,
        `model: ${session.model}`,
        `account: ${formatAccount(account)}`,
        `rate: ${formatRateLimits(rateLimits)}`,
      ].join("\n"),
    );
  });

  bot.command("new", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    store.setThread(session.sessionKey, null);
    await ctx.reply("已断开当前 Telegram 会话和 Codex thread 的绑定。下一条消息会创建新 thread。");
  });

  bot.command("stop", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    if (!session.codexThreadId || !session.activeTurnId) {
      await ctx.reply("当前没有正在运行的 Codex turn。");
      return;
    }
    await gateway.interruptTurn(session.codexThreadId, session.activeTurnId);
    store.setActiveTurn(session.sessionKey, null);
    await ctx.reply("已请求中断当前 turn。");
  });

  bot.command("cwd", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    const cwd = ctx.match.trim();
    if (!cwd) {
      await ctx.reply(`当前目录: ${session.cwd}`);
      return;
    }
    try {
      const allowed = assertAllowedCwd(cwd, config.allowedCwds);
      store.setCwd(session.sessionKey, allowed);
      await ctx.reply(`已设置 cwd:\n${allowed}`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
    }
  });

  bot.command("mode", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    const mode = ctx.match.trim() as SessionMode;
    if (mode !== "read" && mode !== "write") {
      await ctx.reply(`当前模式: ${session.mode}\n用法: /mode read 或 /mode write`);
      return;
    }
    store.setMode(session.sessionKey, mode);
    await ctx.reply(`已切换到 ${mode} 模式。`);
  });

  bot.command("model", async (ctx) => {
    const session = sessionFromContext(ctx, store, config);
    const model = ctx.match.trim();
    if (!model) {
      await ctx.reply(`当前模型: ${session.model}`);
      return;
    }
    store.setModel(session.sessionKey, model);
    await ctx.reply(`已设置模型: ${model}`);
  });

  bot.on("callback_query:data", async (ctx) => {
    const handled = await approvals.handleCallback(ctx);
    if (!handled) await ctx.answerCallbackQuery();
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    const session = sessionFromContext(ctx, store, config);
    await handleUserText({ text, session, store, gateway, buffers, bot });
  });

  return bot;
}

async function handleUserText(input: {
  text: string;
  session: TelegramSession;
  store: SessionStore;
  gateway: CodexGateway;
  buffers: MessageBuffer;
  bot: Bot;
}): Promise<void> {
  const { text, session, store, gateway, buffers, bot } = input;
  if (session.activeTurnId) {
    const messageThreadId = numericMessageThreadId(session);
    await bot.api.sendMessage(numericChatId(session), "当前 Codex 任务还在运行。先用 /stop 中断，或者等它完成。", {
      ...(messageThreadId == null ? {} : { message_thread_id: messageThreadId }),
    });
    return;
  }

  let threadId = session.codexThreadId;
  if (!threadId) {
    const started = await gateway.startThread({ cwd: session.cwd, model: session.model, mode: session.mode });
    threadId = started.thread.id;
    store.setThread(session.sessionKey, threadId);
  } else {
    await gateway.resumeThread(threadId, { cwd: session.cwd, model: session.model, mode: session.mode });
  }

  const bufferKey = turnBufferKey(threadId, "pending");
  const messageId = await buffers.create(bufferKey, {
    chatId: numericChatId(session),
    messageThreadId: numericMessageThreadId(session),
  });
  store.setOutputMessage(session.sessionKey, messageId);

  try {
    const turn = await gateway.startTurn({
      threadId,
      text,
      cwd: session.cwd,
      model: session.model,
      mode: session.mode,
    });
    const turnId = turn.turn.id;
    store.setActiveTurn(session.sessionKey, turnId);
    buffers.rename(bufferKey, turnBufferKey(threadId, turnId));
  } catch (error) {
    await buffers.fail(bufferKey, error instanceof Error ? error.message : String(error));
  }
}

async function handleCodexNotification(
  event: ServerNotification,
  store: SessionStore,
  buffers: MessageBuffer,
): Promise<void> {
  if (event.method === "item/agentMessage/delta") {
    buffers.append(turnBufferKey(event.params.threadId, event.params.turnId), event.params.delta);
    return;
  }

  if (event.method === "item/completed") {
    const item = event.params.item;
    if (item.type === "agentMessage") {
      await buffers.complete(turnBufferKey(event.params.threadId, event.params.turnId), item.text);
    }
    return;
  }

  if (event.method === "turn/completed") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      store.setActiveTurn(session.sessionKey, null);
      store.setOutputMessage(session.sessionKey, null);
    }
    return;
  }

  if (event.method === "error") {
    process.stderr.write(`[codex error] ${JSON.stringify(event.params)}\n`);
  }
}

function turnBufferKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

async function safeCall<T>(call: () => Promise<T>): Promise<T | Error> {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function formatAccount(value: unknown): string {
  if (value instanceof Error) return `error: ${value.message}`;
  const account = value as { account?: { type?: string; email?: string; planType?: string } | null } | null;
  if (!account?.account) return "未登录或不需要登录";
  return [account.account.type, account.account.email, account.account.planType].filter(Boolean).join(" / ");
}

function formatRateLimits(value: unknown): string {
  if (value instanceof Error) return `error: ${value.message}`;
  const limits = value as { rateLimits?: { primary?: { usedPercent?: number } | null; secondary?: { usedPercent?: number } | null } } | null;
  if (!limits?.rateLimits) return "未知";
  const primary = limits.rateLimits.primary?.usedPercent;
  const secondary = limits.rateLimits.secondary?.usedPercent;
  return `primary ${primary ?? "?"}%, secondary ${secondary ?? "?"}%`;
}
