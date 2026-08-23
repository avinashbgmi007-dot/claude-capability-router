/**
 * Incremental capability index with persistence.
 * ADD / MODIFY / DELETE / UNCHANGED, driven by content fingerprints.
 * State lives under <cmrHome>/state (index.json + manifest.json), written atomically.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import type { CapabilityIndexEntry, DiscoveredCapability, IndexUpdateResult, RouterConfig } from "./types.js";
import { stateDir } from "./paths.js";

export interface CapabilityIndex {
  entries: Map<string, CapabilityIndexEntry>;
  lastUpdated: string;
  /** Discovery-roots scan fingerprint at index time — short-circuits rediscovery. */
  scan: string;
}

function indexFile(dir: string): string {
  return path.join(dir, "index.json");
}

function manifestFile(dir: string): string {
  return path.join(dir, "manifest.json");
}

export function loadIndex(dir?: string): CapabilityIndex {
  const d = dir || stateDir();
  const entries = new Map<string, CapabilityIndexEntry>();
  let lastUpdated = "";
  let scan = "";
  const f = indexFile(d);
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as { entries: CapabilityIndexEntry[]; lastUpdated: string; scan?: string };
      for (const e of parsed.entries) entries.set(e.id, e);
      lastUpdated = parsed.lastUpdated || "";
      scan = parsed.scan || "";
    } catch {
      /* corrupt index → rebuild from scratch */
    }
  }
  return { entries, lastUpdated, scan };
}

function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, file);
}

function saveIndex(dir: string, idx: CapabilityIndex): void {
  mkdirSync(dir, { recursive: true });
  writeAtomic(indexFile(dir), JSON.stringify({ entries: [...idx.entries.values()], lastUpdated: idx.lastUpdated, scan: idx.scan }, null, 2));
  writeAtomic(manifestFile(dir), JSON.stringify({ version: 1, entryCount: idx.entries.size, lastUpdated: idx.lastUpdated, scan: idx.scan }, null, 2));
}

/**
 * Incremental update: compares fingerprints of discovered capabilities
 * against the current index and returns the change set.
 */
export function updateIndex(
  discovered: DiscoveredCapability[],
  prev: CapabilityIndex,
  config: RouterConfig,
  dir?: string,
  scan = "",
): { result: IndexUpdateResult; index: CapabilityIndex } {
  const next = new Map<string, CapabilityIndexEntry>();
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];

  for (const d of discovered) {
    const prevEntry = prev.entries.get(d.id);
    const enabled = !config.exclude.includes(d.id) && (config.capabilities[d.id]?.enabled ?? true);
    const weight = config.capabilities[d.id]?.weight ?? 1;
    const entry: CapabilityIndexEntry = { ...d, enabled, weight };
    next.set(d.id, entry);
    if (!prevEntry) added.push(d.id);
    else if (prevEntry.fingerprint !== d.fingerprint) modified.push(d.id);
    else unchanged.push(d.id);
  }
  const deleted = [...prev.entries.keys()].filter((id) => !next.has(id));

  const index: CapabilityIndex = {
    entries: next,
    lastUpdated: new Date().toISOString(),
    scan,
  };
  // persist only when a dir is given — callers without one get an in-memory index
  // (keeps tests hermetic: no writes to the real user home)
  if (dir) saveIndex(dir, index);

  return { result: { added, modified, deleted, unchanged }, index };
}

/** Build a fresh index from discovery (no persistence unless dir provided). */
export function buildIndex(discovered: DiscoveredCapability[], config: RouterConfig): CapabilityIndex {
  return updateIndex(discovered, { entries: new Map(), lastUpdated: "", scan: "" }, config).index;
}
