import { presetFromProfile } from "../../config.js";
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
  getScopedSession,
  hasTopicContext,
  isPrivateChat,
  parseSubcommand,
} from "../commandSupport.js";
import { formatIsoTimestamp, sessionLogFields } from "../sessionFlow.js";

export function registerOperationalHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, codex, logger } = deps;

  bot.command(["start", "help"], async (ctx) => {
    await ctx.reply(formatHelpText(ctx, projects));
  });

  bot.command("status", async (ctx) => {
    if (isPrivateChat(ctx)) {
      await ctx.reply(formatPrivateStatus(store, projects));
      return;
    }

    const project = getProjectForContext(ctx, projects);
    if (!project) {
      await ctx.reply("This supergroup has no project bound yet.\nRun /project bind <absolute-path> first.");
      return;
    }

    if (!hasTopicContext(ctx)) {
      await ctx.reply(formatProjectStatus(project));
      return;
    }

    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const latestSession = await refreshSessionIfActiveTurnIsStale(session, store, codex, bot, logger);
    const queueDepth = store.getQueuedInputCount(latestSession.sessionKey);
    const queuedPreview = store.listQueuedInputs(latestSession.sessionKey, 3);
    const activeRun = codex.getActiveRun(latestSession.sessionKey);

    await ctx.reply(
      [
        "Status",
        `project: ${project.name}`,
        `root: ${project.cwd}`,
        `thread: ${latestSession.codexThreadId ?? "not created"}`,
        `state: ${formatSessionRuntimeStatus(latestSession.runtimeStatus)}`,
        `state detail: ${latestSession.runtimeStatusDetail ?? "none"}`,
        `state updated: ${formatIsoTimestamp(latestSession.runtimeStatusUpdatedAt)}`,
        `active turn: ${latestSession.activeTurnId ?? "none"}`,
        `active run: ${activeRun ? formatIsoTimestamp(activeRun.startedAt) : "none"}`,
        `active run thread: ${activeRun?.threadId ?? "none"}`,
        `active run last event: ${activeRun?.lastEventType ?? "none"}`,
        `active run last update: ${activeRun ? formatIsoTimestamp(activeRun.lastEventAt) : "none"}`,
        `queue: ${queueDepth}`,
        `queue next: ${formatQueuedPreview(queuedPreview)}`,
        `cwd: ${latestSession.cwd}`,
        `preset: ${presetFromProfile(latestSession)}`,
        `sandbox: ${latestSession.sandboxMode}`,
        `approval: ${latestSession.approvalPolicy}`,
        `network: ${latestSession.networkAccessEnabled ? "on" : "off"}`,
        `web: ${latestSession.webSearchMode ?? "codex-default"}`,
        `git check: ${latestSession.skipGitRepoCheck ? "skip" : "enforce"}`,
        `add dirs: ${latestSession.additionalDirectories.length}`,
        `schema: ${latestSession.outputSchema ? "set" : "none"}`,
        `model: ${latestSession.model}`,
        `effort: ${formatReasoningEffort(latestSession.reasoningEffort)}`,
      ].join("\n"),
    );
  });

  bot.command("queue", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const { command, args } = parseSubcommand(ctx.match.trim());
    if (!command) {
      const queued = store.listQueuedInputs(session.sessionKey, 5);
      const queueDepth = store.getQueuedInputCount(session.sessionKey);
      await ctx.reply(
        [
          "Queue",
          `state: ${formatSessionRuntimeStatus(session.runtimeStatus)}`,
          `active turn: ${session.activeTurnId ?? "none"}`,
          `queue: ${queueDepth}`,
          queued.length > 0 ? `items:\n${formatQueuedItems(queued)}` : "items: none",
          "Usage: /queue | /queue drop <id> | /queue clear",
        ].join("\n"),
      );
      return;
    }

    if (command === "clear") {
      const removed = store.clearQueuedInputs(session.sessionKey);
      await ctx.reply(`Cleared the queue and removed ${removed} pending message(s).`);
      return;
    }

    if (command === "drop") {
      const id = Number(args);
      if (!Number.isInteger(id) || id <= 0) {
        await ctx.reply("Usage: /queue drop <id>");
        return;
      }
      const removed = store.removeQueuedInputForSession(session.sessionKey, id);
      await ctx.reply(removed ? `Removed queued item #${id}.` : `Queued item #${id} was not found.`);
      return;
    }

    await ctx.reply("Usage: /queue | /queue drop <id> | /queue clear");
  });

  bot.command("stop", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const latest = store.get(session.sessionKey) ?? session;
    if (!codex.isRunning(session.sessionKey)) {
      await ctx.reply("There is no active Codex SDK turn right now.");
      return;
    }

    try {
      codex.interrupt(session.sessionKey);
      await ctx.reply("Interrupt requested for the current run. Waiting for Codex SDK to stop.");
    } catch (error) {
      logger?.warn("interrupt turn failed", {
        ...contextLogFields(ctx),
        ...sessionLogFields(latest),
        error,
      });
      await ctx.reply(`Interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
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
