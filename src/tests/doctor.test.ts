import assert from "node:assert/strict";
import test from "node:test";
import { buildDoctorReport } from "../runtime/doctor.js";

function createDoctorDependencies(input?: {
  configuredCodexBin?: string | null;
  workingCodexCommand?: string | null;
  loginLoggedIn?: boolean;
  loginMessage?: string;
  token?: string | null;
  storageMode?: "keyring" | "plaintext-fallback" | null;
  availableToRuntime?: boolean;
  validation?:
    | { ok: true; username: string | null }
    | { ok: false; error: string };
}) {
  const configuredCodexBin = input?.configuredCodexBin ?? null;
  const workingCodexCommand = input && "workingCodexCommand" in input
    ? input.workingCodexCommand ?? null
    : "codex";
  const token = input && "token" in input ? input.token ?? null : "token-123";
  const storageMode = input && "storageMode" in input ? input.storageMode ?? null : "keyring";
  return {
    cwd: "/tmp/project",
    appState: {
      get(key: string) {
        return key === "codex_bin" ? configuredCodexBin : null;
      },
    },
    secrets: {
      inspectTelegramBotToken() {
        return {
          token,
          storageMode,
          availableToRuntime: input?.availableToRuntime ?? true,
          fallbackEnabled: false,
        };
      },
    },
    stateDir: "/tmp/.telecodex/state",
    logFilePath: "/tmp/.telecodex/logs/telecodex.log",
    probeCodexBinary(candidate: string) {
      if (workingCodexCommand && candidate === workingCodexCommand) {
        return {
          command: candidate,
          working: true,
          version: "codex 1.2.3",
          message: "codex 1.2.3",
        };
      }
      return {
        command: candidate,
        working: false,
        version: null,
        message: "not found",
      };
    },
    readCodexLoginStatus() {
      return {
        loggedIn: input?.loginLoggedIn ?? true,
        message: input?.loginMessage ?? "Logged in as test@example.com",
      };
    },
    async validateTelegramBotToken() {
      return input?.validation ?? { ok: true, username: "telecodex_bot" };
    },
  };
}

test("buildDoctorReport returns exit code 0 when all required checks pass", async () => {
  const report = await buildDoctorReport(createDoctorDependencies());

  assert.equal(report.exitCode, 0);
  assert.equal(report.checks.find((check) => check.label === "Codex binary")?.status, "PASS");
  assert.equal(report.checks.find((check) => check.label === "Codex login")?.status, "PASS");
  assert.equal(report.checks.find((check) => check.label === "Telegram bot token")?.status, "PASS");
});

test("buildDoctorReport fails when no working Codex binary is available", async () => {
  const report = await buildDoctorReport(createDoctorDependencies({
    workingCodexCommand: null,
  }));

  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.label === "Codex binary")?.status, "FAIL");
  assert.equal(report.checks.find((check) => check.label === "Codex login")?.status, "WARN");
});

test("buildDoctorReport fails when Codex login is missing", async () => {
  const report = await buildDoctorReport(createDoctorDependencies({
    loginLoggedIn: false,
    loginMessage: "Not logged in",
  }));

  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.label === "Codex login")?.status, "FAIL");
});

test("buildDoctorReport warns when the Telegram bot token is missing", async () => {
  const report = await buildDoctorReport(createDoctorDependencies({
    token: null,
    storageMode: null,
  }));

  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.label === "Telegram bot token")?.status, "WARN");
});

test("buildDoctorReport fails when the Telegram bot token is invalid", async () => {
  const report = await buildDoctorReport(createDoctorDependencies({
    validation: { ok: false, error: "Telegram returned an error: unauthorized" },
  }));

  assert.equal(report.exitCode, 1);
  assert.equal(report.checks.find((check) => check.label === "Telegram bot token")?.status, "FAIL");
});
