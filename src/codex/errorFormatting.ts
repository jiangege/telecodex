const CODEX_WS_PATH = "backend-api/codex/responses";
const HTML_PATTERN = /<!doctype html>|<html\b/i;

export function formatCodexErrorForUser(error: unknown): string {
  const message = readErrorMessage(error);
  if (!message) {
    return "Codex failed unexpectedly. Try again.";
  }

  if (isCodexBackendForbidden(message)) {
    return "Codex backend rejected the connection (403). Refresh the Codex login or try again later.";
  }

  if (HTML_PATTERN.test(message)) {
    return "Codex returned an upstream HTML error. Try again later.";
  }

  const compact = message.replace(/\s+/g, " ").trim();
  if (!compact) {
    return "Codex failed unexpectedly. Try again.";
  }
  return compact.length > 500 ? `${compact.slice(0, 497)}...` : compact;
}

function isCodexBackendForbidden(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("403 forbidden") && normalized.includes(CODEX_WS_PATH);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}
