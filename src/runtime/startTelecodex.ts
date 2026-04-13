import { randomBytes } from "node:crypto";
import { loadConfig } from "../config.js";
import { createBot } from "../bot/createBot.js";
import { CodexAppServerClient } from "../codex/CodexAppServerClient.js";
import { CodexGateway } from "../codex/CodexGateway.js";
import { openDatabase } from "../store/db.js";
import { SessionStore } from "../store/sessions.js";

export async function startTelecodex(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const sessions = new SessionStore(db);
  const bootstrapCode = sessions.getAuthorizedUserId() == null ? generateBootstrapCode() : null;
  const codexClient = new CodexAppServerClient({
    codexBin: config.codexBin,
    cwd: config.defaultCwd,
  });
  const gateway = new CodexGateway(codexClient);
  const bot = createBot({ config, store: sessions, gateway, bootstrapCode });

  process.once("SIGINT", () => {
    bot.stop();
    codexClient.stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    bot.stop();
    codexClient.stop();
    process.exit(0);
  });

  await codexClient.start();
  await bot.start({
    onStart: (info) => {
      console.log(`telecodex started as @${info.username}`);
      console.log(`cwd: ${config.defaultCwd}`);
      console.log(`codex: ${config.codexBin}`);
      if (bootstrapCode) {
        console.log("telegram admin is not bound yet");
        console.log(`bootstrap code: ${bootstrapCode}`);
        console.log("send this code to the bot in a private chat to claim the first admin account");
      } else {
        console.log(`authorized telegram user id: ${sessions.getAuthorizedUserId()}`);
      }
    },
  });
}

function generateBootstrapCode(): string {
  return `bind-${randomBytes(9).toString("base64url")}`;
}
