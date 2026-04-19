import type { Context } from "grammy";
import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  type SessionReasoningEffort,
} from "../config.js";
import type { WorkspaceBinding, WorkspaceStore } from "../store/workspaceStore.js";
import { getWorkspaceForContext, isPrivateChat } from "./commandContext.js";

export function formatHelpText(ctx: Context, workspaces: WorkspaceStore): string {
  if (isPrivateChat(ctx)) {
    return [
      "telecodex is ready.",
      "",
      "Primary workflow:",
      "1. One forum supergroup = one workspace",
      "2. Create or open a Telegram topic yourself",
      "3. Send normal messages directly inside the topic",
      "",
      "Run this first in the workspace group:",
      "/workspace <absolute-path>",
      "",
      "Then inspect saved threads in the group:",
      "/thread list",
      "",
      "Inside a topic, send messages directly:",
      "/thread new",
      "/thread resume <threadId>",
      "tap Stop on the working message",
      "/stop (fallback)",
      "/admin",
      "",
      formatPrivateWorkspaceSummary(workspaces),
    ].join("\n");
  }

  const workspace = getWorkspaceForContext(ctx, workspaces);
  if (!workspace) {
    return [
      "This supergroup has no working root yet.",
      "",
      "Run this first:",
      "/workspace <absolute-path>",
      "",
      "After that, each topic acts as an independent Codex thread under the shared working root.",
    ].join("\n");
  }

  return [
    "telecodex is ready.",
    "",
    `workspace: ${workspace.name}`,
    `working root: ${workspace.workingRoot}`,
    "",
    "/workspace show or set the working root",
    "/thread list show saved Codex threads already recorded for this working root",
    "/thread new reset the current topic so the next message starts a new thread",
    "/thread resume <threadId> bind the current topic to an existing thread",
    "send a normal message inside a topic to the current thread",
    "/status show topic state and recent SDK events",
    "/stop interrupt the current SDK run if the Stop button is unavailable",
    `/mode ${MODE_PRESETS.join("|")}`,
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

export function formatPrivateWorkspaceSummary(workspaces: WorkspaceStore): string {
  const bound = workspaces.list();
  if (bound.length === 0) {
    return "No workspace supergroups are currently bound.";
  }
  return `Bound workspace supergroups: ${bound.length}`;
}

export function formatPrivateWorkspaceList(workspaces: WorkspaceStore): string {
  const bound = workspaces.list();
  if (bound.length === 0) {
    return "No workspace supergroups are currently bound.";
  }
  return [
    "Bound workspaces:",
    ...bound.map((workspace, index) => `${index + 1}. ${workspace.name}\n   working root: ${workspace.workingRoot}\n   chat: ${workspace.chatId}`),
  ].join("\n");
}

export function formatWorkspaceStatus(workspace: WorkspaceBinding): string {
  return [
    "Workspace status",
    `workspace: ${workspace.name}`,
    `working root: ${workspace.workingRoot}`,
    "This supergroup uses one shared working root. Create or open a Telegram topic, then use /thread new or /thread resume inside that topic.",
  ].join("\n");
}

export function formatProfileReply(prefix: string, sandboxMode: string, approvalPolicy: string): string {
  return [prefix, `sandbox: ${sandboxMode}`, `approval: ${approvalPolicy}`].join("\n");
}

export function formatReasoningEffort(value: SessionReasoningEffort | null): string {
  return value ?? "codex-default";
}
