/**
 * Discovery — finds capabilities from all four locked sources:
 *  skills, agents, Claude Code plugins, MCP servers.
 *
 * Determinism rules:
 *  - sorted directory/file traversal everywhere
 *  - ignore caches: ~/.claude/plugins/cache, node_modules, .git
 *  - stable ids: `${kind}:${name}`
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { CapabilityKind, DiscoveredCapability } from "./types.js";
import { extractFromMarkdown, extractFromMcpServer } from "./metadata-extractor.js";
import { fingerprint } from "./fingerprint.js";
import type { DiscoveryRoots } from "./paths.js";

const IGNORE_DIRS = new Set(["node_modules", ".git", "cache", ".cache"]);

function sortedEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Recursive, sorted walk for files matching a name, skipping ignored dirs. */
function walkFiles(root: string, fileName: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(root, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(e)) walkFiles(full, fileName, acc);
    } else if (e.toLowerCase() === fileName.toLowerCase()) {
      acc.push(full);
    }
  }
  return acc;
}

function readSafe(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function toCapability(meta: { name: string; kind: CapabilityKind; sourcePath: string; rawText: string }, kind: CapabilityKind): DiscoveredCapability {
  const md = extractFromMarkdown({ ...meta, kind });
  return {
    ...md,
    id: `${kind}:${md.name}`,
    fingerprint: fingerprint(meta.sourcePath + "\n" + meta.rawText),
  };
}

/** Discover SKILL.md files under a skills root. */
function discoverSkills(root: string, kind: "skill" | "plugin-skill"): DiscoveredCapability[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredCapability[] = [];
  for (const skillFile of walkFiles(root, "SKILL.md")) {
    const name = path.basename(path.dirname(skillFile));
    out.push(toCapability({ name, kind, sourcePath: skillFile, rawText: readSafe(skillFile) }, kind));
  }
  return out;
}

/** Discover agent .md files under an agents root. */
function discoverAgents(root: string, kind: "agent" | "plugin-agent"): DiscoveredCapability[] {
  if (!existsSync(root)) return [];
  const out: DiscoveredCapability[] = [];
  for (const f of sortedEntries(root)) {
    const full = path.join(root, f);
    if (!isFile(full) || !f.toLowerCase().endsWith(".md")) continue;
    out.push(toCapability({ name: f.replace(/\.md$/, ""), kind, sourcePath: full, rawText: readSafe(full) }, kind));
  }
  return out;
}

/** Discover plugin skills/agents under ~/.claude/plugins/<marketplace>/<plugin>/plugin-root/. */
function discoverPlugins(claudeRoot: string): DiscoveredCapability[] {
  const pluginsRoot = path.join(claudeRoot, "plugins");
  if (!existsSync(pluginsRoot)) return [];
  const out: DiscoveredCapability[] = [];
  for (const marketplace of sortedEntries(pluginsRoot)) {
    if (IGNORE_DIRS.has(marketplace)) continue;
    const mpDir = path.join(pluginsRoot, marketplace);
    for (const pluginId of sortedEntries(mpDir)) {
      if (IGNORE_DIRS.has(pluginId)) continue;
      const pluginRoot = path.join(mpDir, pluginId, "plugin-root");
      if (!existsSync(pluginRoot)) continue;
      out.push(...discoverSkills(path.join(pluginRoot, "skills"), "plugin-skill"));
      out.push(...discoverAgents(path.join(pluginRoot, "agents"), "plugin-agent"));
    }
  }
  return out;
}

interface McpServersFile {
  mcpServers?: Record<string, Record<string, unknown>>;
}

/** Discover MCP servers from workspace .mcp.json and user ~/.claude.json. */
function discoverMcp(roots: DiscoveryRoots): DiscoveredCapability[] {
  const out: DiscoveredCapability[] = [];
  const seen = new Set<string>();

  const sources: Array<[string, string]> = [
    [path.join(roots.workspaceDir, ".mcp.json"), "project"],
    [path.join(roots.homeDir, ".claude.json"), "user"],
  ];

  for (const [file, origin] of sources) {
    if (!existsSync(file)) continue;
    let parsed: McpServersFile;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8")) as McpServersFile;
    } catch {
      continue;
    }
    const servers = parsed.mcpServers || {};
    for (const name of Object.keys(servers).sort()) {
      const key = `${name}@${origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const cfg = servers[name];
      const md = extractFromMcpServer(name, cfg);
      out.push({
        ...md,
        id: `mcp-server:${name}`,
        fingerprint: fingerprint(JSON.stringify({ name, cfg, origin })),
      });
    }
  }
  return out;
}

/** Full deterministic discovery across all four sources. */
export function discoverAll(roots: DiscoveryRoots): DiscoveredCapability[] {
  const claude = path.join(roots.homeDir, ".claude");
  const out: DiscoveredCapability[] = [
    ...discoverSkills(path.join(claude, "skills"), "skill"),
    ...discoverSkills(path.join(roots.homeDir, ".agents", "skills"), "skill"),
    ...discoverSkills(path.join(roots.workspaceDir, ".claude", "skills"), "skill"),
    ...discoverAgents(path.join(claude, "agents"), "agent"),
    ...discoverAgents(path.join(roots.workspaceDir, ".claude", "agents"), "agent"),
    ...discoverPlugins(claude),
    ...discoverMcp(roots),
  ];
  return out;
}

/**
 * Cheap change signal for the discovery roots: (path, size, mtime) of every
 * file discovery reads — no content reads, so it's fast enough to run on
 * every prompt. Mirrors discoverAll's traversal exactly. A fingerprint
 * mismatch means the persisted index is stale and must be rebuilt.
 * ponytail: stat-based — an edit that preserves size+mtime slips through to a
 * stale index; a per-file content hash fixes it if that ever matters.
 */
export function scanFingerprint(roots: DiscoveryRoots): string {
  const claude = path.join(roots.homeDir, ".claude");
  const files = new Set<string>();
  const addSkills = (root: string) => {
    if (existsSync(root)) for (const f of walkFiles(root, "SKILL.md")) files.add(f);
  };
  const addAgents = (root: string) => {
    if (!existsSync(root)) return;
    for (const f of sortedEntries(root)) {
      const full = path.join(root, f);
      if (isFile(full) && f.toLowerCase().endsWith(".md")) files.add(full);
    }
  };
  addSkills(path.join(claude, "skills"));
  addSkills(path.join(roots.homeDir, ".agents", "skills"));
  addSkills(path.join(roots.workspaceDir, ".claude", "skills"));
  addAgents(path.join(claude, "agents"));
  addAgents(path.join(roots.workspaceDir, ".claude", "agents"));
  const pluginsRoot = path.join(claude, "plugins");
  if (existsSync(pluginsRoot)) {
    for (const mp of sortedEntries(pluginsRoot)) {
      if (IGNORE_DIRS.has(mp)) continue;
      const mpDir = path.join(pluginsRoot, mp);
      for (const pid of sortedEntries(mpDir)) {
        if (IGNORE_DIRS.has(pid)) continue;
        const pr = path.join(mpDir, pid, "plugin-root");
        if (!existsSync(pr)) continue;
        addSkills(path.join(pr, "skills"));
        addAgents(path.join(pr, "agents"));
      }
    }
  }
  for (const f of [path.join(roots.workspaceDir, ".mcp.json"), path.join(roots.homeDir, ".claude.json")]) {
    if (existsSync(f)) files.add(f);
  }
  const parts: string[] = [];
  for (const f of [...files].sort()) {
    let st;
    try {
      st = statSync(f);
    } catch {
      continue; // deleted mid-scan → treat as gone
    }
    parts.push(`${f}:${st.size}:${st.mtimeMs}`);
  }
  return fingerprint(parts.join("|"));
}

/** Index a discovery result by id (later duplicates overwrite earlier ones). */
export function indexById(discovered: DiscoveredCapability[]): Map<string, DiscoveredCapability> {
  const map = new Map<string, DiscoveredCapability>();
  for (const d of discovered) map.set(d.id, d);
  return map;
}
