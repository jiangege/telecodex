import type { Bot } from "grammy";
import { refreshLiveSessionHeartbeats } from "../../bot/createBot.js";
import type { Logger } from "../../runtime/logger.js";
import type { SessionStore } from "../../store/sessions.js";
import type { MaintenanceTask } from "../MaintenanceRunner.js";

export function createRefreshLiveSessionHeartbeatsTask(input: {
  bot: Bot;
  store: SessionStore;
  logger?: Logger;
}): MaintenanceTask {
  const { bot, store, logger } = input;
  return {
    name: "refresh-live-session-heartbeats",
    intervalMs: 60_000,
    runOnStart: false,
    async run(): Promise<void> {
      await refreshLiveSessionHeartbeats(store, bot, logger);
    },
  };
}
