import { Entry } from "@napi-rs/keyring";
import type { SessionStore } from "../store/sessions.js";

const SERVICE = "telecodex";
const ACCOUNT = "telegram-bot-token";
const FALLBACK_KEY = "telegram_bot_token";

export type TokenStorageMode = "keyring" | "plaintext-fallback" | "existing";

export class SecretStore {
  private readonly entry = new Entry(SERVICE, ACCOUNT);

  constructor(private readonly store: SessionStore) {}

  getTelegramBotToken(): string | null {
    try {
      const token = this.entry.getPassword();
      if (token) return token;
    } catch {
      // Fallback below.
    }
    return this.store.getAppState(FALLBACK_KEY);
  }

  setTelegramBotToken(token: string): TokenStorageMode {
    try {
      this.entry.setPassword(token);
      this.store.deleteAppState(FALLBACK_KEY);
      return "keyring";
    } catch {
      this.store.setAppState(FALLBACK_KEY, token);
      return "plaintext-fallback";
    }
  }
}
