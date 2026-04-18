import { replyDocument, replyError, replyNotice, replyUsage, codeField } from "../../telegram/replyDocument.js";
import { resolveExistingDirectory } from "../../pathScope.js";
import {
  contextLogFields,
  getProjectForContext,
  isPrivateChat,
  isSupergroupChat,
  parseSubcommand,
  requireScopedSession,
} from "../commandContext.js";
import {
  formatPrivateProjectList,
  formatProjectStatus,
} from "../helpText.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

const PROJECT_REQUIRED_MESSAGE = "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.";

export function registerProjectHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, projects, logger } = deps;

  bot.command("project", wrapUserFacingHandler("project", logger, async (ctx) => {
    const { command, args } = parseSubcommand(ctx.match.trim());

    if (isPrivateChat(ctx)) {
      if (!command || command === "list" || command === "status") {
        await replyNotice(ctx, formatPrivateProjectList(projects));
        return;
      }
      await replyNotice(ctx, "Use /project bind inside a supergroup with topics enabled. Private chat is only for admin entry points.");
      return;
    }

    if (!isSupergroupChat(ctx)) {
      await replyNotice(ctx, "Use telecodex inside a supergroup with forum topics enabled.");
      return;
    }

    if (!command || command === "status") {
      const project = getProjectForContext(ctx, projects);
      await replyNotice(ctx, project ? formatProjectStatus(project) : PROJECT_REQUIRED_MESSAGE);
      return;
    }

    if (command === "bind") {
      if (!args) {
        await replyUsage(ctx, "/project bind <absolute-path>");
        return;
      }
      try {
        const cwd = resolveExistingDirectory(args);
        const project = projects.upsert({
          chatId: String(ctx.chat.id),
          cwd,
        });
        logger?.info("project bound", {
          ...contextLogFields(ctx),
          project: project.name,
          cwd: project.cwd,
        });
        const session = await requireScopedSession(ctx, sessions, projects, config, { requireTopic: false });
        if (session && session.cwd !== project.cwd) {
          sessions.setCwd(session.sessionKey, project.cwd);
        }
        await replyDocument(ctx, {
          title: "Project binding updated.",
          fields: [
            codeField("project", project.name),
            codeField("root", project.cwd),
          ],
          footer: "This supergroup now represents one project, and each topic maps to one Codex thread.",
        });
      } catch (error) {
        await replyError(ctx, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "unbind") {
      logger?.info("project unbound", {
        ...contextLogFields(ctx),
      });
      projects.remove(String(ctx.chat.id));
      await replyNotice(ctx, "Removed the project binding for this supergroup.");
      return;
    }

    await replyUsage(ctx, ["/project", "/project bind <absolute-path>", "/project unbind"]);
  }));
}
