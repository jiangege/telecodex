# telecodex

Telegram bridge for local Codex through `codex app-server`.

## Architecture

```text
Telegram private chat
  -> one-time admin bootstrap

Telegram forum supergroup
  -> one project per supergroup
  -> one Codex thread per topic

Telegram
  -> grammY bot + runner
  -> CodexGateway
  -> codex app-server over stdio
  -> local Codex ChatGPT auth
```

The bot uses `codex app-server` as a local child process. It does not require
an OpenAI API key when the local Codex installation is already logged in with
ChatGPT.

## Setup

1. Make sure local Codex is installed.
2. Make sure local Codex is logged in:

```bash
codex login status
```

3. Install dependencies:

```bash
npm install
```

4. Install the local `telecodex` command:

```bash
npm link
```

5. Start it:

```bash
telecodex
```

For local development, `npm run dev` runs the same entrypoint without linking.

## First Launch

On first launch, `telecodex` runs an interactive setup flow:

1. If it cannot find a working Codex binary, it asks for the path once.
2. If Codex is not logged in, it prompts you to run `codex login`.
3. If no Telegram bot token is stored yet, it asks you to paste one and validates it with Telegram.
4. If no Telegram admin is bound yet, it generates a one-time bootstrap code and copies it to the clipboard when possible.
5. You send that bootstrap code to the bot in a private chat. The first successful sender becomes the permanent admin for this bot instance.
6. The terminal stays running and prints the binding result as soon as Telegram confirms it. No restart is needed.

There are no required environment variables in the normal startup path.

## Working Model

- Private chat is only for bootstrap and lightweight management.
- One forum supergroup represents one project.
- The project root is bound once with `/project bind <absolute-path>`.
- Each topic in that supergroup is one Codex thread.
- `/thread new <topic-name>` automatically creates a new topic; the first normal message inside it starts a fresh Codex thread.
- `/thread resume <threadId>` automatically creates a new topic and binds it to an existing desktop/CLI thread.

## Stored State

- Telegram bot token: stored in the system keychain when available, otherwise falls back to local state.
- Admin binding, project bindings, and topic/session state: stored in a local SQLite database under `~/.telecodex/`.
- Runtime logs: written by `pino` to `~/.telecodex/logs/telecodex.log`.
- Working directory: defaults to the directory where you ran `telecodex`.

## Logs

- Startup prints the active log file path.
- Telegram middleware errors, message edit failures, and handled command failures are appended to the log file.
- `codex app-server` stderr, non-JSON stdout lines, request timeouts, and exit events are appended to the same log file.
- A low-frequency maintenance reconciler runs immediately on startup, then keeps removing bindings for Telegram topics that were manually deleted and posts a summary to the chat's General topic.
- When you need to debug a running instance later, inspect `~/.telecodex/logs/telecodex.log` first.

## Commands

- `/start` or `/help` - show the current usage model.
- `/status` - in private chat shows global state; in a project topic shows project/thread runtime state.
- `/project` - show the current supergroup's project binding.
- `/project bind <absolute-path>` - bind the current supergroup to a project root.
- `/project unbind` - remove the current supergroup's project binding.
- `/thread` - in a topic, show the current attached thread id.
- `/thread list [keyword]` - list recent resumable Codex threads that belong to the current project.
- `/thread new <topic-name>` - create a new topic for a fresh Codex thread.
- `/thread resume <threadId>` - create a new topic and bind it to an existing Codex thread, including threads created in the desktop app.
- `/stop` - interrupt the active Codex turn.
- `/cwd <absolute-path>` - switch the topic working directory inside the current project root.
- `/mode read|write|danger|yolo` - switch runtime presets for the current topic.
- `/sandbox <read-only|workspace-write|danger-full-access>` - set sandbox explicitly for the current topic.
- `/approval <on-request|on-failure|never>` - set approval policy explicitly for the current topic.
- `/yolo on|off` - quick toggle for `danger-full-access + never` on the current topic.
- `/model <model-id>` - set model for the current topic.

The bot is private by default. On a fresh database it generates a bootstrap
code at startup, and the first private-chat user who sends that code is stored
as the only admin in the local SQLite database. That bootstrap step only
happens once. If the process restarts before binding succeeds, the same
bootstrap code is reused until it is claimed.

## Notes

- Long polling is managed by `@grammyjs/runner`.
- v1 uses the app-server stdio transport, not WebSocket.
- Streaming updates are throttled before editing Telegram messages.
- Final answers are rendered from Markdown to Telegram-safe HTML.
- Command and file-change approvals are shown as Telegram inline buttons when the current approval policy requires them.
