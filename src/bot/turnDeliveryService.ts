import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { ThreadItem } from "../generated/codex-app-server/v2/ThreadItem.js";
import type { Turn } from "../generated/codex-app-server/v2/Turn.js";
import type { Logger } from "../runtime/logger.js";
import { applySessionRuntimeEvent, projectSessionRuntimeState, runtimeEventFromTurn } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession, TurnDelivery } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { replaceOrSendHtmlChunks, sendPlainChunks } from "../telegram/delivery.js";
import { renderMarkdownForTelegram, renderPlainChunksForTelegram } from "../telegram/renderer.js";
import { resolveTurnBufferKey, sessionLogFields, shouldHeartbeatSession, turnBufferKey } from "./sessionFlow.js";

const TURN_DELIVERY_RETRY_DELAYS_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const MAX_TURN_DELIVERY_FAILURES = TURN_DELIVERY_RETRY_DELAYS_MS.length;
const TURN_DELIVERY_STALE_AFTER_MS = 10 * 60_000;

export async function recoverPendingTurnDeliveries(
  store: SessionStore,
  gateway: CodexGateway,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const now = Date.now();
  const deliveries = store.listRetryableTurnDeliveries(
    new Date(now).toISOString(),
    MAX_TURN_DELIVERY_FAILURES,
    new Date(now - TURN_DELIVERY_STALE_AFTER_MS).toISOString(),
  );
  if (deliveries.length === 0) {
    await notifyExhaustedTurnDeliveryFailures(store, bot, logger);
    return;
  }

  logger?.info("recovering pending turn deliveries", {
    retryableTurnDeliveries: deliveries.length,
  });

  for (const delivery of deliveries) {
    try {
      const thread = await gateway.readThread(delivery.threadId, true);
      const turn = thread.turns.find((item) => item.id === delivery.turnId) ?? null;
      if (!turn) {
        await recordTurnDeliveryFailure(store, bot, delivery.turnId, "Turn is missing from Codex thread", logger);
        logger?.warn("pending turn delivery turn is missing from thread", {
          turnId: delivery.turnId,
          threadId: delivery.threadId,
          sessionKey: delivery.sessionKey,
        });
        continue;
      }

      const threadStillRunning = thread.status.type === "active";
      const turnStillRunning = turn.status === "inProgress";
      if (threadStillRunning || turnStillRunning) {
        continue;
      }

      const session = store.get(delivery.sessionKey);
      try {
        await finalizeTurnResult({
          threadId: delivery.threadId,
          turn,
          session,
          store,
          bot,
          logger,
        });
      } catch (error) {
        logger?.warn("failed to recover pending turn delivery", {
          turnId: delivery.turnId,
          threadId: delivery.threadId,
          sessionKey: delivery.sessionKey,
          error,
        });
      }

      if (session) {
        store.setOutputMessage(session.sessionKey, null);
        await applySessionRuntimeEvent({
          bot,
          store,
          sessionKey: session.sessionKey,
          event: runtimeEventFromTurn(turn),
          logger,
        });
      }
    } catch (error) {
      await recordTurnDeliveryFailure(store, bot, delivery.turnId, describeError(error), logger);
      logger?.warn("failed to inspect thread while recovering pending turn delivery", {
        turnId: delivery.turnId,
        threadId: delivery.threadId,
        sessionKey: delivery.sessionKey,
        error,
      });
    }
  }

  await notifyExhaustedTurnDeliveryFailures(store, bot, logger);
}

export async function refreshLiveSessionHeartbeats(
  store: SessionStore,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const nowIso = new Date().toISOString();
  for (const session of store.listTopicSessions()) {
    if (!shouldHeartbeatSession(session, nowIso)) continue;
    store.setRuntimeState(session.sessionKey, {
      status: session.runtimeStatus,
      detail: session.runtimeStatusDetail,
      updatedAt: nowIso,
      activeTurnId: session.activeTurnId,
    });
    await projectSessionRuntimeState(bot, store, session.sessionKey, logger);
  }
}

export function backfillTurnDeliveryFromSession(store: SessionStore, session: TelegramSession): TurnDelivery | null {
  if (!session.activeTurnId || !session.codexThreadId || session.outputMessageId == null) {
    return session.activeTurnId ? store.getTurnDelivery(session.activeTurnId) : null;
  }

  const existing = store.getTurnDelivery(session.activeTurnId);
  if (existing) return existing;

  return store.upsertTurnDelivery({
    turnId: session.activeTurnId,
    threadId: session.codexThreadId,
    sessionKey: session.sessionKey,
    chatId: session.chatId,
    messageThreadId: session.messageThreadId,
    outputMessageId: session.outputMessageId,
  });
}

