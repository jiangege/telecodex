import type { BotHandlerDeps } from "./handlerDeps.js";
import { registerMessageHandlers } from "./handlers/messageHandlers.js";
import { registerOperationalHandlers } from "./handlers/operationalHandlers.js";
import { registerProjectHandlers } from "./handlers/projectHandlers.js";
import { registerSessionConfigHandlers } from "./handlers/sessionConfigHandlers.js";

export function registerHandlers(deps: BotHandlerDeps): void {
  registerOperationalHandlers(deps);
  registerProjectHandlers(deps);
  registerSessionConfigHandlers(deps);
  registerMessageHandlers(deps);
}
