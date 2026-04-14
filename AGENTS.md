# AGENTS

## Service Control

- Do not start, restart, stop, or kill local services or dev servers without the user's explicit permission in the current conversation.
- The user manually controls service lifecycle. Assume service control is user-owned unless they clearly ask you to do it.
- This includes commands such as `npm run dev`, `npm start`, Docker compose up/down, background workers, local APIs, and any equivalent long-running process.
- If a service is already running, do not restart it just because code changed. Ask first.
- If a port is occupied or a stale process exists, report it and wait for permission before taking action.
