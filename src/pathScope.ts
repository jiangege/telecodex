import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export function resolveExistingDirectory(input: string): string {
  const resolved = path.resolve(input.trim());
  if (!resolved) {
    throw new Error("Project path cannot be empty.");
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`Directory does not exist: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  return canonicalizeBoundaryPath(resolved);
}

export function resolveExistingFile(input: string): string {
  const resolved = path.resolve(input.trim());
  if (!resolved) {
    throw new Error("File path cannot be empty.");
  }

  let entry;
  try {
    entry = lstatSync(resolved);
  } catch {
    throw new Error(`File does not exist: ${resolved}`);
  }

  if (entry.isSymbolicLink()) {
    throw new Error(`Path cannot be a symbolic link: ${resolved}`);
  }

  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`File does not exist: ${resolved}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }

  return canonicalizeBoundaryPath(resolved);
}

export function assertWorkspaceScopedPath(input: string, workingRoot: string): string {
  const resolved = resolveExistingDirectory(input);
  const canonicalRoot = resolveExistingDirectory(workingRoot);
  if (!isPathWithinRoot(resolved, canonicalRoot)) {
    throw new Error(["Path must stay within the working root.", `working root: ${workingRoot}`, `input: ${resolved}`].join("\n"));
  }
  return resolved;
}

export function assertWorkspaceScopedFile(input: string, workingRoot: string): string {
  const resolved = resolveExistingFile(input);
  const canonicalRoot = resolveExistingDirectory(workingRoot);
  if (!isPathWithinRoot(resolved, canonicalRoot)) {
    throw new Error(["File must stay within the working root.", `working root: ${workingRoot}`, `input: ${resolved}`].join("\n"));
  }
  return resolved;
}

export function isPathWithinRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = canonicalizeBoundaryPath(candidate);
  const resolvedRoot = canonicalizeBoundaryPath(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

export function canonicalizeBoundaryPath(input: string): string {
  const resolved = path.resolve(input);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export const assertProjectScopedPath = assertWorkspaceScopedPath;
export const assertProjectScopedFile = assertWorkspaceScopedFile;
