/**
 * Stable content fingerprint: sha1 of normalized content.
 * Deterministic across machines and immune to mtime-only touches.
 */
import { createHash } from "node:crypto";

export function fingerprint(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

export function fingerprintJson(value: unknown): string {
  return fingerprint(JSON.stringify(value));
}