export async function hydrateTurn(
  gateway: CodexGateway,
  threadId: string,
  turnId: string,
  logger?: Logger,
): Promise<Turn | null> {
  try {
    const thread = await gateway.readThread(threadId, true);
    return thread.turns.find((turn) => turn.id === turnId) ?? null;
  } catch (error) {
    logger?.warn("failed to hydrate completed turn", {
      threadId,
      turnId,
      error,
    });
    return null;
  }
}

export async function finalizeTurnResult(input: {
  threadId: string;
  turn: Turn;
  session: TelegramSession | null;
  store: SessionStore;
  buffers?: MessageBuffer;
  bot: Bot;
  logger: Logger | undefined;
}): Promise<void> {
  const { threadId, turn, session, store, buffers, bot, logger } = input;
  const delivery =
    store.getTurnDelivery(turn.id) ??
    (session
      ? store.upsertTurnDelivery({
          turnId: turn.id,
          threadId,
          sessionKey: session.sessionKey,
          chatId: session.chatId,
          messageThreadId: session.messageThreadId,
          outputMessageId: session.outputMessageId,
        })
      : null);
  const target = resolveTurnDeliveryTarget(session, delivery);
  if (!target) {
    await recordTurnDeliveryFailure(store, bot, turn.id, "No Telegram delivery target is available", logger);
    logger?.warn("skipping turn finalization because no telegram delivery target is available", {
      threadId,
      turnId: turn.id,
      sessionKey: session?.sessionKey ?? delivery?.sessionKey ?? null,
    });
    return;
  }

  const bufferKey = buffers ? resolveTurnBufferKey(buffers, threadId, turn.id) : turnBufferKey(threadId, turn.id);
  const hasBuffer = buffers ? hasBufferedTurn(buffers, threadId, turn.id) : false;
  const payload = buildFinalTurnPayload(turn);
  const contentHash = hashTurnDeliveryPayload(payload);

  if (delivery?.status === "delivered" && delivery.contentHash === contentHash) {
    logger?.info("skipping duplicate finalized turn delivery", {
      threadId,
      turnId: turn.id,
      sessionKey: target.sessionKey,
    });
    return;
  }

  if (delivery?.status === "failed" && delivery.failureCount >= MAX_TURN_DELIVERY_FAILURES) {
    await notifyExhaustedTurnDeliveryFailures(store, bot, logger);
    logger?.warn("skipping finalized turn delivery because retry budget is exhausted", {
      threadId,
      turnId: turn.id,
      sessionKey: target.sessionKey,
      failureCount: delivery.failureCount,
    });
    return;
  }

  if (delivery) {
    store.markTurnDeliveryDelivering(turn.id, contentHash);
  }

  let deliveredMessageId: number | null = delivery?.outputMessageId ?? session?.outputMessageId ?? null;
  try {
    if (turn.status === "failed") {
      if (hasBuffer && buffers) {
        await buffers.fail(bufferKey, payload.text);
      } else {
        deliveredMessageId = await deliverRecoveredTurnMessage(bot, target, payload, logger);
      }
    } else if (hasBuffer && buffers) {
      await buffers.complete(bufferKey, payload.text);
    } else {
      deliveredMessageId = await deliverRecoveredTurnMessage(bot, target, payload, logger);
    }
  } catch (error) {
    await recordTurnDeliveryFailure(store, bot, turn.id, describeError(error), logger);
    throw error;
  }

  if (delivery) {
    if (deliveredMessageId != null && deliveredMessageId !== delivery.outputMessageId) {
      store.setTurnDeliveryMessage(turn.id, deliveredMessageId);
    }
    store.markTurnDeliveryDelivered(turn.id, contentHash);
  }
}

function hasBufferedTurn(buffers: MessageBuffer, threadId: string, turnId: string): boolean {
  return buffers.has(turnBufferKey(threadId, turnId)) || buffers.has(turnBufferKey(threadId, "pending"));
}

function findFinalAgentMessage(turn: Turn): Extract<ThreadItem, { type: "agentMessage" }> | null {
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (!item) continue;
    if (item.type === "agentMessage") {
      return item;
    }
  }
  return null;
}

function formatTurnFailure(turn: Turn): string {
  const message = turn.error?.message?.trim() || "未知错误";
  const details = turn.error?.additionalDetails?.trim();
  return details ? `Codex 失败：${message}\n\n${details}` : `Codex 失败：${message}`;
}

function buildFinalTurnPayload(turn: Turn): { kind: "markdown" | "plain"; text: string } {
  if (turn.status === "completed") {
    const agentMessage = findFinalAgentMessage(turn);
    if (agentMessage) {
      return {
        kind: "markdown",
        text: agentMessage.text,
      };
    }
    return {
      kind: "plain",
      text: "Codex 已完成，但没有返回可发送的文本。",
    };
  }

  if (turn.status === "interrupted") {
    return {
      kind: "plain",
      text: "Codex 已中断。",
    };
  }

  return {
    kind: "plain",
    text: formatTurnFailure(turn),
  };
}

