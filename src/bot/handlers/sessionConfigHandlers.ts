import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  WEB_SEARCH_MODES,
  isSessionApprovalPolicy,
  isSessionModePreset,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  isSessionWebSearchMode,
  presetFromProfile,
  profileFromPreset,
} from "../../config.js";
import { parseCodexConfigOverrides } from "../../codex/configOverrides.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  assertProjectScopedPath,
  formatProfileReply,
  formatReasoningEffort,
  getProjectForContext,
  requireScopedSession,
  resolveExistingDirectory,
} from "../commandSupport.js";
import { codeField, replyDocument, replyError, replyNotice, replyUsage, textField } from "../../telegram/formatted.js";

type SessionConfigDeps = Pick<BotHandlerDeps, "bot" | "config" | "store" | "projects" | "codex">;

export function registerSessionConfigHandlers(deps: BotHandlerDeps): void {
  registerDirectoryHandlers(deps);
  registerProfileHandlers(deps);
  registerExecutionHandlers(deps);
  registerAdvancedHandlers(deps);
}

function registerDirectoryHandlers(deps: SessionConfigDeps): void {
  const { bot, config, store, projects } = deps;

  bot.command("cwd", async (ctx) => {
    const project = getProjectForContext(ctx, projects);
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!project || !session) return;

    const cwd = ctx.match.trim();
    if (!cwd) {
      await replyCurrentSetting(ctx, "Current directory", [
        codeField("cwd", session.cwd),
        codeField("project root", project.cwd),
      ]);
      return;
    }

    try {
      const allowed = assertProjectScopedPath(cwd, project.cwd);
      store.setCwd(session.sessionKey, allowed);
      await replyDocument(ctx, {
        title: "Set cwd",
        fields: [codeField("cwd", allowed)],
      });
    } catch (error) {
      await replyError(ctx, error instanceof Error ? error.message : String(error));
    }
  });
}

function registerProfileHandlers(deps: SessionConfigDeps): void {
  const { bot, config, store, projects } = deps;

  bot.command("mode", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const preset = ctx.match.trim();
    if (!preset) {
      await replyCurrentSetting(
        ctx,
        "Current preset",
        [
          textField("preset", presetFromProfile(session)),
          textField("sandbox", session.sandboxMode),
          textField("approval", session.approvalPolicy),
        ],
        `Usage: /mode ${MODE_PRESETS.join("|")}`,
      );
      return;
    }
    if (!isSessionModePreset(preset)) {
      await replyInvalidValue(ctx, "Invalid preset.", `Usage: /mode ${MODE_PRESETS.join("|")}`);
      return;
    }

    const profile = profileFromPreset(preset);
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await replyNotice(ctx, formatProfileReply("Preset updated.", profile.sandboxMode, profile.approvalPolicy));
  });

  bot.command("sandbox", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const sandboxMode = ctx.match.trim();
    if (!sandboxMode) {
      await replyCurrentSetting(ctx, "Current sandbox", [textField("sandbox", session.sandboxMode)], `Usage: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }
    if (!isSessionSandboxMode(sandboxMode)) {
      await replyInvalidValue(ctx, "Invalid sandbox.", `Usage: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }

    store.setSandboxMode(session.sessionKey, sandboxMode);
    await replyNotice(ctx, formatProfileReply("Sandbox updated.", sandboxMode, session.approvalPolicy));
  });

  bot.command("approval", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const approvalPolicy = ctx.match.trim();
    if (!approvalPolicy) {
      await replyCurrentSetting(ctx, "Current approval", [textField("approval", session.approvalPolicy)], `Usage: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }
    if (!isSessionApprovalPolicy(approvalPolicy)) {
      await replyInvalidValue(ctx, "Invalid approval policy.", `Usage: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }

    store.setApprovalPolicy(session.sessionKey, approvalPolicy);
    await replyNotice(ctx, formatProfileReply("Approval policy updated.", session.sandboxMode, approvalPolicy));
  });

  bot.command("yolo", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      const enabled = session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
      await replyCurrentSetting(ctx, "Current yolo", [textField("yolo", enabled ? "on" : "off")], "Usage: /yolo on|off");
      return;
    }
    if (value !== "on" && value !== "off") {
      await replyUsage(ctx, "/yolo on|off");
      return;
    }

    const profile = profileFromPreset(value === "on" ? "yolo" : "write");
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await replyNotice(
      ctx,
      formatProfileReply(
        value === "on" ? "YOLO enabled." : "YOLO disabled. Restored the write preset.",
        profile.sandboxMode,
        profile.approvalPolicy,
      ),
    );
  });
}

