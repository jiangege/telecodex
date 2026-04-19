# telecodex

Run local Codex from Telegram topics.

`telecodex` connects a Telegram bot to your local `codex` CLI through the
official TypeScript SDK. It keeps execution on your machine: one forum
supergroup per workspace, one topic per Codex thread, one active run per topic.

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
4. In a Telegram forum supergroup, set the working root:

```text
/workspace /absolute/path/to/project
```

5. Create or open a topic and send normal messages to start or continue work.

To reuse an existing Codex thread in the current topic:

```text
/thread list
/thread resume <threadId>
```

To continue a Telegram-created SDK thread from a shell on the same machine:

```bash
cd /absolute/path/to/project
codex resume --include-non-interactive <threadId>
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

- One Telegram forum supergroup represents one workspace.
- That supergroup has one shared working root.
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
- `/status` - show workspace or topic runtime state
- `/stop` - interrupt the active run in the current topic if the Stop button is unavailable

### Admin

- `/admin` - show admin binding and handoff state
- `/admin rebind` - issue a temporary handoff code
- `/admin cancel` - cancel a pending handoff

### Workspace

- `/workspace` - show the current working root
- `/workspace <absolute-path>` - set or replace the current supergroup working root

### Threads

- `/thread` - show the current attached thread id in a topic
- `/thread list` - list saved Codex threads for the current workspace
- `/thread new` - reset the current topic so the next message starts a fresh thread
- `/thread resume <threadId>` - bind the current topic to an existing thread

`/thread` and `/thread list` also show a ready-to-run local `codex resume --include-non-interactive ...`
command for continuing SDK-created threads from a terminal on the same machine.

### Session Configuration

- `/mode read|write|danger|yolo`
- `/model <model-id>`
- `/effort default|minimal|low|medium|high|xhigh`
- `/web default|disabled|cached|live`
- `/network on|off`
- `/gitcheck skip|enforce`
- `/adddir list|add <path-inside-working-root>|add-external <absolute-path>|drop <index>|clear`
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
- Codex Desktop may not list SDK-created non-interactive threads yet even when
  the thread exists locally. Use the `pc resume` command shown by `/thread` or
  `/thread list` to continue from a terminal with `codex resume`.
- If you need logs, inspect `~/.telecodex/logs/telecodex.log`.
