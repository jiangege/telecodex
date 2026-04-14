import type { ReviewDecision } from "../generated/codex-app-server/index.js";
import type { CommandExecutionApprovalDecision } from "../generated/codex-app-server/v2/CommandExecutionApprovalDecision.js";
import type { FileChangeApprovalDecision } from "../generated/codex-app-server/v2/FileChangeApprovalDecision.js";
import type { McpServerElicitationAction } from "../generated/codex-app-server/v2/McpServerElicitationAction.js";
import type { PermissionsRequestApprovalResponse } from "../generated/codex-app-server/v2/PermissionsRequestApprovalResponse.js";
import type { ToolRequestUserInputResponse } from "../generated/codex-app-server/v2/ToolRequestUserInputResponse.js";
import type { PendingInteraction } from "../store/sessions.js";
import {
  type ApprovalDecision,
  type CallbackAction,
  type McpFormRequest,
  type PermissionsRequest,
  type SupportedServerRequest,
  type ToolUserInputRequest,
  isApprovalDecision,
  isMcpAction,
} from "./approvalProtocol.js";
import {
  approvalLabel,
  findEnumValue,
  getSingleFieldAnswerOptions,
  getSingleQuestionOptions,
  mcpActionLabel,
  normalizeKey,
  summarizeJson,
  summarizeToolUserInputResponse,
} from "./approvalShared.js";

export const REJECT_RESPONSE = Symbol("reject-response");

export function resolveCallbackResult(
  interaction: PendingInteraction,
  request: SupportedServerRequest,
  action: CallbackAction,
):
  | { ok: true; answerText: string; appendedText: string; response: unknown }
  | { ok: false; message: string } {
  if (interaction.kind === "approval" || interaction.kind === "permissions") {
    if (action.mode !== "decision" || !isApprovalDecision(action.value)) {
      return { ok: false, message: "无效的审批操作" };
    }
    if (interaction.kind === "approval") {
      return {
        ok: true,
        answerText: approvalLabel(action.value),
        appendedText: approvalLabel(action.value),
        response: approvalLikeResponse(request, action.value),
      };
    }
    return {
      ok: true,
      answerText: approvalLabel(action.value),
      appendedText: approvalLabel(action.value),
      response: permissionsResponse(request, action.value),
    };
  }

  if (interaction.kind === "tool_user_input") {
    if (action.mode === "action" && action.value === "cancel") {
      return {
        ok: true,
        answerText: "已取消",
        appendedText: "已取消",
        response: REJECT_RESPONSE,
      };
    }
    const response = toolUserInputResponseFromAnswer(request, action);
    if (!response) return { ok: false, message: "无效的输入选项" };
    return {
      ok: true,
      answerText: "已提交",
      appendedText: summarizeToolUserInputResponse(response),
      response,
    };
  }

  if (interaction.kind === "mcp_elicitation_url") {
    if (action.mode !== "action" || !isMcpAction(action.value)) {
      return { ok: false, message: "无效的 MCP 操作" };
    }
    return {
      ok: true,
      answerText: mcpActionLabel(action.value),
      appendedText: mcpActionLabel(action.value),
      response: {
        action: action.value,
        content: null,
        _meta: null,
      },
    };
  }

  if (action.mode === "action" && action.value === "cancel") {
    return {
      ok: true,
      answerText: "已取消",
      appendedText: "已取消",
      response: {
        action: "cancel",
        content: null,
        _meta: null,
      },
    };
  }
  const response = mcpFormResponseFromAnswer(request, action);
  if (!response) return { ok: false, message: "无效的 MCP 表单输入" };
  return {
    ok: true,
    answerText: "已提交",
    appendedText: summarizeJson(response.content),
    response,
  };
}

export function parseInteractionTextReply(
  interaction: PendingInteraction,
  request: SupportedServerRequest,
  text: string,
):
  | { ok: true; appendedText: string; response: unknown }
  | { ok: false; message: string } {
  if (interaction.kind === "tool_user_input") {
    return parseToolUserInputText(request, text);
  }
  if (interaction.kind === "mcp_elicitation_form") {
    return parseMcpFormText(request, text);
  }
  return { ok: false, message: "当前交互不接受文本回复。" };
}

function approvalLikeResponse(request: SupportedServerRequest, decision: ApprovalDecision): unknown {
  if (request.method === "item/commandExecution/requestApproval") {
    return { decision: decision as CommandExecutionApprovalDecision };
  }
  if (request.method === "item/fileChange/requestApproval") {
    return { decision: decision as FileChangeApprovalDecision };
  }
  return { decision: legacyReviewDecision(decision) };
}

