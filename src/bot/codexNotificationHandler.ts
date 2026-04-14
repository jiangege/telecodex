import type { Bot } from "grammy";
import type { CodexGateway } from "../codex/CodexGateway.js";
import type { ServerNotification } from "../generated/codex-app-server/index.js";
import type { Turn } from "../generated/codex-app-server/v2/Turn.js";
import type { Logger } from "../runtime/logger.js";
import { applySessionRuntimeEvent, runtimeEventFromTurn } from "../runtime/sessionRuntime.js";
import type { SessionStore, TelegramSession } from "../store/sessions.js";
import { MessageBuffer } from "../telegram/messageBuffer.js";
import { deleteTelegramTopic, sendCleanupNoticeToGeneral } from "../telegram/topicCleanup.js";
import { retryTelegramCall } from "../telegram/delivery.js";
import {
  formatCodexErrorDetail,
  formatCompletedItemNote,
  formatGuardianReviewNote,
  formatStartedItemNote,
  formatTurnPlan,
  refreshTopicStatusPin,
  resolveTurnBufferKey,
  sessionLogFields,
  truncateSingleLine,
  turnBufferKey,
} from "./sessionFlow.js";
import { numericChatId, numericMessageThreadId } from "./session.js";
import { isIgnoredCodexNotificationMethod } from "./codexNotificationPolicy.js";
import { processNextQueuedInputForSession } from "./inputService.js";
import { finalizeTurnResult, hydrateTurn } from "./turnDeliveryService.js";

