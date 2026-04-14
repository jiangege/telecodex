import type { ToolRequestUserInputResponse } from "../generated/codex-app-server/v2/ToolRequestUserInputResponse.js";
import type { ApprovalDecision, McpFormRequest, ToolUserInputRequest } from "./approvalProtocol.js";

export function getSingleQuestionOptions(
  request: ToolUserInputRequest,
): { options: Array<{ label: string }>; allowOther: boolean } | null {
  if (request.params.questions.length !== 1) return null;
  const question = request.params.questions[0]!;
  if (!question.options || question.options.length === 0) return null;
  return {
    options: question.options,
    allowOther: question.isOther,
  };
}

export function getSingleFieldAnswerOptions(request: McpFormRequest): string[] | null {
  const properties = Object.values(request.params.requestedSchema.properties);
  if (properties.length !== 1) return null;
  const schema = properties[0] as Record<string, unknown>;
  if (schema.type === "boolean") return ["true", "false"];
  if (schema.type === "string" && Array.isArray(schema.enum)) {
    return schema.enum as string[];
  }
  if (schema.type === "string" && Array.isArray(schema.oneOf)) {
    return (schema.oneOf as Array<{ const: string }>).map((option) => option.const);
  }
  return null;
}

export function summarizeToolUserInputResponse(response: ToolRequestUserInputResponse): string {
  return Object.entries(response.answers)
    .map(([key, answer]) => `${key}: ${(answer?.answers ?? []).join(", ")}`)
    .join(" | ");
}

export function summarizeJson(value: unknown): string {
  if (value == null) return "空";
  if (typeof value === "string") return value;
  try {
    return truncate(JSON.stringify(value), 120);
  } catch {
    return "已提交";
  }
}

export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

export function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export function findEnumValue(options: string[], raw: string): string | null {
  const normalized = normalizeKey(raw);
  for (const option of options) {
    if (normalizeKey(option) === normalized) return option;
  }
  return null;
}

export function approvalLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case "accept":
      return "允许一次";
    case "acceptForSession":
      return "本会话允许";
    case "decline":
      return "拒绝";
    case "cancel":
      return "取消";
  }
}

export function mcpActionLabel(action: "accept" | "decline" | "cancel"): string {
  switch (action) {
    case "accept":
      return "接受";
    case "decline":
      return "拒绝";
    case "cancel":
      return "取消";
  }
}