function permissionsResponse(
  request: SupportedServerRequest,
  decision: ApprovalDecision,
): PermissionsRequestApprovalResponse | typeof REJECT_RESPONSE {
  if (request.method !== "item/permissions/requestApproval") {
    return REJECT_RESPONSE;
  }
  if (decision === "decline" || decision === "cancel") {
    return REJECT_RESPONSE;
  }
  const permissions: PermissionsRequestApprovalResponse["permissions"] = {};
  if (request.params.permissions.network) {
    permissions.network = request.params.permissions.network;
  }
  if (request.params.permissions.fileSystem) {
    permissions.fileSystem = request.params.permissions.fileSystem;
  }
  return {
    permissions,
    scope: decision === "acceptForSession" ? "session" : "turn",
  };
}

function legacyReviewDecision(decision: ApprovalDecision): ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
      return "approved_for_session";
    case "decline":
      return "denied";
    case "cancel":
      return "abort";
  }
}

function parseToolUserInputText(
  request: SupportedServerRequest,
  text: string,
):
  | { ok: true; appendedText: string; response: ToolRequestUserInputResponse }
  | { ok: false; message: string } {
  if (request.method !== "item/tool/requestUserInput") {
    return { ok: false, message: "无效的输入请求" };
  }

  const singleQuestion = request.params.questions.length === 1 ? request.params.questions[0]! : null;
  if (singleQuestion) {
    const raw = text.includes(":") ? text.split(":").slice(1).join(":").trim() : text;
    const parsed = parseToolUserInputAnswersForQuestion(singleQuestion, raw);
    if (!parsed.ok) {
      return { ok: false, message: parsed.message };
    }
    return {
      ok: true,
      appendedText: summarizeToolUserInputResponse({ answers: { [singleQuestion.id]: { answers: parsed.answers } } }),
      response: {
        answers: {
          [singleQuestion.id]: {
            answers: parsed.answers,
          },
        },
      },
    };
  }

  const parsedById = parseKeyValueLines(text);
  if (!parsedById.ok) {
    return { ok: false, message: parsedById.message };
  }
  const answers: ToolRequestUserInputResponse["answers"] = {};
  for (const question of request.params.questions) {
    const raw = parsedById.values.get(question.id);
    if (!raw) {
      return { ok: false, message: `缺少 ${question.id} 的回答。` };
    }
    const parsed = parseToolUserInputAnswersForQuestion(question, raw);
    if (!parsed.ok) {
      return { ok: false, message: `${question.id}: ${parsed.message}` };
    }
    answers[question.id] = { answers: parsed.answers };
  }
  const response = { answers };
  return {
    ok: true,
    appendedText: summarizeToolUserInputResponse(response),
    response,
  };
}

function toolUserInputResponseFromAnswer(
  request: SupportedServerRequest,
  action: CallbackAction,
): ToolRequestUserInputResponse | null {
  if (request.method !== "item/tool/requestUserInput" || action.mode !== "answer") return null;
  const singleChoice = getSingleQuestionOptions(request);
  if (!singleChoice) return null;
  const index = Number(action.value);
  if (!Number.isInteger(index) || index < 0 || index >= singleChoice.options.length) return null;
  const question = request.params.questions[0]!;
  const option = singleChoice.options[index]!;
  return {
    answers: {
      [question.id]: {
        answers: [option.label],
      },
    },
  };
}

function parseMcpFormText(
  request: SupportedServerRequest,
  text: string,
):
  | { ok: true; appendedText: string; response: { action: McpServerElicitationAction; content: unknown; _meta: null } }
  | { ok: false; message: string } {
  if (request.method !== "mcpServer/elicitation/request" || request.params.mode !== "form") {
    return { ok: false, message: "无效的 MCP 表单请求" };
  }

  const properties = request.params.requestedSchema.properties;
  const keys = Object.keys(properties);
  let rawValues: Map<string, string>;

  if (keys.length === 1 && !text.includes(":")) {
    rawValues = new Map([[keys[0]!, text]]);
  } else {
    const parsed = parseKeyValueLines(text);
    if (!parsed.ok) return { ok: false, message: parsed.message };
    rawValues = parsed.values;
  }

  const content: Record<string, unknown> = {};
  const required = new Set(request.params.requestedSchema.required ?? []);

  for (const [name, schema] of Object.entries(properties)) {
    const raw = rawValues.get(name);
    if (!raw || raw.trim() === "") {
      if (required.has(name)) {
        return { ok: false, message: `缺少 ${name} 的输入。` };
      }
      continue;
    }
    const parsed = parseSchemaValue(schema as Record<string, unknown>, raw);
    if (!parsed.ok) {
      return { ok: false, message: `${name}: ${parsed.message}` };
    }
    content[name] = parsed.value;
  }

  return {
    ok: true,
    appendedText: summarizeJson(content),
    response: {
      action: "accept",
      content,
      _meta: null,
    },
  };
}

