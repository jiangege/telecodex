import type { AppStateStore } from "../store/appStateStore.js";
import { getLogFilePath, getStateDir } from "./appPaths.js";
import { initializeRuntimePersistence } from "./bootstrap.js";
import { PLAINTEXT_TOKEN_FALLBACK_ENV, type SecretStore } from "./secrets.js";
import {
  findWorkingCodexBinary,
  listCodexBinCandidates,
  probeCodexBinary,
  readCodexLoginStatus,
  validateTelegramBotToken,
  type CodexBinaryProbe,
  type TelegramTokenValidation,
} from "./runtimeChecks.js";

export type DoctorCheckStatus = "PASS" | "WARN" | "FAIL";

export interface DoctorCheck {
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  nextStep?: string;
  required: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  exitCode: number;
}

export interface DoctorDependencies {
  cwd: string;
  appState: Pick<AppStateStore, "get">;
  secrets: Pick<SecretStore, "inspectTelegramBotToken">;
  stateDir: string;
  logFilePath: string;
  probeCodexBinary: (candidate: string) => CodexBinaryProbe;
  readCodexLoginStatus: (codexBin: string) => { loggedIn: boolean; message: string };
  validateTelegramBotToken: (token: string) => Promise<TelegramTokenValidation>;
}

export async function buildDoctorReport(input: DoctorDependencies): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const configuredCodexBin = input.appState.get("codex_bin");
  const codexCandidates = listCodexBinCandidates(configuredCodexBin);
  const codexProbes = codexCandidates.map(input.probeCodexBinary);
  const workingCodex = codexProbes.find((probe) => probe.working) ?? null;

  if (workingCodex) {
    checks.push({
      label: "Codex binary",
      status: "PASS",
      detail: `${workingCodex.command}${workingCodex.version ? ` (${workingCodex.version})` : ""}`,
      required: true,
    });

    const loginStatus = input.readCodexLoginStatus(workingCodex.command);
    checks.push({
      label: "Codex login",
      status: loginStatus.loggedIn ? "PASS" : "FAIL",
      detail: loginStatus.message || "No login status output was returned.",
      ...(loginStatus.loggedIn
        ? {}
        : { nextStep: "Run `codex login` and re-run `telecodex doctor`." }),
      required: true,
    });
  } else {
    checks.push({
      label: "Codex binary",
      status: "FAIL",
      detail: codexProbes.length > 0
        ? codexProbes.map((probe) => `${probe.command}: ${probe.message}`).join("; ")
        : "No Codex binary candidates were available.",
      nextStep: "Install Codex or configure a working binary path, then re-run `telecodex doctor`.",
      required: true,
    });
    checks.push({
      label: "Codex login",
      status: "WARN",
      detail: "Skipped because no working Codex binary was found.",
      required: false,
    });
  }

  const tokenInspection = input.secrets.inspectTelegramBotToken();
  if (!tokenInspection.token) {
    checks.push({
      label: "Telegram bot token",
      status: "WARN",
      detail: "No saved bot token was found in keychain or local fallback storage.",
      nextStep: "Run `telecodex` once to complete the interactive Telegram bot setup.",
      required: true,
    });
  } else {
    const validation = await input.validateTelegramBotToken(tokenInspection.token);
    const storageLabel = tokenInspection.storageMode === "plaintext-fallback"
      ? "plaintext fallback"
      : tokenInspection.storageMode === "keyring"
        ? "keyring"
        : "unknown storage";

    if (!validation.ok) {
      checks.push({
        label: "Telegram bot token",
        status: "FAIL",
        detail: `${validation.error} (stored in ${storageLabel})`,
        nextStep: "Update the saved Telegram bot token, then re-run `telecodex doctor`.",
        required: true,
      });
    } else if (!tokenInspection.availableToRuntime) {
      checks.push({
        label: "Telegram bot token",
        status: "WARN",
        detail: `Valid for @${validation.username ?? "unknown"}, but stored in plaintext fallback while ${PLAINTEXT_TOKEN_FALLBACK_ENV} is disabled.`,
        nextStep: `Set ${PLAINTEXT_TOKEN_FALLBACK_ENV}=1 or save the token to the system keychain before starting telecodex.`,
        required: true,
      });
    } else {
      checks.push({
        label: "Telegram bot token",
        status: "PASS",
        detail: `Valid for @${validation.username ?? "unknown"} (stored in ${storageLabel}).`,
        required: true,
      });
    }
  }

  checks.push({
    label: "Default workspace",
    status: "PASS",
    detail: input.cwd,
    required: false,
  });
  checks.push({
    label: "State directory",
    status: "PASS",
    detail: input.stateDir,
    required: false,
  });
  checks.push({
    label: "Log file",
    status: "PASS",
    detail: input.logFilePath,
    required: false,
  });

  return {
    checks,
    exitCode: checks.some((check) => check.required && check.status !== "PASS") ? 1 : 0,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["telecodex doctor", ""];
  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}: ${check.detail}`);
    if (check.nextStep) {
      lines.push(`  Next: ${check.nextStep}`);
    }
  }
  lines.push("");
  lines.push(report.exitCode === 0 ? "All required checks passed." : "Some required checks need attention.");
  return lines.join("\n");
}

export async function runDoctor(writeLine: (line: string) => void = console.log): Promise<number> {
  const { appState, secrets } = initializeRuntimePersistence({
    allowPlaintextFallback: process.env[PLAINTEXT_TOKEN_FALLBACK_ENV] === "1",
    createStateDir: false,
    migrateLegacyState: false,
  });
  const report = await buildDoctorReport({
    cwd: process.cwd(),
    appState,
    secrets,
    stateDir: getStateDir(),
    logFilePath: getLogFilePath(),
    probeCodexBinary,
    readCodexLoginStatus,
    validateTelegramBotToken,
  });
  writeLine(formatDoctorReport(report));
  return report.exitCode;
}
