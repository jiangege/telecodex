# AGENTS

## Documentation Boundary

- `README.md` is end-user documentation. Keep it focused on installation, setup, commands, and troubleshooting.
- Architecture notes, release process, implementation constraints, and AI-facing guidance belong in `AGENTS.md`, not `README.md`.
- Do not turn `README.md` into a maintainer notebook or design document.

## Service Control

- Do not start, restart, stop, or kill local services or dev servers without the user's explicit permission in the current conversation.
- The user manually controls service lifecycle. Assume service control is user-owned unless they clearly ask you to do it.
- This includes commands such as `npm run dev`, `npm start`, Docker compose up/down, background workers, local APIs, and any equivalent long-running process.
- If a service is already running, do not restart it just because code changed. Ask first.
- If a port is occupied or a stale process exists, report it and wait for permission before taking action.

## Release Automation

- Do not assume that pushing commits to GitHub automatically publishes to npm.
- This repository publishes to npm from GitHub Actions only when a matching `v*` git tag is pushed.
- Before claiming that a release will publish automatically, verify the workflow trigger in `.github/workflows/publish.yml`.
- If a release is needed, treat `package.json` version, git tag, GitHub push, and npm visibility as separate checkpoints and verify each one.

## Product Model

- `telecodex` is a Telegram bridge for local Codex built on `@openai/codex-sdk`.
- It uses the local `codex` CLI through the SDK. It does not depend on `codex app-server`.
- One Telegram forum supergroup maps to one project.
- One topic inside that supergroup maps to one Codex thread.
- Each topic has at most one active run.
- Follow-up messages during an active run are ignored and should receive a fixed busy notice.
- `/stop` is the only user-facing interruption path during an active run.
- Telegram typing should stay active for the duration of a run, subject to Telegram rate limits.

## State Model

- Codex thread history comes from Codex session files and is not duplicated into telecodex state.
- Durable telecodex state lives in local JSON files under `~/.telecodex/state/`.
- Runtime state and active output message ids are in-memory only.
- Legacy SQLite exists only as a one-time migration source and should not be reintroduced as the normal runtime store.

## Implementation Guidance

- Prefer a simple Telegram contract over trying to replicate every Codex Desktop behavior.
- Keep the UI message-driven. Do not reintroduce pin-based live state.
- Preserve the boundary between durable state and runtime state.
- Treat inbound Telegram images as supported Codex input, but do not assume there is a native SDK-level inline image output channel.
