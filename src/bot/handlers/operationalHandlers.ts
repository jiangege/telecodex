import { presetFromProfile } from "../../config.js";
import { generateBindingCode } from "../../runtime/bindingCodes.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { codeField, replyDocument, replyError, replyNotice, replyUsage, textField } from "../../telegram/replyDocument.js";
import {
  contextLogFields,
  getWorkspaceForContext,
  hasTopicContext,
  isPrivateChat,
  parseSubcommand,
  requireScopedSession,
} from "../commandContext.js";
import {
  formatHelpText,
  formatWorkspaceStatus,
  formatReasoningEffort,
} from "../helpText.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import { refreshSessionIfActiveTurnIsStale } from "../run/staleRunRecovery.js";
import { formatIsoTimestamp, sessionLogFields } from "../sessionState.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

export async function interruptActiveRun(input: {
  sessionKey: string;
  codex: BotHandlerDeps["codex"];
}): Promise<boolean> {
  return input.codex.interrupt(input.sessionKey);
}

export function registerOperationalHandlers(deps: BotHandlerDeps): void {
  const { bot, config, sessions, admin, codex, buffers, logger } = deps;
  const workspaces = deps.workspaces ?? deps.projects;
  if (!workspaces) {
    throw new Error("Workspace store is required");
  }

  bot.command(["start", "help"], wrapUserFacingHandler("help", logger, async (ctx) => {
    await replyNotice(ctx, formatHelpText(ctx, workspaces));
  }));

  bot.command("admin", wrapUserFacingHandler("admin", logger, async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await replyNotice(ctx, "Use /admin in the bot private chat.");
      return;
    }

    const authorizedUserId = admin.getAuthorizedUserId();
    if (authorizedUserId == null) {
      await replyNotice(ctx, "Admin binding is not completed yet.");
      return;
    }

    const { command } = parseSubcommand(ctx.match.trim());
    const binding = admin.getBindingCodeState();
    if (!command || command === "status") {
      await replyDocument(ctx, {
        title: "Admin status",
        fields: [
          textField("authorized telegram user id", authorizedUserId),
          textField(
            "pending handoff",
            binding?.mode === "rebind"
              ? `active until ${formatIsoTimestamp(binding.expiresAt)} (${binding.maxAttempts - binding.attempts} attempts remaining)`
              : "none",
          ),
        ],
        footer: "Usage: /admin | /admin rebind | /admin cancel",
      });
      return;
    }

    if (command === "rebind") {
      const next = admin.issueBindingCode({
        code: generateBindingCode("rebind"),
        mode: "rebind",
        issuedByUserId: authorizedUserId,
      });
      await replyDocument(ctx, {
        title: "Admin handoff code created.",
        fields: [
          textField("expires at", formatIsoTimestamp(next.expiresAt)),
          textField("max failed attempts", next.maxAttempts),
          codeField("code", next.code),
        ],
        footer: "Send this code from the target Telegram account in this bot's private chat to transfer control.",
      });
      return;
    }

    if (command === "cancel") {
      if (binding?.mode !== "rebind") {
        await replyNotice(ctx, "No pending admin handoff.");
        return;
      }
      admin.clearBindingCode();
      await replyNotice(ctx, "Cancelled the pending admin handoff.");
      return;
    }

    await replyUsage(ctx, "/admin | /admin rebind | /admin cancel");
  }));

  bot.command("status", wrapUserFacingHandler("status", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(
        ctx,
        "Use /admin in the bot private chat for binding and handoff status. /status is for workspace and topic runtime state.",
      );
      return;
    }

    const workspace = getWorkspaceForContext(ctx, workspaces);
    if (!workspace) {
      await replyNotice(ctx, "This supergroup has no working root yet.\nRun /workspace <absolute-path> first.");
      return;
    }

    if (!hasTopicContext(ctx)) {
      await replyNotice(ctx, formatWorkspaceStatus(workspace));
      return;
    }

    const session = await requireScopedSession(ctx, sessions, workspaces, config);
    if (!session) return;

    const latestSession = await refreshSessionIfActiveTurnIsStale(session, sessions, codex, buffers, bot, logger);
    const activeRun = codex.getActiveRun(latestSession.sessionKey);

    await replyDocument(ctx, {
      title: "Status",
      fields: [
        codeField("workspace", workspace.name),
        codeField("working root", workspace.workingRoot),
        codeField("thread", latestSession.codexThreadId ?? "not created"),
        textField("state", formatSessionRuntimeStatus(latestSession.runtimeStatus)),
        textField("state detail", latestSession.runtimeStatusDetail ?? "none"),
        textField("state updated", formatIsoTimestamp(latestSession.runtimeStatusUpdatedAt)),
        textField("active run", activeRun ? formatIsoTimestamp(activeRun.startedAt) : "none"),
        codeField("active run thread", activeRun?.threadId ?? "none"),
        textField("active run last event", activeRun?.lastEventType ?? "none"),
        textField("active run last update", activeRun ? formatIsoTimestamp(activeRun.lastEventAt) : "none"),
        textField("preset", presetFromProfile(latestSession)),
        textField("sandbox", latestSession.sandboxMode),
        textField("approval", latestSession.approvalPolicy),
        textField("network", latestSession.networkAccessEnabled ? "on" : "off"),
        textField("web", latestSession.webSearchMode ?? "codex-default"),
        textField("git check", latestSession.skipGitRepoCheck ? "skip" : "enforce"),
        textField("add dirs", latestSession.additionalDirectories.length),
        textField("schema", latestSession.outputSchema ? "set" : "none"),
        textField("model", latestSession.model),
        textField("effort", formatReasoningEffort(latestSession.reasoningEffort)),
      ],
    });
  }));

  bot.command("stop", wrapUserFacingHandler("stop", logger, async (ctx) => {
    const session = await requireScopedSession(ctx, sessions, workspaces, config);
    if (!session) return;

    const latest = await refreshSessionIfActiveTurnIsStale(session, sessions, codex, buffers, bot, logger);
    if (!codex.isRunning(session.sessionKey)) {
      await replyNotice(ctx, "There is no active Codex SDK turn right now.");
      return;
    }

    try {
      await interruptActiveRun({
        sessionKey: session.sessionKey,
        codex,
      });
    } catch (error) {
      logger?.warn("interrupt turn failed", {
        ...contextLogFields(ctx),
        ...sessionLogFields(latest),
        error,
      });
      await replyError(ctx, `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}
