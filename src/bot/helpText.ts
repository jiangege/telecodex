import type { Context } from "grammy";
import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type SessionReasoningEffort,
} from "../config.js";
import type { AdminStore } from "../store/adminStore.js";
import type { ProjectBinding, ProjectStore } from "../store/projectStore.js";
import { getProjectForContext, isPrivateChat } from "./commandContext.js";

export function formatHelpText(ctx: Context, projects: ProjectStore): string {
  if (isPrivateChat(ctx)) {
    return [
      "telecodex is ready.",
      "",
      "Primary workflow:",
      "1. One forum supergroup = one project",
      "2. Create or open a Telegram topic yourself",
      "3. Send normal messages directly inside the topic",
      "",
      "Run this first in the project group:",
      "/project bind <absolute-path>",
      "",
      "Then inspect saved threads in the group:",
      "/thread list",
      "",
      "Inside a topic, send messages directly:",
      "/thread new",
      "/thread resume <threadId>",
      "/status",
      "/stop",
      "/admin",
      "",
      formatPrivateProjectSummary(projects),
    ].join("\n");
  }

  const project = getProjectForContext(ctx, projects);
  if (!project) {
    return [
      "This supergroup has no project bound yet.",
      "",
      "Run this first:",
      "/project bind <absolute-path>",
      "",
      "After binding, each topic acts as an independent Codex thread.",
    ].join("\n");
  }

  return [
    "telecodex is ready.",
    "",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "",
    "/project show the project binding",
    "/project bind <absolute-path> update the project root",
    "/thread list show saved Codex threads already recorded for this project",
    "/thread new reset the current topic so the next message starts a new thread",
    "/thread resume <threadId> bind the current topic to an existing thread",
    "send a normal message inside a topic to the current thread",
    "/status show topic state and recent SDK events",
    "/stop interrupt the current SDK run",
    "/cwd <path> switch to a working subdirectory inside the project root",
    `/mode ${MODE_PRESETS.join("|")}`,
    `/sandbox ${SANDBOX_MODES.join("|")}`,
    `/approval ${APPROVAL_POLICIES.join("|")}`,
    "/yolo on|off",
    "/model <id>",
    `/effort default|${REASONING_EFFORTS.join("|")}`,
    "/web default|disabled|cached|live",
    "/network on|off",
    "/gitcheck skip|enforce",
    "/adddir list|add|add-external|drop|clear",
    "/schema show|set|clear",
    "/codexconfig show|set|clear",
  ].join("\n");
}

export function formatPrivateStatus(admin: AdminStore, projects: ProjectStore): string {
  const binding = admin.getBindingCodeState();
  return [
    "telecodex admin",
    `authorized telegram user id: ${admin.getAuthorizedUserId() ?? "not bound"}`,
    binding?.mode === "rebind" ? `pending handoff: active until ${binding.expiresAt}` : "pending handoff: none",
    "",
    formatPrivateProjectSummary(projects),
  ].join("\n");
}

export function formatPrivateProjectSummary(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "No project supergroups are currently bound.";
  }
  return `Bound project supergroups: ${bound.length}`;
}

export function formatPrivateProjectList(projects: ProjectStore): string {
  const bound = projects.list();
  if (bound.length === 0) {
    return "No project supergroups are currently bound.";
  }
  return [
    "Bound projects:",
    ...bound.map((project, index) => `${index + 1}. ${project.name}\n   root: ${project.cwd}\n   chat: ${project.chatId}`),
  ].join("\n");
}

export function formatProjectStatus(project: ProjectBinding): string {
  return [
    "Project status",
    `project: ${project.name}`,
    `root: ${project.cwd}`,
    "This supergroup represents one project. Create or open a Telegram topic, then use /thread new or /thread resume inside that topic.",
  ].join("\n");
}

export function formatProfileReply(prefix: string, sandboxMode: string, approvalPolicy: string): string {
  return [prefix, `sandbox: ${sandboxMode}`, `approval: ${approvalPolicy}`].join("\n");
}

export function formatReasoningEffort(value: SessionReasoningEffort | null): string {
  return value ?? "codex-default";
}
