import type { Bot } from "grammy";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { Logger } from "../runtime/logger.js";
import { applySessionRuntimeEvent, runtimeEventFromTurn } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { sendPlainChunks } from "../telegram/delivery.js";
import { numericChatId, numericMessageThreadId } from "./session.js";
import {
  describeBusyStatus,
  formatIsoTimestamp,
  isSessionBusy,
  refreshTopicStatusPin,
  sessionLogFields,
  sessionPendingBufferKey,
  syncSessionFromCodexRuntime,
  turnBufferKey,
} from "./sessionFlow.js";
import { backfillTurnDeliveryFromSession, finalizeTurnResult } from "./turnDeliveryService.js";

export interface HandleUserTextResult {
  status: "started" | "queued" | "busy" | "failed";
  consumed: boolean;
}

export async function handleUserText(input: {
  text: string;
  session: TelegramSession;
  store: SessionStore;
  gateway: CodexGateway;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
  enqueueIfBusy?: boolean;
}): Promise<HandleUserTextResult> {
  const { text, session, store, gateway, buffers, bot, logger } = input;
  const enqueueIfBusy = input.enqueueIfBusy ?? true;
  const effectiveSession = await refreshSessionIfActiveTurnIsStale(session, store, gateway, buffers, bot, logger);
  if (isSessionBusy(effectiveSession)) {
    if (!enqueueIfBusy) {
      return {
        status: "busy",
        consumed: false,
      };
    }
    const queued = store.enqueueInput(effectiveSession.sessionKey, text);
    const queueDepth = store.getQueuedInputCount(effectiveSession.sessionKey);
    await sendPlainChunks(
      bot,
      {
        chatId: numericChatId(session),
        messageThreadId: numericMessageThreadId(effectiveSession),
        text: [
          `当前 Codex 任务仍在${describeBusyStatus(effectiveSession.runtimeStatus)}，已把你的消息加入队列。`,
          `queue position: ${queueDepth}`,
          `queued at: ${formatIsoTimestamp(queued.createdAt)}`,
          "当前 turn 结束后会自动继续处理。",
        ].join("\n"),
      },
      logger,
    );
    return {
      status: "queued",
      consumed: true,
    };
  }

  await applySessionRuntimeEvent({
    bot,
    store,
    sessionKey: effectiveSession.sessionKey,
    event: {
      type: "turn.preparing",
      detail: "preparing thread",
    },
    logger,
  });

  let bufferKey = sessionPendingBufferKey(effectiveSession.sessionKey);
  let messageId: number;
  try {
    messageId = await buffers.create(bufferKey, {
      chatId: numericChatId(effectiveSession),
      messageThreadId: numericMessageThreadId(effectiveSession),
    });
  } catch (error) {
    logger?.error("create telegram output placeholder failed", {
      ...sessionLogFields(effectiveSession),
      error,
    });
    store.setOutputMessage(effectiveSession.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: effectiveSession.sessionKey,
      event: {
        type: "turn.failed",
        message: error instanceof Error ? error.message : String(error),
      },
      logger,
    });
    return {
      status: "failed",
      consumed: false,
    };
  }
  store.setOutputMessage(effectiveSession.sessionKey, messageId);

  let threadId = effectiveSession.codexThreadId;
  try {
    if (!threadId) {
      const started = await gateway.startThread({
        cwd: effectiveSession.cwd,
        model: effectiveSession.model,
        sandboxMode: effectiveSession.sandboxMode,
        approvalPolicy: effectiveSession.approvalPolicy,
        reasoningEffort: effectiveSession.reasoningEffort,
      });
      threadId = started.thread.id;
      store.setThread(effectiveSession.sessionKey, threadId);
      syncSessionFromCodexRuntime(store, effectiveSession.sessionKey, started);
      await refreshTopicStatusPin(bot, store, effectiveSession, logger);
      logger?.info("started new codex thread from telegram topic", {
        ...sessionLogFields(store.get(effectiveSession.sessionKey) ?? effectiveSession),
        threadId,
        cwd: effectiveSession.cwd,
        model: effectiveSession.model,
      });
    } else {
      const resumed = await gateway.resumeThread(threadId, {
        cwd: effectiveSession.cwd,
        model: effectiveSession.model,
        sandboxMode: effectiveSession.sandboxMode,
        approvalPolicy: effectiveSession.approvalPolicy,
        reasoningEffort: effectiveSession.reasoningEffort,
      });
      syncSessionFromCodexRuntime(store, effectiveSession.sessionKey, resumed);
      await refreshTopicStatusPin(bot, store, effectiveSession, logger);
      logger?.info("resumed codex thread for incoming message", {
        ...sessionLogFields(effectiveSession),
        threadId,
      });
    }

    const pendingBufferKey = turnBufferKey(threadId, "pending");
    if (bufferKey !== pendingBufferKey) {
      buffers.rename(bufferKey, pendingBufferKey);
      bufferKey = pendingBufferKey;
    }
  } catch (error) {
    logger?.error("prepare thread for incoming telegram message failed", {
      ...sessionLogFields(effectiveSession),
      threadId,
      error,
    });
    await buffers.fail(bufferKey, error instanceof Error ? error.message : String(error));
    store.setOutputMessage(effectiveSession.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: effectiveSession.sessionKey,
      event: {
        type: "turn.failed",
        message: error instanceof Error ? error.message : String(error),
      },
      logger,
    });
    return {
      status: "failed",
      consumed: true,
    };
  }

  try {
    const turn = await gateway.startTurn({
      threadId,
      text,
      cwd: effectiveSession.cwd,
      model: effectiveSession.model,
      sandboxMode: effectiveSession.sandboxMode,
      approvalPolicy: effectiveSession.approvalPolicy,
      reasoningEffort: effectiveSession.reasoningEffort,
    });
    const turnId = turn.turn.id;
    store.upsertTurnDelivery({
      turnId,
      threadId,
      sessionKey: effectiveSession.sessionKey,
      chatId: effectiveSession.chatId,
      messageThreadId: effectiveSession.messageThreadId,
      outputMessageId: messageId,
    });
    buffers.rename(bufferKey, turnBufferKey(threadId, turnId));
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: effectiveSession.sessionKey,
      event: {
        type: "turn.started",
        turnId,
      },
      logger,
    });
    logger?.info("started codex turn from telegram message", {
      ...sessionLogFields(store.get(effectiveSession.sessionKey) ?? effectiveSession),
      threadId,
      turnId,
      inputLength: text.length,
    });
    return {
      status: "started",
      consumed: true,
    };
  } catch (error) {
    logger?.error("start codex turn failed", {
      ...sessionLogFields(effectiveSession),
      threadId,
      error,
    });
    await buffers.fail(bufferKey, error instanceof Error ? error.message : String(error));
    store.setOutputMessage(effectiveSession.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: effectiveSession.sessionKey,
      event: {
        type: "turn.failed",
        message: error instanceof Error ? error.message : String(error),
      },
      logger,
    });
    await processNextQueuedInputForSession(effectiveSession.sessionKey, store, gateway, buffers, bot, logger);
    return {
      status: "failed",
      consumed: true,
    };
  }
}

