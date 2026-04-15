import { Entry } from "@napi-rs/keyring";
import type { SessionStore } from "../store/sessions.js";

const SERVICE = "telecodex";
const ACCOUNT = "telegram-bot-token";
const FALLBACK_KEY = "telegram_bot_token";
export const PLAINTEXT_TOKEN_FALLBACK_ENV = "TELECODEX_ALLOW_PLAINTEXT_TOKEN_FALLBACK";

export type TokenStorageMode = "keyring" | "plaintext-fallback" | "existing";

export class SecretStore {
  private readonly entry = new Entry(SERVICE, ACCOUNT);

  constructor(
    private readonly store: SessionStore,
    private readonly options?: { allowPlaintextFallback?: boolean },
  ) {}

  getTelegramBotToken(): string | null {
    try {
      const token = this.entry.getPassword();
      if (token) return token;
    } catch {
      // Fallback below.
    }
    if (!this.options?.allowPlaintextFallback) {
      return null;
    }
    return this.store.getAppState(FALLBACK_KEY);
  }

  setTelegramBotToken(token: string): TokenStorageMode {
    try {
      this.entry.setPassword(token);
      this.store.deleteAppState(FALLBACK_KEY);
      return "keyring";
    } catch {
      if (!this.options?.allowPlaintextFallback) {
        throw new Error(
          [
            "System keychain is unavailable, and plaintext Telegram bot token fallback is disabled.",
            `If you accept storing the token unencrypted in local state, set ${PLAINTEXT_TOKEN_FALLBACK_ENV}=1 and run telecodex again.`,
          ].join(" "),
        );
      }
      this.store.setAppState(FALLBACK_KEY, token);
      return "plaintext-fallback";
    }
  }
}
