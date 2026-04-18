#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { runDoctor } from "./runtime/doctor.js";
import { startTelecodex } from "./runtime/startTelecodex.js";

export interface CliDependencies {
  startTelecodex: () => Promise<void>;
  runDoctor: () => Promise<number>;
  writeLine: (line: string) => void;
}

function printHelp(writeLine: (line: string) => void): void {
  writeLine(
    [
      "telecodex",
      "",
      "Commands:",
      "  telecodex         Start interactive setup and the Telegram bridge runtime",
      "  telecodex doctor  Check local prerequisites without changing tracked state",
      "",
      "Flags:",
      "  -h, --help        Show this help text",
    ].join("\n"),
  );
}

export async function runTelecodexCli(
  argv: string[],
  input: CliDependencies = {
    startTelecodex,
    runDoctor: () => runDoctor(),
    writeLine: console.log,
  },
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp(input.writeLine);
    return 0;
  }

  const [command] = argv;
  if (!command) {
    await input.startTelecodex();
    return 0;
  }

  if (command === "doctor") {
    return await input.runDoctor();
  }

  printHelp(input.writeLine);
  return 1;
}

async function main(): Promise<void> {
  try {
    const exitCode = await runTelecodexCli(process.argv.slice(2));
    process.exit(exitCode);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const isMainModule = process.argv[1] != null
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMainModule) {
  void main();
}
