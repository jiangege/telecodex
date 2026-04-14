import type { Bot } from "grammy";
import { recoverPendingTurnDeliveries } from "../../bot/createBot.js";
import type { CodexGateway } from "../../codex/CodexGateway.js";
import type { Logger } from "../../runtime/logger.js";
import type { SessionStore } from "../../store/sessions.js";
import type { MaintenanceTask } from "../MaintenanceRunner.js";

export function createRecoverPendingTurnDeliveriesTask(input: {
  bot: Bot;
  store: SessionStore;
  gateway: CodexGateway;
  logger?: Logger;
}): MaintenanceTask {
  const { bot, store, gateway, logger } = input;
  return {
    name: "recover-pending-turn-deliveries",
    intervalMs: 60_000,
    runOnStart: true,
    async run(): Promise<void> {
      await recoverPendingTurnDeliveries(store, gateway, bot, logger);
    },
  };
}
