# telecodex

Run local Codex from Telegram topics.

`telecodex` connects a Telegram bot to your local `codex` CLI through the
official TypeScript SDK. It keeps execution on your machine: one forum
supergroup per project, one topic per Codex thread, one active run per topic.

## Good Fits

- Kick off or follow up on local repository work from your phone
- Keep multiple Codex threads organized by Telegram topic
- Stop a running turn from Telegram without returning to the terminal

## Requirements

- Node.js 24 or newer
- A local `codex` CLI installation available on `PATH`
- A valid local Codex login
- A Telegram bot token

Check the local Codex login first:

```bash
codex login status
```

## Install

```bash
npm install -g telecodex
telecodex doctor
telecodex
```

Installing `telecodex` does not replace the separate `codex` CLI. The bot uses
your local Codex installation at runtime.

## 30-Second Quick Start

1. Run `telecodex`.
2. Open the deep link shown in the terminal or scan the terminal QR code.
3. If Telegram cannot open the link, send the fallback one-time binding code to
   the bot in a private chat.
4. In a Telegram forum supergroup, bind the project:

```text
/project bind /absolute/path/to/project
```

5. Create or open a topic and send normal messages to start or continue work.

To reuse an existing Codex thread in the current topic:

```text
/thread list
/thread resume <threadId>
```

## First Launch

On first launch, `telecodex`:

1. Finds or asks for the local `codex` binary path.
2. Verifies local Codex login.
3. Prompts for a Telegram bot token if none is stored yet.
4. Prints a deep link, a terminal QR code, and a fallback one-time code if no
   Telegram admin is bound yet.
5. Waits for the first successful admin binding in the bot private chat.

The first successful sender becomes the admin for that bot instance.

Optional security override:

- `TELECODEX_ALLOW_PLAINTEXT_TOKEN_FALLBACK=1` allows storing the Telegram bot
  token unencrypted in local state when the system keychain is unavailable.
  This is disabled by default.

## How It Works

- One Telegram forum supergroup represents one project.
- One topic inside that supergroup represents one Codex thread.
- Work happens by sending normal messages inside the topic.
- While a run is active, follow-up messages are ignored and Telegram typing stays active.
- The primary interrupt path is the `Stop` button on the working message.
- `/status` shows the current runtime state.
- `/stop` remains available as a fallback if the button is unavailable.

Private chat is only for bootstrap and lightweight admin actions.

## Commands

### General

- `/start` or `/help` - show usage help
- `/status` - show current state
- `/stop` - interrupt the active run in the current topic if the Stop button is unavailable

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
- `/thread new` - reset the current topic so the next message starts a fresh thread
- `/thread resume <threadId>` - bind the current topic to an existing thread

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
- Telegram photos and image documents are downloaded locally and sent to Codex
  as `local_image` input.
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

- Run `telecodex doctor` to check the local Codex binary, login state, Telegram
  token, workspace, and local paths without changing tracked state.
- If startup reports a login problem, run `codex login`.
- If the bot appears idle for a long time, check `/status`.
- If you need logs, inspect `~/.telecodex/logs/telecodex.log`.
