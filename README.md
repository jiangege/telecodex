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
- Text and image messages are mapped to Codex SDK input.
- A run immediately creates a normal Telegram status message; progress edits that message.
- telecodex does not use pinned messages for live state.
- While a run is pending, the bot sends Telegram `typing` activity so the chat does not look dead during long SDK gaps.
- `/status` is the source of truth for runtime state, active thread id, last SDK event, and queue depth.

## Requirements

- Node.js 24 or newer.
- A local `codex` CLI installation available on `PATH`.
- A valid local Codex login:

```bash
codex login status
```

- A Telegram bot token.

## Install from npm

```bash
npm install -g telecodex
telecodex
```

`telecodex` uses the local `codex` CLI at runtime, so installing this package
does not replace the separate Codex CLI installation.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Start it:

```bash
npm run dev
```

For a production-style local install during development, `npm link` exposes the
same `telecodex` command globally from the current checkout.

## Automated npm release

This repository is set up for npm trusted publishing from GitHub Actions.

1. On npm, open the `telecodex` package settings and configure a trusted publisher:
   - Organization or user: `jiangege`
   - Repository: `telecodex`
   - Workflow filename: `publish.yml`
2. Bump the version locally:

```bash
npm version patch
```

3. Push the branch and tag:

```bash
git push origin main --follow-tags
```

Pushing a `v*` tag runs `.github/workflows/publish.yml`, which installs dependencies,
runs `npm run check`, runs `npm test`, and publishes the package to npm when the tag
matches the version in `package.json`.

## First launch

On first launch, `telecodex`:

1. Finds or asks for the local `codex` binary path.
2. Verifies Codex login.
3. Asks for a Telegram bot token if none is stored yet.
4. Generates a one-time bootstrap code if no Telegram admin is bound yet.
5. Waits for that code in a private chat. The first successful sender becomes the permanent admin for this bot instance.

Bootstrap codes are time-limited and attempt-limited. When a code expires or is exhausted, start telecodex again locally to issue a fresh one.

There are no required environment variables in the normal startup path.

Optional security override:

- `TELECODEX_ALLOW_PLAINTEXT_TOKEN_FALLBACK=1` allows storing the Telegram bot token unencrypted in local state when the system keychain is unavailable. This is disabled by default.

## Working model

- Private chat is only for bootstrap and lightweight management.
- One forum supergroup represents one project.
- The project root is bound once with `/project bind <absolute-path>`.
- Each topic in that supergroup is one Codex thread.
- Work happens by sending normal messages inside the topic.
- `/thread new <topic-name>` automatically creates a new topic; the first normal message inside it starts a fresh Codex thread.
- `/thread resume <threadId>` automatically creates a new topic and binds it to an existing thread id.

## Stored state

- Telegram bot token: stored in the system keychain when available. Plaintext local fallback is disabled by default and must be opted into explicitly.
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
- `/admin` - in private chat, show admin binding and handoff status.
- `/admin rebind` - in private chat, issue a time-limited handoff code for transferring control to another Telegram account.
- `/admin cancel` - in private chat, cancel a pending admin handoff code.
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
- `/web default|disabled|cached|live` - set Codex SDK web search mode.
- `/network on|off` - set workspace network access for Codex SDK runs.
- `/gitcheck skip|enforce` - control Codex SDK git repository checks.
- `/adddir list|add <path-inside-project>|add-external <absolute-path>|drop <index>|clear` - manage Codex SDK additional directories. `add` stays inside the project root; `add-external` is the explicit escape hatch.
- `/schema show|set <JSON object>|clear` - manage Codex SDK output schema for the current topic.
- `/codexconfig show|set <JSON object>|clear` - manage global non-auth Codex SDK config overrides for future runs.
- Image messages in a topic - download the Telegram image locally and send it as SDK `local_image` input.

## Notes

- Long polling is managed by `@grammyjs/runner`.
- Streaming updates are throttled before editing Telegram messages.
- Final answers are rendered from Markdown to Telegram-safe HTML.
- Project-scoped path checks resolve symlinks before enforcing the root boundary, so topic cwd changes cannot escape the bound project through symlink paths.
- Because the SDK run is in-process, a telecodex restart cannot resume a partially streamed Telegram turn; the topic is reset and the user is asked to resend.
- Authentication and provider switching remain owned by the local Codex installation; telecodex does not manage API keys or login state.
- Interactive terminal stdin bridging and native Codex approval UI are intentionally not part of the Telegram contract. For unattended remote work, use the topic's sandbox/approval preset deliberately.