function mcpFormResponseFromAnswer(
  request: SupportedServerRequest,
  action: CallbackAction,
): { action: McpServerElicitationAction; content: unknown; _meta: null } | null {
  if (request.method !== "mcpServer/elicitation/request" || request.params.mode !== "form" || action.mode !== "answer") {
    return null;
  }
  const formRequest = request as McpFormRequest;
  const properties = Object.entries(formRequest.params.requestedSchema.properties);
  if (properties.length !== 1) return null;
  const [name, schema] = properties[0]!;
  const options = getSingleFieldAnswerOptions(formRequest);
  if (!options) return null;
  const index = Number(action.value);
  if (!Number.isInteger(index) || index < 0 || index >= options.length) return null;
  const raw = options[index]!;
  const parsed = parseSchemaValue(schema as Record<string, unknown>, raw);
  if (!parsed.ok) return null;
  return {
    action: "accept",
    content: {
      [name]: parsed.value,
    },
    _meta: null,
  };
}

function parseToolUserInputAnswersForQuestion(
  question: ToolUserInputRequest["params"]["questions"][number],
  raw: string,
): { ok: true; answers: string[] } | { ok: false; message: string } {
  const cleaned = raw.trim();
  if (!cleaned) {
    return { ok: false, message: "回答不能为空。" };
  }
  const answers = cleaned
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (answers.length === 0) {
    return { ok: false, message: "回答不能为空。" };
  }
  if (!question.options || question.options.length === 0) {
    return { ok: true, answers };
  }
  const labels = new Map(question.options.map((option) => [normalizeKey(option.label), option.label]));
  const normalizedAnswers: string[] = [];
  for (const answer of answers) {
    const matched = labels.get(normalizeKey(answer));
    if (matched) {
      normalizedAnswers.push(matched);
      continue;
    }
    if (question.isOther) {
      normalizedAnswers.push(answer);
      continue;
    }
    return {
      ok: false,
      message: `无效选项：${answer}。请直接回复现有选项文字。`,
    };
  }
  return { ok: true, answers: normalizedAnswers };
}

function parseKeyValueLines(text: string): { ok: true; values: Map<string, string> } | { ok: false; message: string } {
  const values = new Map<string, string>();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, message: "输入不能为空。" };
  }
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      return { ok: false, message: "请按“字段键: 值”的格式逐行回复。" };
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) {
      return { ok: false, message: "请按“字段键: 值”的格式逐行回复。" };
    }
    values.set(key, value);
  }
  return { ok: true, values };
}

function parseSchemaValue(
  schema: Record<string, unknown>,
  raw: string,
): { ok: true; value: unknown } | { ok: false; message: string } {
  if (schema.type === "string") {
    if (Array.isArray(schema.enum)) {
      const matched = findEnumValue(schema.enum as string[], raw);
      return matched ? { ok: true, value: matched } : { ok: false, message: `必须是以下选项之一: ${(schema.enum as string[]).join(", ")}` };
    }
    if (Array.isArray(schema.oneOf)) {
      const options = (schema.oneOf as Array<{ const: string; title?: string }>).map((option) => option.const);
      const matched = findEnumValue(options, raw);
      return matched ? { ok: true, value: matched } : { ok: false, message: `必须是以下选项之一: ${options.join(", ")}` };
    }
    if (typeof schema.minLength === "number" && raw.length < schema.minLength) {
      return { ok: false, message: `长度不能少于 ${schema.minLength}` };
    }
    if (typeof schema.maxLength === "number" && raw.length > schema.maxLength) {
      return { ok: false, message: `长度不能超过 ${schema.maxLength}` };
    }
    return { ok: true, value: raw };
  }

  if (schema.type === "number" || schema.type === "integer") {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, message: "必须是数字。" };
    if (schema.type === "integer" && !Number.isInteger(value)) {
      return { ok: false, message: "必须是整数。" };
    }
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return { ok: false, message: `不能小于 ${schema.minimum}` };
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return { ok: false, message: `不能大于 ${schema.maximum}` };
    }
    return { ok: true, value };
  }

  if (schema.type === "boolean") {
    const normalized = normalizeKey(raw);
    if (["true", "yes", "y", "1", "on"].includes(normalized)) {
      return { ok: true, value: true };
    }
    if (["false", "no", "n", "0", "off"].includes(normalized)) {
      return { ok: true, value: false };
    }
    return { ok: false, message: "必须是 true/false、yes/no、on/off 之一。" };
  }

  if (schema.type === "array" && schema.items && typeof schema.items === "object") {
    const options = Array.isArray((schema.items as { enum?: string[] }).enum)
      ? ((schema.items as { enum: string[] }).enum ?? [])
      : Array.isArray((schema.items as { anyOf?: Array<{ const: string }> }).anyOf)
        ? (((schema.items as { anyOf: Array<{ const: string }> }).anyOf ?? []).map((item) => item.const))
        : [];
    if (options.length === 0) {
      return { ok: false, message: "不支持的多选 schema。" };
    }
    const values = raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (values.length === 0) {
      return { ok: false, message: "至少选择一个值。" };
    }
    const matched = values.map((value) => findEnumValue(options, value));
    if (matched.some((value) => !value)) {
      return { ok: false, message: `必须是以下选项之一: ${options.join(", ")}` };
    }
    return { ok: true, value: matched as string[] };
  }

  return { ok: false, message: "不支持的字段类型。" };
}
