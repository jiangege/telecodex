import assert from "node:assert/strict";
import test from "node:test";
import { runTelecodexCli } from "../cli.js";

test("runTelecodexCli dispatches the doctor subcommand", async () => {
  let started = false;
  let doctorRuns = 0;
  const lines: string[] = [];

  const exitCode = await runTelecodexCli(["doctor"], {
    startTelecodex: async () => {
      started = true;
    },
    runDoctor: async () => {
      doctorRuns += 1;
      return 7;
    },
    writeLine: (line) => {
      lines.push(line);
    },
  });

  assert.equal(exitCode, 7);
  assert.equal(started, false);
  assert.equal(doctorRuns, 1);
  assert.deepEqual(lines, []);
});

test("runTelecodexCli prints help for unknown commands", async () => {
  const lines: string[] = [];
  const exitCode = await runTelecodexCli(["unknown"], {
    startTelecodex: async () => undefined,
    runDoctor: async () => 0,
    writeLine: (line) => {
      lines.push(line);
    },
  });

  assert.equal(exitCode, 1);
  assert.match(lines.join("\n"), /telecodex doctor/);
});

test("runTelecodexCli starts the runtime when no subcommand is given", async () => {
  let started = 0;
  const exitCode = await runTelecodexCli([], {
    startTelecodex: async () => {
      started += 1;
    },
    runDoctor: async () => 0,
    writeLine: () => undefined,
  });

  assert.equal(exitCode, 0);
  assert.equal(started, 1);
});
