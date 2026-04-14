import { run } from "@grammyjs/runner";
import { createBot } from "../bot/createBot.js";
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

    const { config, store, projects, bootstrapCode, botUsername } = await bootstrapRuntime();
    const codex = new CodexSdkRuntime({
      codexBin: config.codexBin,
      logger: logger.child("codex-sdk"),
    });
    const bot = createBot({
      config,
      store,
      projects,
      codex,
      bootstrapCode,
      logger: logger.child("bot"),
      onAdminBound: (userId) => {
        logger.info("telegram admin bound", { userId });
        console.log(`telegram admin bound: ${userId}`);
        console.log("telecodex is now ready to accept commands from this Telegram account");
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

    const stopRuntime = (signal: NodeJS.Signals): void => {
      logger.info("received shutdown signal", { signal });
      codex.interruptAll();
      runner.stop();
      instanceLock?.release();
      instanceLock = null;
      logger.flush();
      process.exit(0);
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
      console.log("bootstrap code was shown during setup and copied to the clipboard when possible");
    } else {
      console.log(`authorized telegram user id: ${store.getAuthorizedUserId()}`);
    }

    logger.info("telecodex started", {
      botUsername,
      workspace: config.defaultCwd,
      codexBin: config.codexBin,
      bootstrapPending: bootstrapCode != null,
      authorizedUserId: store.getAuthorizedUserId(),
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
