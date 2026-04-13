import { startTelecodex } from "./runtime/startTelecodex.js";

startTelecodex().catch((error) => {
  console.error(error);
  process.exit(1);
});