function registerExecutionHandlers(deps: SessionConfigDeps): void {
  const { bot, config, store, projects } = deps;

  bot.command("model", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const model = ctx.match.trim();
    if (!model) {
      await replyCurrentSetting(ctx, "Current model", [textField("model", session.model)]);
      return;
    }

    store.setModel(session.sessionKey, model);
    await replyNotice(ctx, `Set model: ${model}`);
  });

  bot.command("effort", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await replyCurrentSetting(
        ctx,
        "Current reasoning effort",
        [textField("effort", formatReasoningEffort(session.reasoningEffort))],
        `Usage: /effort default|${REASONING_EFFORTS.join("|")}`,
      );
      return;
    }
    if (value !== "default" && !isSessionReasoningEffort(value)) {
      await replyInvalidValue(ctx, "Invalid reasoning effort.", `Usage: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }

    store.setReasoningEffort(session.sessionKey, value === "default" ? null : value);
    await replyNotice(ctx, `Set reasoning effort: ${value === "default" ? "codex-default" : value}`);
  });

  bot.command("web", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await replyCurrentSetting(
        ctx,
        "Current web search",
        [textField("web", session.webSearchMode ?? "codex-default")],
        `Usage: /web default|${WEB_SEARCH_MODES.join("|")}`,
      );
      return;
    }
    if (value !== "default" && !isSessionWebSearchMode(value)) {
      await replyInvalidValue(ctx, "Invalid web search mode.", `Usage: /web default|${WEB_SEARCH_MODES.join("|")}`);
      return;
    }

    store.setWebSearchMode(session.sessionKey, value === "default" ? null : value);
    await replyNotice(ctx, `Set web search: ${value === "default" ? "codex-default" : value}`);
  });

  bot.command("network", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await replyCurrentSetting(
        ctx,
        "Current network access",
        [textField("network", session.networkAccessEnabled ? "on" : "off")],
        "Usage: /network on|off",
      );
      return;
    }
    if (value !== "on" && value !== "off") {
      await replyUsage(ctx, "/network on|off");
      return;
    }

    store.setNetworkAccessEnabled(session.sessionKey, value === "on");
    await replyNotice(ctx, `Set network access: ${value}`);
  });

  bot.command("gitcheck", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await replyCurrentSetting(
        ctx,
        "Current git repo check",
        [textField("git check", session.skipGitRepoCheck ? "skip" : "enforce")],
        "Usage: /gitcheck skip|enforce",
      );
      return;
    }
    if (value !== "skip" && value !== "enforce") {
      await replyUsage(ctx, "/gitcheck skip|enforce");
      return;
    }

    store.setSkipGitRepoCheck(session.sessionKey, value === "skip");
    await replyNotice(ctx, `Set git repo check: ${value}`);
  });
}

function registerAdvancedHandlers(deps: SessionConfigDeps): void {
  const { bot, config, store, projects, codex } = deps;

  bot.command("adddir", async (ctx) => {
    const project = getProjectForContext(ctx, projects);
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!project || !session) return;

    const [command, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const args = rest.join(" ");
    if (!command || command === "list") {
      await replyDocument(ctx, {
        title: "Additional directories",
        ...(session.additionalDirectories.length > 0
          ? {
              sections: [
                {
                  title: "Directories",
                  fields: session.additionalDirectories.map((directory, index) => codeField(String(index + 1), directory)),
                },
              ],
            }
          : {
              fields: [textField("directories", "none")],
            }),
        footer: "Usage: /adddir add <path-inside-project> | /adddir add-external <absolute-path> | /adddir drop <index> | /adddir clear",
      });
      return;
    }

    if (command === "add") {
      if (!args) {
        await replyUsage(ctx, "/adddir add <path-inside-project>");
        return;
      }
      try {
        const directory = assertProjectScopedPath(args, project.cwd);
        const next = [...session.additionalDirectories.filter((entry) => entry !== directory), directory];
        store.setAdditionalDirectories(session.sessionKey, next);
        await replyDocument(ctx, {
          title: "Added additional directory",
          fields: [codeField("directory", directory)],
        });
      } catch (error) {
        await replyError(ctx, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "add-external") {
      if (!args) {
        await replyUsage(ctx, "/adddir add-external <absolute-path>");
        return;
      }
      try {
        const directory = resolveExistingDirectory(args);
        const next = [...session.additionalDirectories.filter((entry) => entry !== directory), directory];
        store.setAdditionalDirectories(session.sessionKey, next);
        await replyDocument(ctx, {
          title: "Added external additional directory outside the project root.",
          fields: [codeField("directory", directory)],
          footer: "Codex can now read files there during future runs.",
        });
      } catch (error) {
        await replyError(ctx, error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "drop") {
      const index = Number(args);
      if (!Number.isInteger(index) || index <= 0 || index > session.additionalDirectories.length) {
        await replyUsage(ctx, "/adddir drop <index>");
        return;
      }
      const next = session.additionalDirectories.filter((_entry, entryIndex) => entryIndex !== index - 1);
      store.setAdditionalDirectories(session.sessionKey, next);
      await replyNotice(ctx, `Removed additional directory #${index}.`);
      return;
    }

    if (command === "clear") {
      store.setAdditionalDirectories(session.sessionKey, []);
      await replyNotice(ctx, "Cleared additional directories.");
      return;
    }

    await replyUsage(ctx, "/adddir list | /adddir add <path-inside-project> | /adddir add-external <absolute-path> | /adddir drop <index> | /adddir clear");
  });

  bot.command("schema", async (ctx) => {
    const session = await requireScopedSession(ctx, store, projects, config);
    if (!session) return;

    const raw = ctx.match.trim();
    if (!raw || raw === "show") {
      await replyDocument(ctx, {
        title: "Current output schema",
        fields: session.outputSchema
          ? [codeField("schema", session.outputSchema)]
          : [textField("schema", "none")],
        footer: "Usage: /schema set <JSON object> | /schema clear",
      });
      return;
    }
    if (raw === "clear") {
      store.setOutputSchema(session.sessionKey, null);
      await replyNotice(ctx, "Cleared output schema.");
      return;
    }
    if (!raw.startsWith("set ")) {
      await replyUsage(ctx, "/schema show | /schema set <JSON object> | /schema clear");
      return;
    }

    try {
      const parsed = JSON.parse(raw.slice(4).trim()) as unknown;
      if (!isPlainObject(parsed)) {
        await replyError(ctx, "Output schema must be a JSON object.");
        return;
      }
      const normalized = JSON.stringify(parsed);
      store.setOutputSchema(session.sessionKey, normalized);
      await replyDocument(ctx, {
        title: "Set output schema",
        fields: [codeField("schema", normalized)],
      });
    } catch (error) {
      await replyError(ctx, `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("codexconfig", async (ctx) => {
    const raw = ctx.match.trim();
    if (!raw || raw === "show") {
      const current = store.getAppState("codex_config_overrides");
      await replyDocument(ctx, {
        title: "Current Codex config overrides",
        fields: current
          ? [codeField("config", current)]
          : [textField("config", "none")],
        footer: "Usage: /codexconfig set <JSON object> | /codexconfig clear",
      });
      return;
    }
    if (raw === "clear") {
      store.deleteAppState("codex_config_overrides");
      codex.setConfigOverrides(undefined);
      await replyNotice(ctx, "Cleared Codex config overrides. They will apply to future runs.");
      return;
    }
    if (!raw.startsWith("set ")) {
      await replyUsage(ctx, "/codexconfig show | /codexconfig set <JSON object> | /codexconfig clear");
      return;
    }

    try {
      const configOverrides = parseCodexConfigOverrides(raw.slice(4).trim());
      const serialized = JSON.stringify(configOverrides);
      store.setAppState("codex_config_overrides", serialized);
      codex.setConfigOverrides(configOverrides);
      await replyDocument(ctx, {
        title: "Set Codex config overrides. They will apply to future runs.",
        fields: [codeField("config", serialized)],
      });
    } catch (error) {
      await replyError(ctx, error instanceof Error ? error.message : String(error));
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function replyCurrentSetting(
  ctx: Parameters<typeof replyDocument>[0],
  title: string,
  fields: Array<ReturnType<typeof textField> | ReturnType<typeof codeField>>,
  footer?: string,
): Promise<void> {
  await replyDocument(ctx, {
    title,
    fields,
    ...(footer ? { footer } : {}),
  });
}

async function replyInvalidValue(ctx: Parameters<typeof replyError>[0], message: string, usage: string): Promise<void> {
  await replyError(ctx, message, usage);
}