export async function refreshSessionIfActiveTurnIsStale(
  session: TelegramSession,
  store: SessionStore,
  gateway: CodexGateway,
  buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<TelegramSession> {
  const latest = store.get(session.sessionKey) ?? session;
  if (!latest.activeTurnId) return latest;

  backfillTurnDeliveryFromSession(store, latest);

  if (!latest.codexThreadId) {
    store.removeTurnDelivery(latest.activeTurnId);
    store.setOutputMessage(latest.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: latest.sessionKey,
      event: { type: "session.reset" },
      logger,
    });
    logger?.warn("cleared stale active turn because session has no codex thread id", {
      ...sessionLogFields(latest),
    });
    return (store.get(latest.sessionKey) ?? { ...latest, activeTurnId: null, outputMessageId: null }) as TelegramSession;
  }

  try {
    const thread = await gateway.readThread(latest.codexThreadId, true);
    const activeTurn = thread.turns.find((turn) => turn.id === latest.activeTurnId) ?? null;
    const threadStillRunning = thread.status.type === "active";
    const turnStillRunning = activeTurn?.status === "inProgress";
    if (threadStillRunning || turnStillRunning) {
      return latest;
    }

    if (activeTurn) {
      try {
        await finalizeTurnResult({
          threadId: latest.codexThreadId,
          turn: activeTurn,
          session: latest,
          store,
          buffers,
          bot,
          logger,
        });
      } catch (error) {
        logger?.warn("failed to finalize stale active turn result", {
          ...sessionLogFields(latest),
          threadId: latest.codexThreadId,
          turnId: activeTurn.id,
          error,
        });
      }
    }
    store.setOutputMessage(latest.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: latest.sessionKey,
      event: activeTurn ? runtimeEventFromTurn(activeTurn) : { type: "session.reset" },
      logger,
    });
    logger?.info("cleared stale active turn after reading codex thread state", {
      ...sessionLogFields(latest),
      threadStatus: thread.status.type,
      turnStatus: activeTurn?.status ?? null,
      knownTurns: thread.turns.length,
    });
    return (store.get(latest.sessionKey) ?? { ...latest, activeTurnId: null, outputMessageId: null }) as TelegramSession;
  } catch (error) {
    logger?.warn("failed to verify active turn state before handling telegram message", {
      ...sessionLogFields(latest),
      error,
    });
    return latest;
  }
}

export async function recoverActiveTopicSessions(
  store: SessionStore,
  gateway: CodexGateway,
  buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const sessions = store.listTopicSessions().filter((session) => session.activeTurnId);
  if (sessions.length === 0) return;

  logger?.info("recovering active topic sessions", {
    activeSessions: sessions.length,
  });

  for (const session of sessions) {
    await applySessionRuntimeEvent({
      bot,
      store,
      sessionKey: session.sessionKey,
      event: {
        type: "turn.recovering",
        turnId: session.activeTurnId,
      },
      logger,
    });
    await refreshSessionIfActiveTurnIsStale(session, store, gateway, buffers, bot, logger?.child("turn-recovery"));
  }
}

export async function processNextQueuedInputForSession(
  sessionKey: string,
  store: SessionStore,
  gateway: CodexGateway,
  buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<void> {
  const session = store.get(sessionKey);
  if (!session || isSessionBusy(session)) return;
  const next = store.peekNextQueuedInput(sessionKey);
  if (!next) return;
  try {
    const result = await handleUserText({
      text: next.text,
      session,
      store,
      gateway,
      buffers,
      bot,
      enqueueIfBusy: false,
      ...(logger ? { logger } : {}),
    });
    if (result.consumed) {
      store.removeQueuedInput(next.id);
    }
  } catch (error) {
    logger?.warn("failed to process queued telegram input", {
      sessionKey,
      queuedInputId: next.id,
      error,
    });
  }
}
