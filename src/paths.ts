/**
 * Path resolution with environment overrides (used by tests to redirect
 * every write outside the real user home).
 */
import { homedir } from "node:os";
import path from "node:path";

export interface DiscoveryRoots {
  /** Global/machine-wide root: <home>/.claude (skills, agents, plugins) and <home>/.claude.json (MCP). */
  homeDir: string;
  /** Workspace root: .claude/skills, .claude/agents, .mcp.json. */
  workspaceDir: string;
}

export function cmrHome(): string {
  return process.env.CLAUDE_CMR_HOME || path.join(homedir(), ".claude-cmr");
}

export function discoveryRoots(): DiscoveryRoots {
  return {
    homeDir: process.env.CLAUDE_CMR_HOME_DIR || homedir(),
    workspaceDir: process.env.CLAUDE_CMR_WORKSPACE_DIR || process.cwd(),
  };
}

export function settingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH || path.join(homedir(), ".claude", "settings.json");
}

export function stateDir(): string {
  return path.join(cmrHome(), "state");
}

export function logsDir(): string {
  return path.join(cmrHome(), "logs");
}

export function installRoot(): string {
  return cmrHome();
}

export function claudeDir(root: DiscoveryRoots): string {
  return path.join(root.homeDir, ".claude");
}
