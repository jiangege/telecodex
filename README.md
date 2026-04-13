# telecodex

Telegram bridge for local Codex through `codex app-server`.

## Architecture

```text
Telegram
  -> grammY bot
  -> CodexGateway
  -> codex app-server over stdio
  -> local Codex ChatGPT auth
```

The bot uses `codex app-server` as a local child process. It does not require
an OpenAI API key when the local Codex installation is already logged in with
ChatGPT.

## Setup

1. Create a Telegram bot with BotFather and copy the token.
2. Copy `.env.example` to `.env`.
3. Fill `TELEGRAM_BOT_TOKEN`.
4. Make sure local Codex is logged in:

```bash
codex login status
```

5. Install and generate the Codex app-server types:

```bash
npm install
CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex npm run generate:codex-types
```

6. Start the bot:

```bash
npm run dev
```

If no Telegram admin has been bound yet, startup prints a one-time bootstrap
code. Send that code to the bot in a private chat. The first successful sender
becomes the permanent admin for this bot instance.

## Configuration

- `TELEGRAM_BOT_TOKEN`: Bot token from BotFather.
- `TELECODEX_DEFAULT_CWD`: Default workspace directory.
- `TELECODEX_ALLOWED_CWDS`: Comma-separated directory allowlist for `/cwd`.
- `TELECODEX_DEFAULT_MODEL`: Default Codex model.
- `TELECODEX_DB_PATH`: Local SQLite database path.
- `CODEX_BIN`: Optional absolute path to the Codex binary.

## Commands

- `/start` - show basic status.
- `/help` - list commands.
- `/status` - show current session and Codex auth status.
- `/new` - create a new Codex thread for this chat/topic.
- `/stop` - interrupt the active Codex turn.
- `/cwd <absolute-path>` - set workspace directory for this session.
- `/mode read|write` - switch sandbox mode.
- `/model <model-id>` - set model for this session.

The bot is private by default. On a fresh database it generates a bootstrap
code at startup, and the first private-chat user who sends that code is stored
as the only admin in the local SQLite database. That bootstrap step only
happens once.

## Notes

- v1 uses the app-server stdio transport, not WebSocket.
- Streaming updates are throttled before editing Telegram messages.
- Final answers are rendered from Markdown to Telegram-safe HTML.
- Command and file-change approvals are shown as Telegram inline buttons.
