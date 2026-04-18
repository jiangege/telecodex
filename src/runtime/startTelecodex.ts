import { run } from "@grammyjs/runner";
import { createBot } from "../bot/wireBot.js";
import { tryParseCodexConfigOverrides } from "../codex/configOverrides.js";
import { CodexSessionCatalog } from "../codex/sessionCatalog.js";
import { CodexSdkRuntime } from "../codex/sdkRuntime.js";
import { bootstrapRuntime } from "./bootstrap.js";
import { acquireInstanceLock, type InstanceLock } from "./instanceLock.js";
import { createLogger, type Logger } from "./logger.js";

let processHandlersInstalled = false;

export async function startTelecodex(): Promise<void> {
  const logger = createLogger();
  let instanceLock: InstanceLock | null = null;
  installProcessErrorHandlers(logger);
  logger.info("telecodex startup requested", {
    pid: process.pid,
    cwd: process.cwd(),
    logFile: logger.filePath,
  });

  try {
    instanceLock = acquireInstanceLock({
      logger: logger.child("instance-lock"),
    });
    logger.info("telecodex instance lock acquired", {
      lockPath: instanceLock.path,
      pid: process.pid,
    });

    const { config, sessions, projects, admin, appState, bootstrapCode, botUsername } = await bootstrapRuntime();
    const storedConfigOverrides = appState.get("codex_config_overrides");
    const { value: configOverrides, error: configOverridesError } = tryParseCodexConfigOverrides(storedConfigOverrides);
    if (configOverridesError) {
      appState.delete("codex_config_overrides");
      logger.warn("cleared invalid stored codex config overrides", {
        error: configOverridesError.message,
      });
    }

    const codex = new CodexSdkRuntime({
      codexBin: config.codexBin,
      logger: logger.child("codex-sdk"),
      ...(configOverrides ? { configOverrides } : {}),
    });
    const threadCatalog = new CodexSessionCatalog({
      logger: logger.child("codex-sessions"),
    });
    const bot = createBot({
      config,
      sessions,
      projects,
      admin,
      appState,
      codex,
      threadCatalog,
      logger: logger.child("bot"),
      onAdminBound: () => {
        logger.info("telegram admin bound");
        console.log("telegram admin binding completed");
        console.log("telecodex is now ready to accept commands from the bound Telegram account");
      },
    });

    const botProfile = await bot.api.getMe();
    if (!botProfile.can_read_all_group_messages) {
      logger.warn("telegram bot privacy mode is enabled; plain topic messages will not reach telecodex", {
        botUsername: botProfile.username ?? botUsername,
      });
      console.warn("warning: this bot cannot read all group messages yet");
      console.warn("disable privacy mode in @BotFather with /setprivacy, then choose this bot and Disable");
      console.warn("Telegram may take a few minutes to apply the change");
    }

    const runner = run(bot);

    let shuttingDown = false;
    const stopRuntime = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        logger.info("received shutdown signal", { signal });
        codex.interruptAll();
        runner.stop();
        try {
          await sessions.flush();
        } catch (error) {
          logger.warn("failed to flush pending telecodex state during shutdown", { error });
        }
        instanceLock?.release();
        instanceLock = null;
        logger.flush();
        process.exit(0);
      })();
    };

    process.once("SIGINT", () => stopRuntime("SIGINT"));
    process.once("SIGTERM", () => stopRuntime("SIGTERM"));

    console.log(`telecodex started as @${botUsername ?? "unknown"}`);
    console.log(`workspace: ${config.defaultCwd}`);
    console.log(`codex: ${config.codexBin}`);
    console.log(`logs: ${logger.filePath}`);
    if (bootstrapCode) {
      console.log("telegram admin is not bound yet");
      console.log("waiting for admin binding from Telegram private chat...");
      console.log("a binding link, terminal QR code, and fallback one-time code were shown during setup when available");
    } else {
      console.log(`authorized telegram user id: ${admin.getAuthorizedUserId()}`);
    }

    logger.info("telecodex started", {
      botUsername,
      workspace: config.defaultCwd,
      codexBin: config.codexBin,
      bootstrapPending: bootstrapCode != null,
      authorizedUserId: admin.getAuthorizedUserId(),
    });
  } catch (error) {
    instanceLock?.release();
    logger.error("telecodex startup failed", error);
    throw error;
  }
}

function installProcessErrorHandlers(logger: Logger): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", reason);
    logger.flush();
  });

  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", error);
    logger.flush();
    process.exit(1);
  });
}
