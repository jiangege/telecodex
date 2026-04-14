import type { ServerNotification } from "../generated/codex-app-server/index.js";

export type CodexNotificationMethod = ServerNotification["method"];

export const HANDLED_CODEX_NOTIFICATION_METHODS = [
  "error",
  "thread/status/changed",
  "thread/archived",
  "thread/name/updated",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/completed",
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "serverRequest/resolved",
  "item/mcpToolCall/progress",
  "item/reasoning/summaryTextDelta",
  "thread/compacted",
  "model/rerouted",
] as const satisfies readonly CodexNotificationMethod[];

export const IGNORED_CODEX_NOTIFICATION_METHODS = [
  "thread/started",
  "thread/unarchived",
  "thread/closed",
  "skills/changed",
  "thread/tokenUsage/updated",
  "hook/started",
  "hook/completed",
  "turn/diff/updated",
  "rawResponseItem/completed",
  "command/exec/outputDelta",
  "item/commandExecution/terminalInteraction",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "fs/changed",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "deprecationNotice",
  "configWarning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/transcriptUpdated",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/error",
  "thread/realtime/closed",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "account/login/completed",
] as const satisfies readonly CodexNotificationMethod[];

const IGNORED_CODEX_NOTIFICATION_METHOD_SET = new Set<string>(IGNORED_CODEX_NOTIFICATION_METHODS);

export function isIgnoredCodexNotificationMethod(method: CodexNotificationMethod): boolean {
  return IGNORED_CODEX_NOTIFICATION_METHOD_SET.has(method);
}
