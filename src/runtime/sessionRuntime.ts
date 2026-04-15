import type { Bot } from "grammy";
import type { SessionRuntimeState, SessionRuntimeStatus, SessionStore, TelegramSession } from "../store/sessions.js";
import type { Logger } from "./logger.js";

export type SessionRuntimeEvent =
  | { type: "turn.preparing"; detail?: string | null }
  | { type: "turn.started" }
  | { type: "turn.completed" }
  | { type: "turn.interrupted" }
  | { type: "turn.failed"; message?: string | null };

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
  return input.store.get(session.sessionKey);
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
      };
    case "turn.started":
      return {
        status: "running",
        detail: null,
        updatedAt,
      };
    case "turn.completed":
    case "turn.interrupted":
      return {
        status: "idle",
        detail: null,
        updatedAt,
      };
    case "turn.failed":
      return {
        status: "failed",
        detail: event.message?.trim() || null,
        updatedAt,
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
    case "failed":
      return "failed";
  }
}
