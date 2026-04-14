import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./logger.js";
import { getAppHome } from "./appPaths.js";

export interface InstanceLock {
  path: string;
  release: () => void;
}

export function acquireInstanceLock(input?: { lockPath?: string; logger?: Logger }): InstanceLock {
  const logger = input?.logger;
  const lockPath = input?.lockPath ?? path.join(getAppHome(), "telecodex.lock");
  mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const existing = readExistingLock(lockPath);
      if (existing?.pid != null && isProcessAlive(existing.pid)) {
        throw new Error(`telecodex is already running (pid ${existing.pid})`);
      }

      logger?.warn("removing stale telecodex instance lock", {
        lockPath,
        existingPid: existing?.pid ?? null,
      });

      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (!isNodeError(unlinkError) || unlinkError.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        logger?.warn("failed to release telecodex instance lock", {
          lockPath,
          error,
        });
      }
    }
  };

  process.once("exit", release);
  return {
    path: lockPath,
    release,
  };
}

function readExistingLock(lockPath: string): { pid: number | null; createdAt: string | null } | null {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
    const createdAt = typeof parsed.createdAt === "string" ? parsed.createdAt : null;
    return { pid, createdAt };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
