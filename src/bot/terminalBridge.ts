import type { Context } from "grammy";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { TerminalInteractionNotification } from "../generated/codex-app-server/v2/TerminalInteractionNotification.js";
import type { Logger } from "../runtime/logger.js";
import { makeSessionKey, type PendingInteraction, type SessionStore, type TelegramSession } from "../store/sessions.js";
import { truncateSingleLine } from "./sessionFlow.js";

const TERMINAL_INTERACTION_PREFIX = "terminal:";

interface PendingTerminalInteraction {
  threadId: string;
  turnId: string;
  itemId: string;
  processId: string;
  stdin: string;
}

export function recordTerminalInteraction(
  store: SessionStore,
  sessionKey: string,
  params: TerminalInteractionNotification,
): "new" | "updated" | "unchanged" {
  const existing = getPendingTerminalInteraction(store, sessionKey);
  if (
    existing &&
    existing.payload.processId === params.processId &&
    existing.payload.stdin === params.stdin &&
    existing.payload.turnId === params.turnId
  ) {
    return "unchanged";
  }
  store.putPendingInteraction({
    interactionId: `${TERMINAL_INTERACTION_PREFIX}${sessionKey}`,
    sessionKey,
    kind: "terminal_stdin",
    requestJson: JSON.stringify(params),
  });
  return existing ? "updated" : "new";
}

export function getPendingTerminalInteraction(
  store: SessionStore,
  sessionKey: string,
): { interaction: PendingInteraction; payload: PendingTerminalInteraction } | null {
  const interaction = store.getOldestPendingInteractionForSession(sessionKey, ["terminal_stdin"]);
  if (!interaction) return null;
  try {
    const payload = JSON.parse(interaction.requestJson) as PendingTerminalInteraction;
    if (!payload.processId || !payload.threadId || !payload.turnId) {
      return null;
    }
    return {
      interaction,
      payload,
    };
  } catch {
    return null;
  }
}

export function clearPendingTerminalInteraction(
  store: SessionStore,
  sessionKey: string,
  processId?: string | null,
): boolean {
  const current = getPendingTerminalInteraction(store, sessionKey);
  if (!current) return false;
  if (processId && current.payload.processId !== processId) return false;
  store.removePendingInteractionsForSessionKinds(sessionKey, ["terminal_stdin"]);
  return true;
}

export async function handleTerminalTextReply(input: {
  ctx: Context;
  store: SessionStore;
  gateway: CodexGateway;
  logger?: Logger;
}): Promise<boolean> {
  const { ctx, store, gateway, logger } = input;
  const text = ctx.message?.text?.trim();
  const chatId = ctx.chat?.id;
  const messageThreadId = ctx.message?.message_thread_id ?? null;
  if (!text || chatId == null || messageThreadId == null) return false;

  const sessionKey = makeSessionKey(chatId, messageThreadId);
  const current = getPendingTerminalInteraction(store, sessionKey);
  if (!current) return false;

  try {
    await gateway.writeTerminalInput(current.payload.processId, {
      text: `${text}\n`,
    });
    logger?.info("forwarded telegram text to terminal stdin", {
      sessionKey,
      threadId: current.payload.threadId,
      turnId: current.payload.turnId,
      processId: current.payload.processId,
      textLength: text.length,
    });
    await ctx.reply("已发送到终端 stdin。");
  } catch (error) {
    logger?.warn("failed to forward telegram text to terminal stdin", {
      sessionKey,
      threadId: current.payload.threadId,
      turnId: current.payload.turnId,
      processId: current.payload.processId,
      error,
    });
    await ctx.reply(`发送到终端失败: ${error instanceof Error ? error.message : String(error)}`);
  }

  return true;
}

export async function handleTerminalCommand(input: {
  ctx: Context;
  session: TelegramSession;
  store: SessionStore;
  gateway: CodexGateway;
  logger?: Logger;
}): Promise<void> {
  const { ctx, session, store, gateway, logger } = input;
  const rawMatch = typeof ctx.match === "string" ? ctx.match : "";
  const raw = rawMatch.trim();
  const [command = "status", ...rest] = raw.split(/\s+/).filter(Boolean);
  const current = getPendingTerminalInteraction(store, session.sessionKey);

  if (!current) {
    await ctx.reply("当前没有等待输入的终端进程。");
    return;
  }

  if (command === "status") {
    await ctx.reply(formatTerminalStatus(current.payload));
    return;
  }

  if (command === "ctrlc") {
    try {
      await gateway.writeTerminalInput(current.payload.processId, { text: "\u0003" });
      logger?.info("sent ctrl-c to terminal process", {
        sessionKey: session.sessionKey,
        processId: current.payload.processId,
      });
      await ctx.reply("已发送 Ctrl+C。");
    } catch (error) {
      await ctx.reply(`发送 Ctrl+C 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (command === "close") {
    try {
      await gateway.writeTerminalInput(current.payload.processId, { closeStdin: true });
      clearPendingTerminalInteraction(store, session.sessionKey, current.payload.processId);
      await ctx.reply("已关闭该进程的 stdin。");
    } catch (error) {
      await ctx.reply(`关闭 stdin 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (command === "terminate") {
    try {
      await gateway.terminateTerminalProcess(current.payload.processId);
      clearPendingTerminalInteraction(store, session.sessionKey, current.payload.processId);
      await ctx.reply("已终止该终端进程。");
    } catch (error) {
      await ctx.reply(`终止进程失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (command === "send") {
    const text = rest.join(" ").trim();
    if (!text) {
      await ctx.reply("用法: /tty send <文本>");
      return;
    }
    try {
      await gateway.writeTerminalInput(current.payload.processId, { text: `${text}\n` });
      await ctx.reply("已发送到终端 stdin。");
    } catch (error) {
      await ctx.reply(`发送到终端失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  await ctx.reply("用法: /tty [status|ctrlc|close|terminate|send <文本>]");
}

export function formatTerminalSummary(store: SessionStore, sessionKey: string): string {
  const current = getPendingTerminalInteraction(store, sessionKey);
  if (!current) return "无";
  return `${current.payload.processId} | ${truncateSingleLine(current.payload.stdin, 48)}`;
}

function formatTerminalStatus(payload: PendingTerminalInteraction): string {
  return [
    "终端输入桥接",
    `thread: ${payload.threadId}`,
    `turn: ${payload.turnId}`,
    `item: ${payload.itemId}`,
    `process: ${payload.processId}`,
    `prompt: ${truncateSingleLine(payload.stdin, 200)}`,
    "直接发普通文本会写入 stdin。",
    "用法: /tty [status|ctrlc|close|terminate|send <文本>]",
  ].join("\n");
}
