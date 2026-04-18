import type { Bot } from "grammy";
import type { Input } from "@openai/codex-sdk";
import { applySessionRuntimeEvent } from "../../runtime/sessionRuntime.js";
import { formatCodexErrorForUser } from "../../codex/errorFormatting.js";
import type { Logger } from "../../runtime/logger.js";
import type { ProjectStore } from "../../store/projectStore.js";
import { type SessionStore, type StoredCodexInput, type TelegramSession } from "../../store/sessionStore.js";
import { MessageBuffer } from "../../telegram/messageBuffer.js";
import { sendReplyNotice } from "../../telegram/replyDocument.js";
import { CodexSdkRuntime, isAbortError } from "../../codex/sdkRuntime.js";
import { numericChatId, numericMessageThreadId } from "../topicSession.js";
import { isSessionBusy, sessionBufferKey, sessionLogFields } from "../sessionState.js";
import { applyRuntimeStateForSdkEvent, projectSdkEventToTelegramBuffer } from "./sdkEventProjection.js";
import { refreshSessionIfActiveTurnIsStale } from "./staleRunRecovery.js";

export interface HandleUserTextResult {
  status: "started" | "busy" | "failed";
  consumed: boolean;
}

const BUSY_NOTICE_LINES = [
  "Codex is still working in this topic.",
  "New messages are ignored until the current run finishes or fails.",
  "Use /stop to interrupt it.",
];

export async function handleUserText(input: {
  text: string;
  session: TelegramSession;
  sessions: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
}): Promise<HandleUserTextResult> {
  return handleUserInput({
    prompt: input.text,
    session: input.session,
    sessions: input.sessions,
    projects: input.projects,
    codex: input.codex,
    buffers: input.buffers,
    bot: input.bot,
    ...(input.logger ? { logger: input.logger } : {}),
  });
}

export async function handleUserInput(input: {
  prompt: StoredCodexInput;
  session: TelegramSession;
  sessions: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  logger?: Logger;
}): Promise<HandleUserTextResult> {
  const { prompt, sessions, projects, codex, buffers, bot, logger } = input;
  const session = await refreshSessionIfActiveTurnIsStale(input.session, sessions, codex, buffers, bot, logger);

  if (isSessionBusy(session) || codex.isRunning(session.sessionKey)) {
    await sendReplyNotice(
      bot,
      {
        chatId: numericChatId(session),
        messageThreadId: numericMessageThreadId(session),
      },
      BUSY_NOTICE_LINES,
      logger,
    );
    return {
      status: "busy",
      consumed: true,
    };
  }

  await applySessionRuntimeEvent({
    bot,
    store: sessions,
    sessionKey: session.sessionKey,
    event: {
      type: "turn.preparing",
      detail: "waiting for first Codex SDK event",
    },
    logger,
  });

  const bufferKey = sessionBufferKey(session.sessionKey);
  let outputMessageId: number;
  try {
    outputMessageId = await buffers.create(bufferKey, {
      chatId: numericChatId(session),
      messageThreadId: numericMessageThreadId(session),
    });
  } catch (error) {
    sessions.setOutputMessage(session.sessionKey, null);
    await applySessionRuntimeEvent({
      bot,
      store: sessions,
      sessionKey: session.sessionKey,
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

  sessions.setOutputMessage(session.sessionKey, outputMessageId);

  void runSessionPrompt({
    sessionKey: session.sessionKey,
    prompt,
    sessions,
    projects,
    codex,
    buffers,
    bot,
    bufferKey,
    ...(logger ? { logger } : {}),
  });

  return {
    status: "started",
    consumed: true,
  };
}

async function runSessionPrompt(input: {
  sessionKey: string;
  prompt: StoredCodexInput;
  sessions: SessionStore;
  projects: ProjectStore;
  codex: CodexSdkRuntime;
  buffers: MessageBuffer;
  bot: Bot;
  bufferKey: string;
  logger?: Logger;
}): Promise<void> {
  const { sessionKey, prompt, sessions, projects, codex, buffers, bot, bufferKey, logger } = input;
  const session = sessions.get(sessionKey);
  if (!session) {
    await buffers.complete(bufferKey, "The topic session no longer exists. Send the message again if you still want to run it.");
    return;
  }

  logger?.info("starting codex sdk run", {
    ...sessionLogFields(session),
  });

  try {
    const result = await codex.run({
      profile: {
        sessionKey,
        threadId: session.codexThreadId,
        cwd: session.cwd,
        model: session.model,
        sandboxMode: session.sandboxMode,
        approvalPolicy: session.approvalPolicy,
        reasoningEffort: session.reasoningEffort,
        webSearchMode: session.webSearchMode,
        networkAccessEnabled: session.networkAccessEnabled,
        skipGitRepoCheck: session.skipGitRepoCheck,
        additionalDirectories: session.additionalDirectories,
        outputSchema: readOutputSchema(session, sessions, logger),
      },
      prompt: toSdkInput(prompt),
      callbacks: {
        onThreadStarted: async (threadId) => {
          sessions.bindThread(sessionKey, threadId);
          logger?.info("codex sdk thread started", {
            sessionKey,
            threadId,
          });
        },
        onEvent: async (event) => {
          await applyRuntimeStateForSdkEvent({
            event,
            sessionKey,
            sessions,
            bot,
            logger,
          });
          await projectSdkEventToTelegramBuffer(buffers, bufferKey, event);
        },
      },
    });

    const latest = sessions.get(sessionKey);
    if (latest) {
      sessions.bindThread(sessionKey, result.threadId);
      sessions.setOutputMessage(sessionKey, null);
      await applySessionRuntimeEvent({
        bot,
        store: sessions,
        sessionKey,
        event: {
          type: "turn.completed",
        },
        logger,
      });
    }

    logger?.info("codex sdk run completed", {
      sessionKey,
      threadId: result.threadId,
    });
    const projectRoot = projects.get(session.chatId)?.cwd ?? null;
    await buffers.complete(
      bufferKey,
      result.finalResponse || undefined,
      projectRoot
        ? {
          mediaScope: {
            projectRoot,
            workingDirectory: session.cwd,
          },
        }
        : undefined,
    );
  } catch (error) {
    const userFacingMessage = isAbortError(error)
      ? "Current run interrupted."
      : formatCodexErrorForUser(error);
    const latest = sessions.get(sessionKey);
    if (latest) {
      sessions.setOutputMessage(sessionKey, null);
      await applySessionRuntimeEvent({
        bot,
        store: sessions,
        sessionKey,
        event: isAbortError(error)
          ? {
            type: "turn.interrupted",
          }
          : {
            type: "turn.failed",
            message: userFacingMessage,
          },
        logger,
      });
    }

    logger?.warn("codex sdk run failed", {
      sessionKey,
      error,
    });
    await buffers.fail(bufferKey, userFacingMessage);
  }
}

function toSdkInput(input: StoredCodexInput): Input {
  return input;
}

function parseOutputSchema(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid stored output schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readOutputSchema(session: TelegramSession, sessions: SessionStore, logger?: Logger): unknown {
  try {
    return parseOutputSchema(session.outputSchema);
  } catch (error) {
    sessions.setOutputSchema(session.sessionKey, null);
    logger?.warn("cleared invalid stored output schema", {
      ...sessionLogFields(session),
      error,
    });
    return undefined;
  }
}
