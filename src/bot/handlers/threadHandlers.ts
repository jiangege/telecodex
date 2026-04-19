import type { CommandContext, Context } from "grammy";
import { codeBlockField, codeField, replyDocument, replyNotice, replyUsage, textField } from "../../telegram/replyDocument.js";
import {
  contextLogFields,
  getWorkspaceForContext,
  hasTopicContext,
  isPrivateChat,
  parseSubcommand,
  requireScopedSession,
} from "../commandContext.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import { isSessionBusy } from "../sessionState.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";
import { makeSessionKey, type SessionStore, type TelegramSession } from "../../store/sessionStore.js";

const WORKSPACE_REQUIRED_MESSAGE = "This supergroup has no working root yet.\nRun /workspace <absolute-path> first.";
type WorkspaceCommandContext = CommandContext<Context>;

export function registerThreadHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, logger } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }

  bot.command("thread", wrapUserFacingHandler("thread", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, "The thread command is only available inside workspace supergroups.");
      return;
    }

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      if (hasTopicContext(ctx)) {
        const workspace = getWorkspaceForContext(ctx, workspaces);
        const session = await requireScopedSession(ctx, sessions, workspaces, config);
        if (!workspace || !session) return;
        await replyDocument(ctx, {
          title: "Current thread",
          fields: [
            codeField("thread", session.codexThreadId ?? "not created"),
            ...(session.codexThreadId
              ? [codeBlockField("pc resume", buildCliResumeCommand(workspace.workingRoot, session.codexThreadId))]
              : []),
          ],
          footer: [
            "Manage threads in this workspace:",
            "/thread list",
            "/thread new",
            "/thread resume <threadId>",
            "Use /status for runtime state and recent SDK events.",
            ...(session.codexThreadId
              ? ["SDK-created threads may not appear in Codex Desktop yet. Use the pc resume command above on your Mac or PC shell."]
              : []),
          ],
        });
        return;
      }
      await replyNotice(
        ctx,
        [
          "Use /thread list in the root chat.",
          "Create or open a Telegram forum topic, then use /thread new or /thread resume <threadId> inside that topic.",
        ].join("\n"),
      );
      return;
    }

    if (command === "list") {
      await listWorkspaceThreads(ctx, deps);
      return;
    }
    if (command === "resume") {
      if (!args) {
        await replyUsage(ctx, "/thread resume <threadId>");
        return;
      }
      if (!hasTopicContext(ctx)) {
        await replyNotice(ctx, "Create or open a Telegram forum topic, then run /thread resume <threadId> inside that topic.");
        return;
      }
      await resumeThreadInCurrentTopic(ctx, deps, args);
      return;
    }
    if (command === "new") {
      if (args) {
        await replyUsage(ctx, "/thread new");
        return;
      }
      if (!hasTopicContext(ctx)) {
        await replyNotice(ctx, "Create or open a Telegram forum topic, then run /thread new inside that topic.");
        return;
      }
      await startFreshThreadInCurrentTopic(ctx, deps);
      return;
    }

    await replyUsage(ctx, ["/thread list", "/thread new", "/thread resume <threadId>"]);
  }));

  bot.on(["message:forum_topic_created", "message:forum_topic_edited"], async (ctx) => {
    const threadId = ctx.message.message_thread_id;
    if (threadId == null) return;

    const topicName = ctx.message.forum_topic_created?.name ?? ctx.message.forum_topic_edited?.name ?? null;
    if (!topicName) return;

    const sessionKey = makeSessionKey(ctx.chat.id, threadId);
    const session = sessions.get(sessionKey);
    if (!session) return;

    sessions.setTelegramTopicName(sessionKey, topicName);
  });
}

async function resumeThreadInCurrentTopic(
  ctx: WorkspaceCommandContext,
  deps: BotHandlerDeps,
  threadId: string,
): Promise<void> {
  const { config, sessions, logger, threadCatalog } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }
  const workspace = getWorkspaceForContext(ctx, workspaces);
  if (!workspace) {
    await replyNotice(ctx, WORKSPACE_REQUIRED_MESSAGE);
    return;
  }

  const session = await requireScopedSession(ctx, sessions, workspaces, config);
  if (!session) return;
  const latest = await requireIdleThreadMutationTarget(ctx, deps, session);
  if (!latest) return;

  const thread = await threadCatalog.findProjectThreadById({
    projectRoot: workspace.workingRoot,
    threadId,
  });
  if (!thread) {
    await replyDocument(ctx, {
      title: "Could not find a saved Codex thread with that id under this working root.",
      fields: [
        codeField("working root", workspace.workingRoot),
        codeField("thread", threadId),
      ],
      footer: "Run /thread list to inspect the saved workspace threads first.",
    });
    return;
  }

  if (latest.codexThreadId === thread.id) {
    await replyNotice(ctx, "This topic is already bound to that Codex thread.");
    return;
  }

  sessions.bindThread(latest.sessionKey, thread.id);
  resetTopicSessionState(sessions, latest.sessionKey);
  const updated = sessions.get(latest.sessionKey) ?? latest;

  logger?.info("thread id bound into current topic", {
    ...contextLogFields(ctx),
    sessionKey: updated.sessionKey,
    threadId: thread.id,
    topicName: updated.telegramTopicName,
  });

  await replyDocument(ctx, {
    title: "Current topic is now bound to the existing thread id.",
    fields: [
      textField("topic", updated.telegramTopicName ?? "current topic"),
      textField("topic id", updated.messageThreadId ?? "unknown"),
      codeField("thread", thread.id),
      codeBlockField("pc resume", buildCliResumeCommand(workspace.workingRoot, thread.id)),
    ],
    footer: "Future messages in this topic will continue on that thread through the Codex SDK.",
  });
}

