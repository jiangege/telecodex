#!/usr/bin/env node

import { note } from "@clack/prompts";
import { startTelecodex } from "./runtime/startTelecodex.js";

function printHelp(): void {
  note("Run `telecodex` with no environment variables. The first launch will guide setup.", "telecodex");
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  printHelp();
  process.exit(0);
}

startTelecodex().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
