/**
 * Metadata extraction: converts raw capability source files into
 * normalized CapabilityMetadata records. Deterministic.
 *
 * Supported formats:
 *  - SKILL.md / agent .md: YAML-lite frontmatter between --- fences
 *  - MCP server config: JSON (name, command, args, tools?)
 */
import type { CapabilityKind, CapabilityMetadata } from "./types.js";

interface ParsedDoc {
  front: Record<string, unknown>;
  body: string;
}

/** YAML-lite frontmatter parser (keys, inline values, list items, continuation lines). */
export function parseFrontmatter(text: string): ParsedDoc {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { front: {}, body: text.trim() };
  const front: Record<string, unknown> = {};
  const lines = m[1].split(/\r?\n/);
  let curKey: string | null = null;
  for (const line of lines) {
    const list = line.match(/^\s*-\s+(.+)$/);
    if (list && curKey) {
      const arr = front[curKey];
      if (Array.isArray(arr)) arr.push(unquote(list[1].trim()));
      else front[curKey] = [unquote(list[1].trim())];
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) {
      curKey = kv[1];
      const v = kv[2].trim();
      front[curKey] = v === "" ? [] : unquote(v);
      continue;
    }
    // continuation of previous key (e.g. wrapped description)
    const t = line.trim();
    if (curKey && t && typeof front[curKey] === "string") {
      front[curKey] = `${front[curKey]} ${t}`;
    }
  }
  return { front, body: m[2].trim() };
}

function unquote(v: string): string {
  return v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
    ? v.slice(1, -1)
    : v;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(asString).filter(Boolean);
  if (typeof v === "string") {
    // comma-separated or bracket-wrapped list
    const inner = v.replace(/^\[|\]$/g, "");
    return inner.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const cut = t.search(/[.\n](?=\s|$)/);
  return cut === -1 ? t : t.slice(0, cut + 1);
}

export interface FrontmatterCapabilityInput {
  name: string;
  kind: CapabilityKind;
  sourcePath: string;
  rawText: string;
  /** kind-specific extra fields (e.g. tools for agents) */
  extra?: Record<string, unknown>;
}

/** Extract metadata from a frontmatter-based capability file (SKILL.md / agent .md). */
export function extractFromMarkdown(input: FrontmatterCapabilityInput): CapabilityMetadata {
  const { front, body } = parseFrontmatter(input.rawText);
  const name = asString(front.name) || input.name;
  const description = asString(front.description) || firstSentence(body) || "";
  const actions = asList(front.actions).length
    ? asList(front.actions)
    : asList(front.triggers).length
      ? asList(front.triggers)
      : asList(front.tools).length
        ? asList(front.tools)
        : asList(input.extra?.tools);
  return {
    name,
    kind: input.kind,
    purpose: asString(front.purpose) || firstSentence(description) || name,
    description,
    body,
    actions,
    domains: asList(front.domains),
    examples: asList(front.examples),
    category: asString(front.category) || defaultCategory(input.kind),
    invocation: asString(front.invocation) || name,
    sourcePath: input.sourcePath,
  };
}

/** Extract metadata from an MCP server config entry. */
export function extractFromMcpServer(serverName: string, config: Record<string, unknown>): CapabilityMetadata {
  const tools = asList(config.tools ?? (config as { tools?: unknown }).tools);
  const command = asString(config.command) || "mcp";
  const configuredDescription = asString(config.description);
  const description =
    (configuredDescription || `MCP server ${serverName} (${command}).`) +
    (tools.length ? ` Provides tools: ${tools.join(", ")}.` : "");
  return {
    name: serverName,
    kind: "mcp-server",
    purpose: `Access ${serverName} tools` + (configuredDescription ? ` for ${firstSentence(configuredDescription)}` : ""),
    description,
    body: "",
    actions: tools,
    domains: [serverName.toLowerCase()],
    examples: [],
    category: "mcp",
    invocation: serverName,
    sourcePath: `mcp:${serverName}`,
  };
}

export function defaultCategory(kind: CapabilityKind): string {
  switch (kind) {
    case "skill":
    case "plugin-skill":
      return "skill";
    case "agent":
    case "plugin-agent":
      return "agent";
    case "mcp-server":
    case "mcp-tool":
      return "mcp";
  }
}