async function startFreshThreadInCurrentTopic(
  ctx: WorkspaceCommandContext,
  deps: BotHandlerDeps,
): Promise<void> {
  const { config, sessions, logger } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }
  const session = await requireScopedSession(ctx, sessions, workspaces, config);
  if (!session) return;
  const latest = await requireIdleThreadMutationTarget(ctx, deps, session);
  if (!latest) return;

  sessions.bindThread(latest.sessionKey, null);
  resetTopicSessionState(sessions, latest.sessionKey);
  const updated = sessions.get(latest.sessionKey) ?? latest;

  logger?.info("current topic reset to a new codex thread", {
    ...contextLogFields(ctx),
    sessionKey: updated.sessionKey,
    previousThreadId: latest.codexThreadId,
    topicName: updated.telegramTopicName,
  });

  await replyDocument(ctx, {
    title: "Current topic is ready for a new thread.",
    fields: [
      textField("topic", updated.telegramTopicName ?? "current topic"),
      textField("topic id", updated.messageThreadId ?? "unknown"),
      codeField("thread", "not created"),
    ],
    footer: "Your next normal message in this topic will start a new Codex thread.",
  });
}

async function listWorkspaceThreads(ctx: WorkspaceCommandContext, deps: BotHandlerDeps): Promise<void> {
  const { sessions, threadCatalog } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }
  const workspace = getWorkspaceForContext(ctx, workspaces);
  if (!workspace) {
    await replyNotice(ctx, WORKSPACE_REQUIRED_MESSAGE);
    return;
  }

  const threads = await threadCatalog.listProjectThreads({
    projectRoot: workspace.workingRoot,
    limit: 8,
  });
  if (threads.length === 0) {
    await replyDocument(ctx, {
      title: "No saved Codex threads were found for this workspace yet.",
      fields: [codeField("working root", workspace.workingRoot)],
    });
    return;
  }

  await replyDocument(ctx, {
    title: "Saved Codex threads",
    fields: [
      codeField("workspace", workspace.name),
      codeField("working root", workspace.workingRoot),
    ],
    sections: threads.map((thread, index) => {
      const bound = sessions.getByThreadId(thread.id);
      return {
        title: `${index + 1}. ${thread.preview}`,
        fields: [
          codeField("id", thread.id),
          codeField("resume", `/thread resume ${thread.id}`),
          codeBlockField("pc resume", buildCliResumeCommand(workspace.workingRoot, thread.id)),
          textField("updated", thread.updatedAt),
          textField("source", thread.source ?? "unknown"),
          ...(bound
            ? [textField("bound", bound.telegramTopicName ?? bound.messageThreadId ?? bound.sessionKey)]
            : []),
        ],
      };
    }),
    footer: "Copy a thread id or the pc resume command above.",
  });
}

async function requireIdleThreadMutationTarget(
  ctx: WorkspaceCommandContext,
  deps: BotHandlerDeps,
  session: TelegramSession,
): Promise<TelegramSession | null> {
  const { sessions, codex } = deps;
  const latest = sessions.get(session.sessionKey) ?? session;
  if (isSessionBusy(latest) || codex.isRunning(latest.sessionKey)) {
    await replyNotice(ctx, "Stop the current run before changing the thread binding for this topic.");
    return null;
  }
  return latest;
}

function resetTopicSessionState(sessions: SessionStore, sessionKey: string): void {
  sessions.setOutputMessage(sessionKey, null);
  sessions.setRuntimeState(sessionKey, {
    status: "idle",
    detail: null,
    updatedAt: new Date().toISOString(),
  });
}

function buildCliResumeCommand(workingRoot: string, threadId: string): string {
  return `cd ${shellQuote(workingRoot)} && codex resume --include-non-interactive ${shellQuote(threadId)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
