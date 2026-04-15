import { presetFromProfile } from "../../config.js";
import { generateBindingCode } from "../../runtime/bindingCodes.js";
import { formatSessionRuntimeStatus } from "../../runtime/sessionRuntime.js";
import { refreshSessionIfActiveTurnIsStale } from "../inputService.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  contextLogFields,
  formatHelpText,
  formatPrivateStatus,
  formatProjectStatus,
  formatReasoningEffort,
  getProjectForContext,
  hasTopicContext,
  isPrivateChat,
  parseSubcommand,
  requireScopedSession,
} from "../commandSupport.js";
import { formatIsoTimestamp, sessionLogFields } from "../sessionFlow.js";
import { codeField, replyDocument, replyError, replyNotice, replyUsage, textField } from "../../telegram/formatted.js";
import { wrapUserFacingHandler } from "../userFacingErrors.js";

export function registerOperationalHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, codex, logger } = deps;

  bot.command(["start", "help"], wrapUserFacingHandler("help", logger, async (ctx) => {
    await replyNotice(ctx, formatHelpText(ctx, projects));
  }));

  bot.command("admin", wrapUserFacingHandler("admin", logger, async (ctx) => {
    if (!isPrivateChat(ctx)) {
      await replyNotice(ctx, "Use /admin in the bot private chat.");
      return;
    }

    const authorizedUserId = store.getAuthorizedUserId();
    if (authorizedUserId == null) {
      await replyNotice(ctx, "Admin binding is not completed yet.");
      return;
    }

    const { command } = parseSubcommand(ctx.match.trim());
    const binding = store.getBindingCodeState();
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
      const next = store.issueBindingCode({
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
      store.clearBindingCode();
      await replyNotice(ctx, "Cancelled the pending admin handoff.");
      return;
    }

    await replyUsage(ctx, "/admin | /admin rebind | /admin cancel");
  }));

  bot.command("status", wrapUserFacingHandler("status", logger, async (ctx) => {
    if (isPrivateChat(ctx)) {
      await replyNotice(ctx, formatPrivateStatus(store, projects));
      return;
    }

    const project = getProjectForContext(ctx, projects);
    if (!project) {
      await replyNotice(ctx, "This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.");
      return;
    }

    if (!hasTopicContext(ctx)) {
      await replyNotice(ctx, formatProjectStatus(project));
      return;
    }

    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const latestSession = await refreshSessionIfActiveTurnIsStale(session, store, codex, bot, logger);
    const queueDepth = store.getQueuedInputCount(latestSession.sessionKey);
    const queuedPreview = store.listQueuedInputs(latestSession.sessionKey, 3);
    const activeRun = codex.getActiveRun(latestSession.sessionKey);

    await replyDocument(ctx, {
      title: "Status",
      fields: [
        codeField("project", project.name),
        codeField("root", project.cwd),
        codeField("thread", latestSession.codexThreadId ?? "not created"),
        textField("state", formatSessionRuntimeStatus(latestSession.runtimeStatus)),
        textField("state detail", latestSession.runtimeStatusDetail ?? "none"),
        textField("state updated", formatIsoTimestamp(latestSession.runtimeStatusUpdatedAt)),
        textField("active run", activeRun ? formatIsoTimestamp(activeRun.startedAt) : "none"),
        codeField("active run thread", activeRun?.threadId ?? "none"),
        textField("active run last event", activeRun?.lastEventType ?? "none"),
        textField("active run last update", activeRun ? formatIsoTimestamp(activeRun.lastEventAt) : "none"),
        textField("queue", queueDepth),
        textField("queue next", formatQueuedPreview(queuedPreview)),
        codeField("cwd", latestSession.cwd),
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

  bot.command("queue", wrapUserFacingHandler("queue", logger, async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      const queued = store.listQueuedInputs(session.sessionKey, 5);
      const queueDepth = store.getQueuedInputCount(session.sessionKey);
      await replyDocument(ctx, {
        title: "Queue",
        fields: [
          textField("state", formatSessionRuntimeStatus(session.runtimeStatus)),
          textField("queue", queueDepth),
        ],
        sections: [
          {
            title: "Items",
            lines: queued.length > 0 ? [formatQueuedItems(queued)] : ["none"],
          },
        ],
        footer: "Usage: /queue | /queue drop <id> | /queue clear",
      });
      return;
    }

    if (command === "clear") {
      const removed = store.clearQueuedInputs(session.sessionKey);
      await replyNotice(ctx, `Cleared the queue and removed ${removed} pending message(s).`);
      return;
    }

    if (command === "drop") {
      const id = Number(args);
      if (!Number.isInteger(id) || id <= 0) {
        await replyUsage(ctx, "/queue drop <id>");
        return;
      }
      const removed = store.removeQueuedInputForSession(session.sessionKey, id);
      await replyNotice(ctx, removed ? `Removed queued item #${id}.` : `Queued item #${id} was not found.`);
      return;
    }

    await replyUsage(ctx, "/queue | /queue drop <id> | /queue clear");
  }));

  bot.command("stop", wrapUserFacingHandler("stop", logger, async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const latest = store.get(session.sessionKey) ?? session;
    if (!codex.isRunning(session.sessionKey)) {
      await replyNotice(ctx, "There is no active Codex SDK turn right now.");
      return;
    }

    try {
      codex.interrupt(session.sessionKey);
      await replyNotice(ctx, "Interrupt requested for the current run. Waiting for Codex SDK to stop.");
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

function formatQueuedPreview(items: Array<{ text: string }>): string {
  if (items.length === 0) return "none";
  return items.map((item) => singleLinePreview(item.text)).join(" | ");
}

function formatQueuedItems(items: Array<{ id: number; text: string; createdAt: string }>): string {
  return items.map((item) => `#${item.id} ${singleLinePreview(item.text)} (${formatIsoTimestamp(item.createdAt)})`).join("\n");
}

function singleLinePreview(text: string, maxLength = 48): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}...`;
}
