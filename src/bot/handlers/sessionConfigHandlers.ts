import {
  APPROVAL_POLICIES,
  MODE_PRESETS,
  REASONING_EFFORTS,
  SANDBOX_MODES,
  isSessionApprovalPolicy,
  isSessionModePreset,
  isSessionReasoningEffort,
  isSessionSandboxMode,
  presetFromProfile,
  profileFromPreset,
} from "../../config.js";
import type { BotHandlerDeps } from "../handlerDeps.js";
import {
  assertProjectScopedPath,
  formatProfileReply,
  formatReasoningEffort,
  getProjectForContext,
  getScopedSession,
} from "../commandSupport.js";

export function registerSessionConfigHandlers(deps: BotHandlerDeps): void {
  const { bot, config, store, projects } = deps;

  bot.command("cwd", async (ctx) => {
    const project = getProjectForContext(ctx, projects);
    const session = getScopedSession(ctx, store, projects, config);
    if (!project || !session) return;

    const cwd = ctx.match.trim();
    if (!cwd) {
      await ctx.reply(`当前目录: ${session.cwd}\n项目根目录: ${project.cwd}`);
      return;
    }

    try {
      const allowed = assertProjectScopedPath(cwd, project.cwd);
      store.setCwd(session.sessionKey, allowed);
      await ctx.reply(`已设置 cwd:\n${allowed}`);
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
          `当前预设: ${presetFromProfile(session)}`,
          `sandbox: ${session.sandboxMode}`,
          `approval: ${session.approvalPolicy}`,
          `用法: /mode ${MODE_PRESETS.join("|")}`,
        ].join("\n"),
      );
      return;
    }
    if (!isSessionModePreset(preset)) {
      await ctx.reply(`无效预设。\n用法: /mode ${MODE_PRESETS.join("|")}`);
      return;
    }

    const profile = profileFromPreset(preset);
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await ctx.reply(formatProfileReply("已切换预设。", profile.sandboxMode, profile.approvalPolicy));
  });

  bot.command("sandbox", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const sandboxMode = ctx.match.trim();
    if (!sandboxMode) {
      await ctx.reply(`当前 sandbox: ${session.sandboxMode}\n用法: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }
    if (!isSessionSandboxMode(sandboxMode)) {
      await ctx.reply(`无效 sandbox。\n用法: /sandbox ${SANDBOX_MODES.join("|")}`);
      return;
    }

    store.setSandboxMode(session.sessionKey, sandboxMode);
    await ctx.reply(formatProfileReply("已更新 sandbox。", sandboxMode, session.approvalPolicy));
  });

  bot.command("approval", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const approvalPolicy = ctx.match.trim();
    if (!approvalPolicy) {
      await ctx.reply(`当前 approval: ${session.approvalPolicy}\n用法: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }
    if (!isSessionApprovalPolicy(approvalPolicy)) {
      await ctx.reply(`无效 approval policy。\n用法: /approval ${APPROVAL_POLICIES.join("|")}`);
      return;
    }

    store.setApprovalPolicy(session.sessionKey, approvalPolicy);
    await ctx.reply(formatProfileReply("已更新 approval policy。", session.sandboxMode, approvalPolicy));
  });

  bot.command("yolo", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      const enabled = session.sandboxMode === "danger-full-access" && session.approvalPolicy === "never";
      await ctx.reply(`当前 yolo: ${enabled ? "on" : "off"}\n用法: /yolo on 或 /yolo off`);
      return;
    }
    if (value !== "on" && value !== "off") {
      await ctx.reply("用法: /yolo on 或 /yolo off");
      return;
    }

    const profile = profileFromPreset(value === "on" ? "yolo" : "write");
    store.setSandboxMode(session.sessionKey, profile.sandboxMode);
    store.setApprovalPolicy(session.sessionKey, profile.approvalPolicy);
    await ctx.reply(
      formatProfileReply(
        value === "on" ? "已开启 yolo。" : "已关闭 yolo，恢复到 write 预设。",
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
      await ctx.reply(`当前模型: ${session.model}`);
      return;
    }

    store.setModel(session.sessionKey, model);
    await ctx.reply(`已设置模型: ${model}`);
  });

  bot.command("effort", async (ctx) => {
    const session = getScopedSession(ctx, store, projects, config);
    if (!session) return;

    const value = ctx.match.trim().toLowerCase();
    if (!value) {
      await ctx.reply(`当前思考程度: ${formatReasoningEffort(session.reasoningEffort)}\n用法: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }
    if (value !== "default" && !isSessionReasoningEffort(value)) {
      await ctx.reply(`无效思考程度。\n用法: /effort default|${REASONING_EFFORTS.join("|")}`);
      return;
    }

    if (value === "default") {
      store.setReasoningEffort(session.sessionKey, null);
    } else {
      store.setReasoningEffort(session.sessionKey, value);
    }
    await ctx.reply(`已设置思考程度: ${value === "default" ? "codex-default" : value}`);
  });
}
