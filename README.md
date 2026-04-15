# telecodex

Use Telegram forum topics as a remote interface for local Codex.

`telecodex` connects a Telegram bot to your local `codex` CLI through the
official TypeScript SDK. It is meant for remote task execution, not as a full
clone of Codex Desktop.

## Requirements

- Node.js 24 or newer
- A local `codex` CLI installation available on `PATH`
- A valid local Codex login
- A Telegram bot token

Check Codex login first:

```bash
codex login status
```

## Install

```bash
npm install -g telecodex
telecodex
```

Installing `telecodex` does not replace the separate `codex` CLI. The bot uses
your local Codex installation at runtime.

## First Launch

On first launch, `telecodex`:

1. Finds or asks for the local `codex` binary path.
2. Verifies local Codex login.
3. Prompts for a Telegram bot token if none is stored yet.
4. Generates a one-time bootstrap code if no Telegram admin is bound yet.
5. Waits for that code in a private Telegram chat with the bot.

The first successful sender becomes the admin for that bot instance.

Optional security override:

- `TELECODEX_ALLOW_PLAINTEXT_TOKEN_FALLBACK=1` allows storing the Telegram bot
  token unencrypted in local state when the system keychain is unavailable.
  This is disabled by default.

## How It Works

- One Telegram forum supergroup represents one project.
- One topic inside that supergroup represents one Codex thread.
- Work happens by sending normal messages inside the topic.
- While a run is active, follow-up messages are queued automatically.
- `/status` shows the current runtime state.

Private chat is only for bootstrap and lightweight admin actions.

## Quick Start

Inside a Telegram forum supergroup:

1. Bind the group to a project root:

```text
/project bind /absolute/path/to/project
```

2. Create a fresh topic for a new Codex thread:

```text
/thread new My Task
```

3. Or resume an existing thread:

```text
/thread list
/thread resume <threadId>
```

4. Send normal messages in the topic to work with Codex.

## Commands

### General

- `/start` or `/help` - show usage help
- `/status` - show current state
- `/stop` - interrupt the active run in the current topic

### Admin

- `/admin` - show admin binding and handoff state
- `/admin rebind` - issue a temporary handoff code
- `/admin cancel` - cancel a pending handoff

### Project

- `/project` - show the current project binding
- `/project bind <absolute-path>` - bind the current supergroup to a project root
- `/project unbind` - remove the project binding

### Threads

- `/thread` - show the current attached thread id in a topic
- `/thread list` - list saved Codex threads for the current project
- `/thread new <topic-name>` - create a fresh topic for a new thread
- `/thread resume <threadId>` - create a topic and bind it to an existing thread

### Session Configuration

- `/cwd <absolute-path>`
- `/mode read|write|danger|yolo`
- `/sandbox <read-only|workspace-write|danger-full-access>`
- `/approval <on-request|on-failure|never>`
- `/yolo on|off`
- `/model <model-id>`
- `/effort default|minimal|low|medium|high|xhigh`
- `/web default|disabled|cached|live`
- `/network on|off`
- `/gitcheck skip|enforce`
- `/adddir list|add <path-inside-project>|add-external <absolute-path>|drop <index>|clear`
- `/schema show|set <JSON object>|clear`
- `/codexconfig show|set <JSON object>|clear`

## Images

- Sending an image in a topic is supported.
- Telegram photos and image documents are downloaded locally and sent to Codex as
  `local_image` input.
- Image output is not rendered inline in Telegram text messages.

## Storage

- Telegram bot token: stored in the system keychain when available
- Durable local state: `~/.telecodex/state/`
- Runtime logs: `~/.telecodex/logs/telecodex.log`
- Codex thread history: read from Codex session files under `$CODEX_HOME/sessions`
  (or `~/.codex/sessions` by default)

If an older `~/.telecodex/state.sqlite` exists, telecodex imports it once into
the JSON state files and then removes the old SQLite files.

## Troubleshooting

- If startup reports a login problem, run `codex login`.
- If the bot appears idle for a long time, check `/status`.
- If you need logs, inspect `~/.telecodex/logs/telecodex.log`.

