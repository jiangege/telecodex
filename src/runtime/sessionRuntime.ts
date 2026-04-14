import type { Bot } from "grammy";
import type { Turn } from "../generated/codex-app-server/v2/Turn.js";
import type { SessionRuntimeState, SessionRuntimeStatus, SessionStore, TelegramSession } from "../store/sessions.js";
import { updateTopicStatusPin } from "../telegram/topicStatus.js";
import type { Logger } from "./logger.js";

export type SessionRuntimeEvent =
  | { type: "turn.preparing"; detail?: string | null }
  | { type: "turn.started"; turnId: string }
  | { type: "turn.running"; turnId?: string | null }
  | { type: "turn.waitingApproval"; turnId?: string | null; detail?: string | null }
  | { type: "turn.waitingInput"; turnId?: string | null; detail?: string | null }
  | { type: "turn.recovering"; turnId?: string | null; detail?: string | null }
  | { type: "turn.completed"; turnId?: string | null }
  | { type: "turn.interrupted"; turnId?: string | null }
  | { type: "turn.failed"; turnId?: string | null; message?: string | null }
  | { type: "session.reset" };

export async function applySessionRuntimeEvent(input: {
  bot: Bot;
  store: SessionStore;
  sessionKey: string;
  event: SessionRuntimeEvent;
  logger: Logger | undefined;
}): Promise<TelegramSession | null> {
  const session = input.store.get(input.sessionKey);
  if (!session) return null;
  const next = reduceSessionRuntimeState(session, input.event);
  input.store.setRuntimeState(session.sessionKey, next);
  return projectSessionRuntimeState(input.bot, input.store, session.sessionKey, input.logger);
}

export async function projectSessionRuntimeState(
  bot: Bot,
  store: SessionStore,
  sessionKey: string,
  logger: Logger | undefined,
): Promise<TelegramSession | null> {
  const session = store.get(sessionKey);
  if (!session) return null;
  return updateTopicStatusPin(bot, store, session, logger?.child("topic-status"));
}

export function reduceSessionRuntimeState(
  session: TelegramSession,
  event: SessionRuntimeEvent,
  updatedAt = new Date().toISOString(),
): SessionRuntimeState {
  switch (event.type) {
    case "turn.preparing":
      return {
        status: "preparing",
        detail: event.detail ?? null,
        updatedAt,
        activeTurnId: null,
      };
    case "turn.started":
      return {
        status: "running",
        detail: null,
        updatedAt,
        activeTurnId: event.turnId,
      };
    case "turn.running":
      return {
        status: "running",
        detail: null,
        updatedAt,
        activeTurnId: event.turnId ?? session.activeTurnId,
      };
    case "turn.waitingApproval":
      return {
        status: "waiting_approval",
        detail: event.detail ?? null,
        updatedAt,
        activeTurnId: event.turnId ?? session.activeTurnId,
      };
    case "turn.waitingInput":
      return {
        status: "waiting_input",
        detail: event.detail ?? null,
        updatedAt,
        activeTurnId: event.turnId ?? session.activeTurnId,
      };
    case "turn.recovering":
      return {
        status: "recovering",
        detail: event.detail ?? null,
        updatedAt,
        activeTurnId: event.turnId ?? session.activeTurnId,
      };
    case "turn.completed":
    case "turn.interrupted":
    case "session.reset":
      return {
        status: "idle",
        detail: null,
        updatedAt,
        activeTurnId: null,
      };
    case "turn.failed":
      return {
        status: "failed",
        detail: event.message?.trim() || null,
        updatedAt,
        activeTurnId: null,
      };
  }
}

export function runtimeEventFromTurn(turn: Turn): SessionRuntimeEvent {
  switch (turn.status) {
    case "completed":
      return {
        type: "turn.completed",
        turnId: turn.id,
      };
    case "interrupted":
      return {
        type: "turn.interrupted",
        turnId: turn.id,
      };
    default:
      return {
        type: "turn.failed",
        turnId: turn.id,
        message: formatTurnErrorDetail(turn),
      };
  }
}

export function formatSessionRuntimeStatus(status: SessionRuntimeStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "running":
      return "running";
    case "preparing":
      return "preparing";
    case "waiting_approval":
      return "waiting-approval";
    case "waiting_input":
      return "waiting-input";
    case "recovering":
      return "recovering";
    case "failed":
      return "failed";
  }
}

function formatTurnErrorDetail(turn: Turn): string | null {
  const message = turn.error?.message?.trim() || null;
  const details = turn.error?.additionalDetails?.trim() || null;
  if (message && details) {
    return `${message}: ${details}`;
  }
  return message ?? details;
}
