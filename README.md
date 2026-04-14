# telecodex

Telegram bridge for local Codex built on the official TypeScript SDK.

## Model

```text
Telegram private chat
  -> one-time admin bootstrap

Telegram forum supergroup
  -> one project per supergroup
  -> one topic per Codex thread

Telegram
  -> grammY bot + runner
  -> CodexSdkRuntime
  -> @openai/codex-sdk
  -> local Codex login
```

The bot talks to local Codex through `@openai/codex-sdk`, which wraps the local
`codex` CLI. It does not depend on `codex app-server`.

## Runtime contract

- Telegram is treated as a remote task interface, not a clone of Codex Desktop.
- One topic maps to one Codex SDK thread.
- Each topic has at most one active SDK run.
- Follow-up messages during an active run are queued and processed in order.
- A run immediately creates a normal Telegram status message; progress edits that message.
- telecodex does not use pinned messages for live state.
- While a run is pending, the bot sends Telegram `typing` activity so the chat does not look dead during long SDK gaps.
- `/status` is the source of truth for runtime state, active thread id, last SDK event, and queue depth.

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

## First launch

On first launch, `telecodex`:

1. Finds or asks for the local `codex` binary path.
2. Verifies Codex login.
3. Asks for a Telegram bot token if none is stored yet.
4. Generates a one-time bootstrap code if no Telegram admin is bound yet.
5. Waits for that code in a private chat. The first successful sender becomes the permanent admin for this bot instance.

There are no required environment variables in the normal startup path.

## Working model

- Private chat is only for bootstrap and lightweight management.
- One forum supergroup represents one project.
- The project root is bound once with `/project bind <absolute-path>`.
- Each topic in that supergroup is one Codex thread.
- Work happens by sending normal messages inside the topic.
- `/thread new <topic-name>` automatically creates a new topic; the first normal message inside it starts a fresh Codex thread.
- `/thread resume <threadId>` automatically creates a new topic and binds it to an existing thread id.

## Stored state

- Telegram bot token: stored in the system keychain when available, otherwise falls back to local state.
- Admin binding, project bindings, and topic/session state: stored in a local SQLite database under `~/.telecodex/`.
- Runtime logs: written by `pino` to `~/.telecodex/logs/telecodex.log`.
- Working directory: defaults to the directory where you ran `telecodex`.

## Logs

- Startup prints the active log file path.
- Telegram middleware errors and message edit failures are appended to the log file.
- When you need to debug a running instance later, inspect `~/.telecodex/logs/telecodex.log` first.

## Commands

- `/start` or `/help` - show the current usage model.
- `/status` - in private chat shows global state; in a project topic shows project/thread runtime state.
- `/project` - show the current supergroup's project binding.
- `/project bind <absolute-path>` - bind the current supergroup to a project root.
- `/project unbind` - remove the current supergroup's project binding.
- `/thread` - in a topic, show the current attached thread id.
- `/thread new <topic-name>` - create a new topic for a fresh Codex thread.
- `/thread resume <threadId>` - create a new topic and bind it to an existing Codex thread id.
- Normal text in a topic - send that message to the current Codex thread.
- `/stop` - interrupt the active SDK run.
- `/cwd <absolute-path>` - switch the topic working directory inside the current project root.
- `/mode read|write|danger|yolo` - switch runtime presets for the current topic.
- `/sandbox <read-only|workspace-write|danger-full-access>` - set sandbox explicitly for the current topic.
- `/approval <on-request|on-failure|never>` - set approval policy explicitly for the current topic.
- `/yolo on|off` - quick toggle for `danger-full-access + never` on the current topic.
- `/model <model-id>` - set model for the current topic.
- `/effort default|minimal|low|medium|high|xhigh` - set model reasoning effort for the current topic.

## Notes

- Long polling is managed by `@grammyjs/runner`.
- Streaming updates are throttled before editing Telegram messages.
- Final answers are rendered from Markdown to Telegram-safe HTML.
- Because the SDK run is in-process, a telecodex restart cannot resume a partially streamed Telegram turn; the topic is reset and the user is asked to resend.
- Interactive terminal stdin bridging and native Codex approval UI are intentionally not part of the Telegram contract. For unattended remote work, use the topic's sandbox/approval preset deliberately.