export async function handleCodexNotification(
  event: ServerNotification,
  store: SessionStore,
  buffers: MessageBuffer,
  bot: Bot,
  gateway: CodexGateway,
  logger?: Logger,
): Promise<void> {
  if (event.method === "turn/started") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      await applySessionRuntimeEvent({
        bot,
        store,
        sessionKey: session.sessionKey,
        event: {
          type: "turn.started",
          turnId: event.params.turn.id,
        },
        logger,
      });
    }
    buffers.note(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turn.id), "开始处理");
    return;
  }

  if (event.method === "turn/plan/updated") {
    buffers.setPlan(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      formatTurnPlan(event.params.explanation, event.params.plan),
    );
    return;
  }

  if (event.method === "item/plan/delta") {
    buffers.appendPlan(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), event.params.delta);
    return;
  }

  if (event.method === "item/agentMessage/delta") {
    buffers.append(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), event.params.delta);
    return;
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    buffers.appendReasoningSummary(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      event.params.delta,
      event.params.summaryIndex,
    );
    return;
  }

  if (event.method === "item/started") {
    const note = formatStartedItemNote(event.params.item);
    if (note) {
      buffers.note(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), note);
    }
    return;
  }

  if (event.method === "item/commandExecution/outputDelta") {
    buffers.appendToolOutput(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), event.params.delta);
    return;
  }

  if (event.method === "item/fileChange/outputDelta") {
    buffers.appendToolOutput(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), event.params.delta);
    return;
  }

  if (event.method === "item/mcpToolCall/progress") {
    buffers.note(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      `MCP 进度: ${truncateSingleLine(event.params.message, 120)}`,
    );
    return;
  }

  if (event.method === "item/autoApprovalReview/started") {
    buffers.note(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      formatGuardianReviewNote("自动审批审查", event.params.review.status, event.params.review.rationale),
    );
    return;
  }

  if (event.method === "item/autoApprovalReview/completed") {
    buffers.note(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      formatGuardianReviewNote("自动审批完成", event.params.review.status, event.params.review.rationale),
    );
    return;
  }

  if (event.method === "thread/status/changed" && event.params.status.type === "active") {
    const session = store.getByThreadId(event.params.threadId);
    const flags = event.params.status.activeFlags;
    if (flags.includes("waitingOnApproval")) {
      if (session) {
        await applySessionRuntimeEvent({
          bot,
          store,
          sessionKey: session.sessionKey,
          event: {
            type: "turn.waitingApproval",
            turnId: session.activeTurnId,
          },
          logger,
        });
      }
      buffers.note(turnBufferKey(event.params.threadId, "pending"), "等待批准");
    } else if (flags.includes("waitingOnUserInput")) {
      if (session) {
        await applySessionRuntimeEvent({
          bot,
          store,
          sessionKey: session.sessionKey,
          event: {
            type: "turn.waitingInput",
            turnId: session.activeTurnId,
          },
          logger,
        });
      }
      buffers.note(turnBufferKey(event.params.threadId, "pending"), "等待输入");
    }
    return;
  }

  if (event.method === "thread/archived") {
    const session = store.getByThreadId(event.params.threadId);
    store.removeTurnDeliveriesForThread(event.params.threadId);
    if (session) {
      const topicDeleted = await deleteTelegramTopic(bot, session, logger);
      store.remove(session.sessionKey);
      logger?.warn("removed telegram topic binding after codex thread archived", {
        ...sessionLogFields(session),
        threadId: event.params.threadId,
        topicDeleted,
      });
      await sendCleanupNoticeToGeneral(
        bot,
        numericChatId(session),
        [
          {
            messageThreadId: session.messageThreadId ?? "?",
            codexThreadId: session.codexThreadId,
            reason: "codex-thread-archived",
            topicDeleted,
          },
        ],
        logger,
      );
    }
    return;
  }

  if (event.method === "serverRequest/resolved") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      await applySessionRuntimeEvent({
        bot,
        store,
        sessionKey: session.sessionKey,
        event: {
          type: "turn.running",
          turnId: session.activeTurnId,
        },
        logger,
      });
    }
    buffers.note(turnBufferKey(event.params.threadId, "pending"), "审批已处理");
    return;
  }

  if (event.method === "model/rerouted") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      store.setModel(session.sessionKey, event.params.toModel);
      await refreshTopicStatusPin(bot, store, session, logger);
    }
    buffers.note(
      resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId),
      `模型切换: ${event.params.fromModel} -> ${event.params.toModel}`,
    );
    return;
  }

  if (event.method === "thread/name/updated") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      await syncTelegramTopicNameFromThread(bot, store, session, event.params.threadName ?? null, logger);
    }
    return;
  }

  if (event.method === "thread/compacted") {
    const session = store.getByThreadId(event.params.threadId);
    if (session) {
      const key = session.activeTurnId
        ? resolveTurnBufferKey(buffers, event.params.threadId, session.activeTurnId)
        : turnBufferKey(event.params.threadId, "pending");
      buffers.note(key, "上下文已压缩");
    }
    return;
  }

  if (event.method === "item/completed") {
    const item = event.params.item;
    if (item.type === "agentMessage") {
      await buffers.complete(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), item.text);
      return;
    }
    const note = formatCompletedItemNote(item);
    if (note) {
      buffers.note(resolveTurnBufferKey(buffers, event.params.threadId, event.params.turnId), note);
    }
    return;
  }

  if (event.method === "turn/completed") {
    const delivery = store.getTurnDelivery(event.params.turn.id);
    const session = store.getByThreadId(event.params.threadId) ?? (delivery ? store.get(delivery.sessionKey) : null);
    let terminalTurn: Turn = event.params.turn;
    if (session || delivery) {
      const hydratedTurn = await hydrateTurn(gateway, event.params.threadId, event.params.turn.id, logger);
      terminalTurn = hydratedTurn ?? event.params.turn;
      try {
        await finalizeTurnResult({
          threadId: event.params.threadId,
          turn: terminalTurn,
          session,
          store,
          buffers,
          bot,
          logger,
        });
      } catch (error) {
        logger?.warn("failed to finalize completed turn delivery", {
          threadId: event.params.threadId,
          turnId: event.params.turn.id,
          sessionKey: session?.sessionKey ?? delivery?.sessionKey ?? null,
          error,
        });
      }
    }
    if (session) {
      store.setOutputMessage(session.sessionKey, null);
      await applySessionRuntimeEvent({
        bot,
        store,
        sessionKey: session.sessionKey,
        event: runtimeEventFromTurn(terminalTurn),
        logger,
      });
      await processNextQueuedInputForSession(session.sessionKey, store, gateway, buffers, bot, logger);
    }
    return;
  }

  if (event.method === "error") {
    logger?.error("codex notification error", event.params);
    if (!event.params.willRetry) {
      const delivery = store.getTurnDelivery(event.params.turnId);
      const session = store.getByThreadId(event.params.threadId) ?? (delivery ? store.get(delivery.sessionKey) : null);
      if (session || delivery) {
        try {
          await finalizeTurnResult({
            threadId: event.params.threadId,
            turn: {
              id: event.params.turnId,
              items: [],
              status: "failed",
              error: event.params.error,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
            session,
            store,
            buffers,
            bot,
            logger,
          });
        } catch (error) {
          logger?.warn("failed to finalize errored turn delivery", {
            threadId: event.params.threadId,
            turnId: event.params.turnId,
            sessionKey: session?.sessionKey ?? delivery?.sessionKey ?? null,
            error,
          });
        }
      }
      if (session) {
        store.setOutputMessage(session.sessionKey, null);
        await applySessionRuntimeEvent({
          bot,
          store,
          sessionKey: session.sessionKey,
          event: {
            type: "turn.failed",
            turnId: event.params.turnId,
            message: formatCodexErrorDetail(event.params.error.message, event.params.error.additionalDetails),
          },
          logger,
        });
        await processNextQueuedInputForSession(session.sessionKey, store, gateway, buffers, bot, logger);
      }
    }
    process.stderr.write(`[codex error] ${JSON.stringify(event.params)}\n`);
    return;
  }

  if (isIgnoredCodexNotificationMethod(event.method)) {
    logger?.debug("ignored codex notification", { method: event.method });
    return;
  }

  logger?.debug("unhandled codex notification", { method: event.method });
}

async function syncTelegramTopicNameFromThread(
  bot: Bot,
  store: SessionStore,
  session: TelegramSession,
  threadName: string | null,
  logger?: Logger,
): Promise<void> {
  const messageThreadId = numericMessageThreadId(session);
  if (messageThreadId == null || !threadName?.trim()) {
    return;
  }

  const topicName = formatTopicName(threadName, "Codex Thread");
  try {
    await retryTelegramCall(
      () =>
        bot.api.editForumTopic(numericChatId(session), messageThreadId, {
          name: topicName,
        }),
      logger,
      "telegram edit topic rate limited",
      {
        chatId: numericChatId(session),
        messageThreadId,
      },
    );
  } catch (error) {
    logger?.warn("failed to sync telegram topic name from codex thread", {
      sessionKey: session.sessionKey,
      chatId: session.chatId,
      messageThreadId: session.messageThreadId,
      codexThreadId: session.codexThreadId,
      topicName,
      error,
    });
  }

  store.setTelegramTopicName(session.sessionKey, topicName);
  await refreshTopicStatusPin(bot, store, session, logger);
}

function formatTopicName(name: string | null | undefined, fallback: string): string {
  const raw = name?.trim() || fallback;
  return raw.slice(0, 128);
}
