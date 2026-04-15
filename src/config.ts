import path from "node:path";

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SessionSandboxMode = (typeof SANDBOX_MODES)[number];

export const APPROVAL_POLICIES = ["on-request", "on-failure", "never"] as const;
export type SessionApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const MODE_PRESETS = ["read", "write", "danger", "yolo"] as const;
export type SessionModePreset = (typeof MODE_PRESETS)[number];

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type SessionReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const WEB_SEARCH_MODES = ["disabled", "cached", "live"] as const;
export type SessionWebSearchMode = (typeof WEB_SEARCH_MODES)[number];

export interface SessionRuntimeProfile {
  sandboxMode: SessionSandboxMode;
  approvalPolicy: SessionApprovalPolicy;
}

export interface AppConfig {
  telegramBotToken: string;
  defaultCwd: string;
  defaultModel: string;
  codexBin: string;
  updateIntervalMs: number;
}

export const DEFAULT_SESSION_PROFILE: SessionRuntimeProfile = {
  sandboxMode: "read-only",
  approvalPolicy: "on-request",
};

export function buildConfig(input: {
  telegramBotToken: string;
  defaultCwd?: string;
  defaultModel?: string;
  codexBin: string;
  updateIntervalMs?: number;
}): AppConfig {
  const defaultCwd = path.resolve(input.defaultCwd ?? process.cwd());
  return {
    telegramBotToken: input.telegramBotToken,
    defaultCwd,
    defaultModel: input.defaultModel?.trim() || "gpt-5.4",
    codexBin: input.codexBin,
    updateIntervalMs: input.updateIntervalMs ?? 700,
  };
}

export function isSessionSandboxMode(value: string): value is SessionSandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(value);
}

export function isSessionApprovalPolicy(value: string): value is SessionApprovalPolicy {
  return (APPROVAL_POLICIES as readonly string[]).includes(value);
}

export function isSessionModePreset(value: string): value is SessionModePreset {
  return (MODE_PRESETS as readonly string[]).includes(value);
}

export function isSessionReasoningEffort(value: string): value is SessionReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

export function isSessionWebSearchMode(value: string): value is SessionWebSearchMode {
  return (WEB_SEARCH_MODES as readonly string[]).includes(value);
}

export function profileFromPreset(preset: SessionModePreset): SessionRuntimeProfile {
  switch (preset) {
    case "read":
      return {
        sandboxMode: "read-only",
        approvalPolicy: "on-request",
      };
    case "write":
      return {
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
      };
    case "danger":
      return {
        sandboxMode: "danger-full-access",
        approvalPolicy: "on-request",
      };
    case "yolo":
      return {
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      };
  }
}

export function presetFromProfile(profile: SessionRuntimeProfile): SessionModePreset | "custom" {
  for (const preset of MODE_PRESETS) {
    const candidate = profileFromPreset(preset);
    if (candidate.sandboxMode === profile.sandboxMode && candidate.approvalPolicy === profile.approvalPolicy) {
      return preset;
    }
  }
  return "custom";
}
