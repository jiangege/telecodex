import { homedir } from "node:os";
import path from "node:path";

export function getAppHome(): string {
  return path.join(homedir(), ".telecodex");
}

export function getStateDbPath(): string {
  return path.join(getAppHome(), "state.sqlite");
}

export function getLogsDir(): string {
  return path.join(getAppHome(), "logs");
}

export function getLogFilePath(): string {
  return path.join(getLogsDir(), "telecodex.log");
}
