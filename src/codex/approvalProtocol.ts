import type { ServerRequest } from "../generated/codex-app-server/index.js";
import type { PendingInteraction } from "../store/sessions.js";

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type SupportedServerRequestMethod =
  | "item/commandExecution/requestApproval"
  | "item/fileChange/requestApproval"
  | "execCommandApproval"
  | "applyPatchApproval"
  | "item/permissions/requestApproval"
  | "item/tool/requestUserInput"
  | "mcpServer/elicitation/request";

export type SupportedServerRequest = Extract<ServerRequest, { method: SupportedServerRequestMethod }>;
export type ToolUserInputRequest = Extract<SupportedServerRequest, { method: "item/tool/requestUserInput" }>;
export type PermissionsRequest = Extract<SupportedServerRequest, { method: "item/permissions/requestApproval" }>;
export type McpElicitationRequest = Extract<SupportedServerRequest, { method: "mcpServer/elicitation/request" }>;
export type McpFormRequest = McpElicitationRequest & {
  params: Extract<McpElicitationRequest["params"], { mode: "form" }>;
};
export type McpUrlRequest = McpElicitationRequest & {
  params: Extract<McpElicitationRequest["params"], { mode: "url" }>;
};
export type ApprovalLikeRequest = Extract<
  SupportedServerRequest,
  {
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval"
      | "execCommandApproval"
      | "applyPatchApproval"
      | "item/permissions/requestApproval";
  }
>;

export interface CallbackAction {
  interactionId: string;
  mode: "decision" | "answer" | "action";
  value: string;
}

export function isSupportedServerRequest(request: ServerRequest): request is SupportedServerRequest {
  return (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval" ||
    request.method === "execCommandApproval" ||
    request.method === "applyPatchApproval" ||
    request.method === "item/permissions/requestApproval" ||
    request.method === "item/tool/requestUserInput" ||
    request.method === "mcpServer/elicitation/request"
  );
}

export function parseStoredRequest(interaction: PendingInteraction): SupportedServerRequest | null {
  try {
    const parsed = JSON.parse(interaction.requestJson) as ServerRequest;
    return isSupportedServerRequest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isApprovalLikeRequest(request: SupportedServerRequest): request is ApprovalLikeRequest {
  return (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval" ||
    request.method === "execCommandApproval" ||
    request.method === "applyPatchApproval" ||
    request.method === "item/permissions/requestApproval"
  );
}

export function parseCallbackAction(data: string): CallbackAction | null {
  if (data.startsWith("approval:")) {
    const [, interactionId, value] = data.split(":");
    if (!interactionId || !value) return null;
    return { interactionId, mode: "decision", value };
  }

  if (!data.startsWith("interaction:")) return null;
  const [, interactionId, mode, ...rest] = data.split(":");
  if (!interactionId || !mode || rest.length === 0) return null;
  if (mode !== "decision" && mode !== "answer" && mode !== "action") return null;
  return { interactionId, mode, value: rest.join(":") };
}

export function requestThreadId(request: SupportedServerRequest): string | null {
  if ("threadId" in request.params && typeof request.params.threadId === "string") {
    return request.params.threadId;
  }
  if ("conversationId" in request.params && typeof request.params.conversationId === "string") {
    return request.params.conversationId;
  }
  return null;
}

export function requestTurnId(request: SupportedServerRequest): string | null {
  if ("turnId" in request.params && typeof request.params.turnId === "string") {
    return request.params.turnId;
  }
  return null;
}

export function requestItemId(request: SupportedServerRequest): string | null {
  if ("itemId" in request.params && typeof request.params.itemId === "string") {
    return request.params.itemId;
  }
  if ("callId" in request.params && typeof request.params.callId === "string") {
    return request.params.callId;
  }
  return null;
}

export function interactionRuntimeDetail(request: SupportedServerRequest): string {
  if (request.method === "item/tool/requestUserInput") {
    const first = request.params.questions[0];
    return first ? `input: ${truncate(`${first.header} ${first.question}`, 80)}` : "input required";
  }
  if (request.method === "mcpServer/elicitation/request") {
    return `input: ${request.params.serverName}`;
  }
  if (request.method === "item/permissions/requestApproval") {
    const scopes = [];
    if (request.params.permissions.network) scopes.push("network");
    if (request.params.permissions.fileSystem?.write?.length) scopes.push("write");
    if (request.params.permissions.fileSystem?.read?.length) scopes.push("read");
    return scopes.length > 0 ? `approval: ${scopes.join(", ")}` : "approval: permissions";
  }
  if (request.method === "item/commandExecution/requestApproval") {
    return `approval: ${truncate(request.params.command ?? "command", 80)}`;
  }
  if (request.method === "execCommandApproval") {
    return `approval: ${truncate(request.params.command.join(" "), 80)}`;
  }
  if (request.method === "applyPatchApproval") {
    return `approval: file changes (${Object.keys(request.params.fileChanges).length})`;
  }
  return "approval: file changes";
}

export function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

export function isMcpAction(value: string): value is "accept" | "decline" | "cancel" {
  return value === "accept" || value === "decline" || value === "cancel";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}
