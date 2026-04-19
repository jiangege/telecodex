import type { BotHandlerDeps } from "./handlerDeps.js";
import { registerMessageHandlers } from "./handlers/messageHandlers.js";
import { registerOperationalHandlers } from "./handlers/operationalHandlers.js";
import { registerWorkspaceHandlers } from "./handlers/projectHandlers.js";
import { registerSessionConfigHandlers } from "./handlers/sessionConfigHandlers.js";
import { registerThreadHandlers } from "./handlers/threadHandlers.js";

export function registerHandlers(deps: BotHandlerDeps): void {
  registerOperationalHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerThreadHandlers(deps);
  registerSessionConfigHandlers(deps);
  registerMessageHandlers(deps);
}
