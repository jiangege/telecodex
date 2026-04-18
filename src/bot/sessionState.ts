import type { TelegramSession } from "../store/sessionStore.js";

export function sessionBufferKey(sessionKey: string): string {
  return `session:${sessionKey}`;
}

export function formatIsoTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    hour12: false,
  });
}

export function truncateSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function sessionLogFields(session: TelegramSession): Record<string, string | null> {
  return {
    sessionKey: session.sessionKey,
    chatId: session.chatId,
    messageThreadId: session.messageThreadId,
    cwd: session.cwd,
    model: session.model,
    sandboxMode: session.sandboxMode,
    approvalPolicy: session.approvalPolicy,
    reasoningEffort: session.reasoningEffort,
    webSearchMode: session.webSearchMode,
    networkAccessEnabled: session.networkAccessEnabled ? "true" : "false",
    skipGitRepoCheck: session.skipGitRepoCheck ? "true" : "false",
    runtimeStatus: session.runtimeStatus,
    runtimeStatusDetail: session.runtimeStatusDetail,
    codexThreadId: session.codexThreadId,
  };
}

export function isSessionBusy(session: TelegramSession): boolean {
  return session.runtimeStatus === "preparing" || session.runtimeStatus === "running";
}

export function describeBusyStatus(status: TelegramSession["runtimeStatus"]): string {
  switch (status) {
    case "preparing":
      return "preparing";
    case "running":
      return "running";
    case "failed":
      return "recovering after a failed run";
    default:
      return "processing";
  }
}
