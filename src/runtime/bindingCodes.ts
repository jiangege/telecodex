import { randomBytes } from "node:crypto";

export function generateBindingCode(mode: "bootstrap" | "rebind"): string {
  const prefix = mode === "rebind" ? "rebind" : "bind";
  return `${prefix}-${randomBytes(6).toString("base64url")}`;
}
