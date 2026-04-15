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
import type { CodexOptions } from "@openai/codex-sdk";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  assertProjectScopedPath,
  formatProfileReply,
  formatReasoningEffort,
  getProjectForContext,
  getScopedSession,
  resolveExistingDirectory,
} from "../commandSupport.js";

export function registerSessionConfigHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects, codex } = deps;

  bot.command("cwd", async (ctx) => {
    const project = getProjectForContext(ctx, projects);
    const session = getScopedSession(ctx, store, projects, config);
    if (!project || !session) return;

    const cwd = ctx.match.trim();
    if (!cwd) {
      await ctx.reply(`Current directory: ${session.cwd}\nProject root: ${project.cwd}`);
      return;
    }

    try {
      const allowed = assertProjectScopedPath(cwd, project.cwd);
      store.setCwd(session.sessionKey, allowed);
      await ctx.reply(`Set cwd:\n${allowed}`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
    }
  });

  bot.command("mode", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const preset = ctx.match.trim();
    if (!preset) {
      await ctx.reply(
        [
          `Current preset: ${presetFromProfile(session)}`,
          `sandbox: ${session.sandboxMode}`,
          `approval: ${session.approvalPolicy}`,
          `Usage: /mode ${MODE_PRESETS.join("|")}`,
        ].join("\n"),
      );
      return;
    }
    if (!isSessionModePreset(preset)) {
      await ctx.reply(`Invalid preset.\nUsage: /mode ${MODE_PRESETS.join("|")}`);
      return;
    }

    const profile = profileFromPreset(preset);
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await ctx.reply(formatProfileReply("Preset updated.", profile.sandboxMode, profile.approvalPolicy));
  });

  bot.command("sandbox", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const sandboxMode = ctx.match.trim();
    if (!sandboxMode) {
      await ctx.reply(`Current sandbox: ${session.sandboxMode}\nUsage: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }
    if (!isSessionSandboxMode(sandboxMode)) {
      await ctx.reply(`Invalid sandbox.\nUsage: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }

    store.setSandboxMode(session.sessionKey, sandboxMode);
    await ctx.reply(formatProfileReply("Sandbox updated.", sandboxMode, session.approvalPolicy));
  });

  bot.command("approval", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const approvalPolicy = ctx.match.trim();
    if (!approvalPolicy) {
      await ctx.reply(`Current approval: ${session.approvalPolicy}\nUsage: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }
    if (!isSessionApprovalPolicy(approvalPolicy)) {
      await ctx.reply(`Invalid approval policy.\nUsage: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }

    store.setApprovalPolicy(session.sessionKey, approvalPolicy);
    await ctx.reply(formatProfileReply("Approval policy updated.", session.sandboxMode, approvalPolicy));
  });

  bot.command("yolo", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      const enabled = session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
      await ctx.reply(`Current yolo: ${enabled ? "on" : "off"}\nUsage: /yolo on|off`);
      return;
    }
    if (value !== "on" && value !== "off") {
      await ctx.reply("Usage: /yolo on|off");
      return;
    }

    const profile = profileFromPreset(value === "on" ? "yolo" : "write");
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await ctx.reply(
      formatProfileReply(
        value === "on" ? "YOLO enabled." : "YOLO disabled. Restored the write preset.",
        profile.sandboxMode,
        profile.approvalPolicy,
      ),
    );
  });

  bot.command("model", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const model = ctx.match.trim();
    if (!model) {
      await ctx.reply(`Current model: ${session.model}`);
      return;
    }

    store.setModel(session.sessionKey, model);
    await ctx.reply(`Set model: ${model}`);
  });

  bot.command("effort", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`Current reasoning effort: ${formatReasoningEffort(session.reasoningEffort)}\nUsage: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }
    if (value !== "default" && !isSessionReasoningEffort(value)) {
      await ctx.reply(`Invalid reasoning effort.\nUsage: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }

    if (value === "default") {
      store.setReasoningEffort(session.sessionKey, null);
    } else {
      store.setReasoningEffort(session.sessionKey, value);
    }
    await ctx.reply(`Set reasoning effort: ${value === "default" ? "codex-default" : value}`);
  });

  bot.command("web", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`Current web search: ${session.webSearchMode ?? "codex-default"}\nUsage: /web default|${WEB_SEARCH_MODES.join("|")}`);
      return;
    }
    if (value !== "default" && !isSessionWebSearchMode(value)) {
      await ctx.reply(`Invalid web search mode.\nUsage: /web default|${WEB_SEARCH_MODES.join("|")}`);
      return;
    }

    store.setWebSearchMode(session.sessionKey, value === "default" ? null : value);
    await ctx.reply(`Set web search: ${value === "default" ? "codex-default" : value}`);
  });

  bot.command("network", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`Current network access: ${session.networkAccessEnabled ? "on" : "off"}\nUsage: /network on|off`);
      return;
    }
    if (value !== "on" && value !== "off") {
      await ctx.reply("Usage: /network on|off");
      return;
    }

    store.setNetworkAccessEnabled(session.sessionKey, value === "on");
    await ctx.reply(`Set network access: ${value}`);
  });

  bot.command("gitcheck", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`Current git repo check: ${session.skipGitRepoCheck ? "skip" : "enforce"}\nUsage: /gitcheck skip|enforce`);
      return;
    }
    if (value !== "skip" && value !== "enforce") {
      await ctx.reply("Usage: /gitcheck skip|enforce");
      return;
    }

    store.setSkipGitRepoCheck(session.sessionKey, value === "skip");
    await ctx.reply(`Set git repo check: ${value}`);
  });

  bot.command("adddir", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const [command, ...rest] = ctx.match.trim().split(/\s+/).filter(Boolean);
    const args = rest.join(" ");
    if (!command || command === "list") {
      await ctx.reply(
        session.additionalDirectories.length === 0
          ? "additional directories: none\nUsage: /adddir add <absolute-path> | /adddir drop <index> | /adddir clear"
          : [
              "additional directories:",
              ...session.additionalDirectories.map((directory, index) => `${index + 1}. ${directory}`),
              "Usage: /adddir add <absolute-path> | /adddir drop <index> | /adddir clear",
            ].join("\n"),
      );
      return;
    }

    if (command === "add") {
      if (!args) {
        await ctx.reply("Usage: /adddir add <absolute-path>");
        return;
      }
      try {
        const directory = resolveExistingDirectory(args);
        const next = [...session.additionalDirectories.filter((entry) => entry !== directory), directory];
        store.setAdditionalDirectories(session.sessionKey, next);
        await ctx.reply(`Added additional directory:\n${directory}`);
      } catch (error) {
        await ctx.reply(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (command === "drop") {
      const index = Number(args);
      if (!Number.isInteger(index) || index <= 0 || index > session.additionalDirectories.length) {
        await ctx.reply("Usage: /adddir drop <index>");
        return;
      }
      const next = session.additionalDirectories.filter((_entry, entryIndex) => entryIndex !== index - 1);
      store.setAdditionalDirectories(session.sessionKey, next);
      await ctx.reply(`Removed additional directory #${index}.`);
      return;
    }

    if (command === "clear") {
      store.setAdditionalDirectories(session.sessionKey, []);
      await ctx.reply("Cleared additional directories.");
      return;
    }

    await ctx.reply("Usage: /adddir list | /adddir add <absolute-path> | /adddir drop <index> | /adddir clear");
  });

  bot.command("schema", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const raw = ctx.match.trim();
    if (!raw || raw === "show") {
      await ctx.reply(session.outputSchema ? `Current output schema:\n${session.outputSchema}` : "Current output schema: none\nUsage: /schema set <JSON object> | /schema clear");
      return;
    }
    if (raw === "clear") {
      store.setOutputSchema(session.sessionKey, null);
      await ctx.reply("Cleared output schema.");
      return;
    }
    if (!raw.startsWith("set ")) {
      await ctx.reply("Usage: /schema show | /schema set <JSON object> | /schema clear");
      return;
    }

    try {
      const parsed = JSON.parse(raw.slice(4).trim()) as unknown;
      if (!isPlainObject(parsed)) {
        await ctx.reply("Output schema must be a JSON object.");
        return;
      }
      const normalized = JSON.stringify(parsed);
      store.setOutputSchema(session.sessionKey, normalized);
      await ctx.reply(`Set output schema:\n${normalized}`);
    } catch (error) {
      await ctx.reply(`Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("codexconfig", async (ctx) => {
    const raw = ctx.match.trim();
    if (!raw || raw === "show") {
      const current = store.getAppState("codex_config_overrides");
      await ctx.reply(current ? `Current Codex config overrides:\n${current}` : "Current Codex config overrides: none\nUsage: /codexconfig set <JSON object> | /codexconfig clear");
      return;
    }
    if (raw === "clear") {
      store.deleteAppState("codex_config_overrides");
      codex.setConfigOverrides(undefined);
      await ctx.reply("Cleared Codex config overrides. They will apply to future runs.");
      return;
    }
    if (!raw.startsWith("set ")) {
      await ctx.reply("Usage: /codexconfig show | /codexconfig set <JSON object> | /codexconfig clear");
      return;
    }

    try {
      const configOverrides = parseCodexConfigOverrides(raw.slice(4).trim());
      const serialized = JSON.stringify(configOverrides);
      store.setAppState("codex_config_overrides", serialized);
      codex.setConfigOverrides(configOverrides);
      await ctx.reply(`Set Codex config overrides. They will apply to future runs.\n${serialized}`);
    } catch (error) {
      await ctx.reply(error instanceof Error ? error.message : String(error));
    }
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCodexConfigOverrides(raw: string): NonNullable<CodexOptions["config"]> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Codex config overrides must be a JSON object.");
  }
  assertCodexConfigValue(parsed, "config");
  return parsed as NonNullable<CodexOptions["config"]>;
}

function assertCodexConfigValue(value: unknown, path: string): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertCodexConfigValue(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!key) throw new Error("Codex config override key cannot be empty.");
      assertCodexConfigValue(child, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} may only contain string, number, boolean, array, or object values.`);
}