function hashTurnDeliveryPayload(payload: { kind: "markdown" | "plain"; text: string }): string {
  return createHash("sha256").update(payload.kind).update("\n").update(payload.text).digest("hex");
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function recordTurnDeliveryFailure(
  store: SessionStore,
  bot: Bot,
  turnId: string,
  error: string,
  logger?: Logger,
): Promise<void> {
  const delivery = store.getTurnDelivery(turnId);
  if (!delivery) return;

  const failureCount = delivery.failureCount + 1;
  const nextAttemptAt =
    failureCount >= MAX_TURN_DELIVERY_FAILURES ? null : new Date(Date.now() + retryDelayMsForFailure(failureCount)).toISOString();

  store.markTurnDeliveryFailed(turnId, {
    error,
    nextAttemptAt,
  });

  const updated = store.getTurnDelivery(turnId);
  if (!updated || updated.alertedAt || updated.failureCount < MAX_TURN_DELIVERY_FAILURES) {
    return;
  }

  await notifyTurnDeliveryFailure(store, bot, updated, logger);
}

function retryDelayMsForFailure(failureCount: number): number {
  return TURN_DELIVERY_RETRY_DELAYS_MS[Math.max(0, Math.min(failureCount - 1, TURN_DELIVERY_RETRY_DELAYS_MS.length - 1))]!;
}

async function notifyExhaustedTurnDeliveryFailures(store: SessionStore, bot: Bot, logger?: Logger): Promise<void> {
  const exhausted = store.listExhaustedUnalertedTurnDeliveries(MAX_TURN_DELIVERY_FAILURES);
  for (const delivery of exhausted) {
    await notifyTurnDeliveryFailure(store, bot, delivery, logger);
  }
}

async function notifyTurnDeliveryFailure(
  store: SessionStore,
  bot: Bot,
  delivery: TurnDelivery,
  logger?: Logger,
): Promise<void> {
  const authorizedUserId = store.getAuthorizedUserId();
  if (authorizedUserId == null) {
    logger?.warn("turn delivery exhausted retries but no authorized telegram user is available for alerting", {
      turnId: delivery.turnId,
      threadId: delivery.threadId,
      sessionKey: delivery.sessionKey,
      failureCount: delivery.failureCount,
    });
    return;
  }

  const session = store.get(delivery.sessionKey);
  const lines = [
    "telecodex 投递失败，已停止自动重试。",
    `turn: ${delivery.turnId}`,
    `thread: ${delivery.threadId}`,
    `session: ${delivery.sessionKey}`,
    `chat: ${delivery.chatId}`,
    `topic: ${delivery.messageThreadId ?? "private"}`,
    `failures: ${delivery.failureCount}`,
    `last error: ${delivery.lastError ?? "unknown"}`,
    `next retry: ${delivery.nextAttemptAt ?? "none"}`,
    `cwd: ${session?.cwd ?? "unknown"}`,
  ];

  try {
    await sendPlainChunks(
      bot,
      {
        chatId: authorizedUserId,
        messageThreadId: null,
        text: lines.join("\n"),
      },
      logger,
    );
    store.markTurnDeliveryAlerted(delivery.turnId);
  } catch (error) {
    logger?.warn("failed to alert authorized telegram user about exhausted turn delivery", {
      turnId: delivery.turnId,
      threadId: delivery.threadId,
      sessionKey: delivery.sessionKey,
      alertUserId: authorizedUserId,
      error,
    });
  }
}

function resolveTurnDeliveryTarget(
  session: TelegramSession | null,
  delivery: TurnDelivery | null,
): { sessionKey: string | null; chatId: string; messageThreadId: string | null; outputMessageId: number | null } | null {
  if (delivery) {
    return {
      sessionKey: delivery.sessionKey,
      chatId: delivery.chatId,
      messageThreadId: delivery.messageThreadId,
      outputMessageId: delivery.outputMessageId ?? session?.outputMessageId ?? null,
    };
  }
  if (!session) return null;
  return {
    sessionKey: session.sessionKey,
    chatId: session.chatId,
    messageThreadId: session.messageThreadId,
    outputMessageId: session.outputMessageId,
  };
}

async function deliverRecoveredTurnMessage(
  bot: Bot,
  target: {
    sessionKey: string | null;
    chatId: string;
    messageThreadId: string | null;
    outputMessageId: number | null;
  },
  payload: { kind: "markdown" | "plain"; text: string },
  logger?: Logger,
): Promise<number | null> {
  if (!payload.text.trim()) return target.outputMessageId;

  const chunks =
    payload.kind === "markdown"
      ? renderMarkdownForTelegram(payload.text)
      : renderPlainChunksForTelegram(payload.text);
  return replaceOrSendHtmlChunks(
    bot,
    {
      chatId: Number(target.chatId),
      messageThreadId: target.messageThreadId == null ? null : Number(target.messageThreadId),
      messageId: target.outputMessageId,
      chunks,
    },
    logger,
  );
}
