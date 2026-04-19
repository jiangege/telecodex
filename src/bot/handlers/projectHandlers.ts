import { replyDocument, replyError, replyNotice, replyUsage, codeField } from "../../telegram/replyDocument.js";
import { resolveExistingDirectory } from "../../pathScope.js";
import {
  contextLogFields,
  getWorkspaceForContext,
  isPrivateChat,
  isSupergroupChat,
  requireScopedSession,
} from "../commandContext.js";
import {
  formatPrivateWorkspaceList,
  formatWorkspaceStatus,
} from "../helpText.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

const WORKSPACE_REQUIRED_MESSAGE = "This supergroup has no working root yet.\nRun /workspace <absolute-path> first.";

export function registerWorkspaceHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, logger } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }

  bot.command("workspace", wrapUserFacingHandler("workspace", logger, async (ctx) => {
    const args = ctx.match.trim();

    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, formatPrivateWorkspaceList(workspaces));
      return;
    }

    if (!isSupergroupChat(ctx)) {
      await replyNotice(ctx, "Use telecodex inside a supergroup with forum topics enabled.");
      return;
    }

    if (!args) {
      const workspace = getWorkspaceForContext(ctx, workspaces);
      await replyNotice(ctx, workspace ? formatWorkspaceStatus(workspace) : WORKSPACE_REQUIRED_MESSAGE);
      return;
    }

    try {
      const workingRoot = resolveExistingDirectory(args);
      const workspace = workspaces.upsert({
        chatId: String(ctx.chat.id),
        workingRoot,
      });
      logger?.info("workspace root updated", {
        ...contextLogFields(ctx),
        workspace: workspace.name,
        workingRoot: workspace.workingRoot,
      });
      await requireScopedSession(ctx, sessions, workspaces, config, { requireTopic: false });
      await replyDocument(ctx, {
        title: "Working root updated.",
        fields: [
          codeField("workspace", workspace.name),
          codeField("working root", workspace.workingRoot),
        ],
        footer: "This supergroup now works from one shared working root, and each topic maps to one Codex thread.",
      });
    } catch (error) {
      await replyError(ctx, error instanceof Error ? error.message : String(error));
    }
  }));

  bot.command("project", wrapUserFacingHandler("project", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, "The project command was renamed. Use /workspace in the supergroup or private chat.");
      return;
    }
    if (!isSupergroupChat(ctx)) {
      await replyNotice(ctx, "Use telecodex inside a supergroup with forum topics enabled.");
      return;
    }
    const args = ctx.match.trim();
    if (!args) {
      try {
        await replyNotice(ctx, "The project command was renamed. Use /workspace to show or set the working root.");
      } catch (error) {
        await replyError(ctx, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    await replyNotice(ctx, "The project command was renamed. Use /workspace <absolute-path> to set the working root.");
  }));
}
