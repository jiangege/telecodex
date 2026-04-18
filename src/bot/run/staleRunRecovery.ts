import type { Bot } from "grammy";
import { applySessionRuntimeEvent } from "../../runtime/sessionRuntime.js";
import type { Logger } from "../../runtime/logger.js";
import type { SessionStore, TelegramSession } from "../../store/sessionStore.js";
import { MessageBuffer } from "../../telegram/messageBuffer.js";
import { sendReplyNotice } from "../../telegram/replyDocument.js";
import type { CodexSdkRuntime } from "../../codex/sdkRuntime.js";
import { numericChatId, numericMessageThreadId } from "../topicSession.js";
import { isSessionBusy, sessionBufferKey, sessionLogFields } from "../sessionState.js";

export async function refreshSessionIfActiveTurnIsStale(
  session: TelegramSession,
  sessions: SessionStore,
  codex: CodexSdkRuntime,
  buffers: MessageBuffer,
  bot: Bot,
  logger?: Logger,
): Promise<TelegramSession> {
  const latest = sessions.get(session.sessionKey) ?? session;
  if (!isSessionBusy(latest) || codex.isRunning(latest.sessionKey)) {
    return latest;
  }

  await buffers.complete(
    sessionBufferKey(latest.sessionKey),
    "The previous run was lost. Send the message again.",
  ).catch((error) => {
    logger?.warn("failed to clear stale telegram buffer", {
      ...sessionLogFields(latest),
      error,
    });
  });
  sessions.setOutputMessage(latest.sessionKey, null);
  await applySessionRuntimeEvent({
    bot,
    store: sessions,
    sessionKey: latest.sessionKey,
    event: {
      type: "turn.failed",
      message: "The previous run was lost. Send the message again.",
    },
    logger,
  });

  logger?.warn("reset stale in-memory codex run state", {
    ...sessionLogFields(latest),
  });

  return sessions.get(latest.sessionKey) ?? latest;
}

export async function recoverActiveTopicSessions(input: {
  sessions: SessionStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
}): Promise<void> {
  const activeSessions = input.sessions.listTopicSessions().filter((session) => isSessionBusy(session));
  if (activeSessions.length === 0) {
    return;
  }

  input.logger?.warn("recovering stale sdk-backed sessions after startup", {
    activeSessions: activeSessions.length,
  });

  for (const session of activeSessions) {
    const refreshed = await refreshSessionIfActiveTurnIsStale(
      session,
      input.sessions,
      input.codex,
      input.buffers,
      input.bot,
      input.logger,
    );
    await sendReplyNotice(
      input.bot,
      {
        chatId: numericChatId(refreshed),
        messageThreadId: numericMessageThreadId(refreshed),
      },
      "telecodex restarted and cannot resume the previous streamed run state. Send the message again if you want to continue.",
      input.logger,
    ).catch((error) => {
      input.logger?.warn("failed to notify session about stale sdk recovery", {
        ...sessionLogFields(refreshed),
        error,
      });
    });
  }
}
