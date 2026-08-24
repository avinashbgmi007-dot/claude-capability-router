/**
 * Configuration loading + defaults. Deterministic: config file is optional,
 * defaults are fixed, merges are shallow and stable.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { RouterConfig } from "./types.js";

export const DEFAULT_CONFIG: RouterConfig = {
  // harness-tuned on the real skills corpus (eval/config.json): real SKILL.md
  // files carry their routing signal in description+name only, so those weights
  // are raised and actions/domains lowered; 0.38 keeps description-rich prompts
  // routing while chit-chat still passes through (FPR stays 0).
  threshold: 0.38,
  ambiguityBand: 0.05,
  // body: trigger words inside SKILL.md bodies (long prose) nudge near-miss
  // routing without dominating — a body-only match stays below τ.
  weights: { purpose: 0.3, actions: 0.08, domains: 0.06, examples: 0.08, description: 0.28, name: 0.15, body: 0.05 },
  aliases: {
    // shorthand (canonical: [variants])
    you: ["u", "ur", "ya"], please: ["pls", "plz"], thanks: ["thx"], okay: ["ok"],
    want: ["wanna"], give: ["gimme"], me: ["meh"], dont: ["dunno", "dont"], know: ["dunno"],
    // cross-language pairs (metadata is English; prompts may not be)
    video: ["剪辑", "剪", "视频"], email: ["邮件", "邮箱"], draft: ["草稿"], summarize: ["总结", "摘要", "概括"],
    extract: ["提取", "抽取"], pdf: ["文档"], create: ["创建", "新建"], skill: ["技能"],
    file: ["文件"], logs: ["日志"], debug: ["调试"], fix: ["修复"], review: ["审查", "评审"],
    post: ["发布", "发"], send: ["发送", "发"], issue: ["问题"], plan: ["计划"],
    twitter: ["x"], chart: ["图表", "图"], bug: ["缺陷"], ticket: ["工单"],
  },
  stopwords: [
    "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from",
    "is", "are", "was", "were", "be", "been", "i", "me", "my", "you", "your", "we", "our",
    "it", "its", "this", "that", "these", "those", "can", "could", "would", "should", "will",
    "please", "help", "hi", "hello", "hey", "do", "does", "did", "have", "has", "had", "there",
    "today", "now", "right", "need", "wanna", "want", "like", "really", "just", "get", "make",
    "use", "using", "via", "through", "about", "into", "them", "they", "their", "me", "us",
    "new", "first", "then", "after", "next", "also", "up", "out", "off", "what", "think",
    "well", "gonna", "would", "could", "shall", "may", "might", "must", "let", "lets",
  ],
  capabilities: {},
  exclude: [],
  verbosity: "brief",
  tokenBudget: 300,
  forcePrefix: "@cmr",
  domainRouting: { enabled: true, representatives: {} },
};

export function loadConfig(configPath?: string): RouterConfig {
  const file = configPath || path.join(process.env.CLAUDE_CMR_HOME || "", "config.json");
  if (!file) return structuredClone(DEFAULT_CONFIG);
  if (!existsSync(file)) return structuredClone(DEFAULT_CONFIG);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RouterConfig>;
    return mergeConfig(DEFAULT_CONFIG, raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

function mergeConfig(base: RouterConfig, raw: Partial<RouterConfig>): RouterConfig {
  const out: RouterConfig = structuredClone(base);
  if (typeof raw.threshold === "number") out.threshold = raw.threshold;
  if (typeof raw.ambiguityBand === "number") out.ambiguityBand = raw.ambiguityBand;
  if (raw.weights) out.weights = { ...out.weights, ...raw.weights };
  if (raw.aliases) out.aliases = { ...out.aliases, ...raw.aliases };
  if (Array.isArray(raw.stopwords)) out.stopwords = raw.stopwords;
  if (raw.capabilities) out.capabilities = { ...out.capabilities, ...raw.capabilities };
  if (Array.isArray(raw.exclude)) out.exclude = raw.exclude;
  if (raw.verbosity === "full" || raw.verbosity === "brief") out.verbosity = raw.verbosity;
  if (typeof raw.tokenBudget === "number") out.tokenBudget = raw.tokenBudget;
  if (typeof raw.forcePrefix === "string") out.forcePrefix = raw.forcePrefix;
  if (raw.domainRouting && typeof raw.domainRouting === "object") {
    out.domainRouting = {
      enabled: raw.domainRouting.enabled ?? out.domainRouting.enabled,
      representatives: { ...out.domainRouting.representatives, ...(raw.domainRouting.representatives ?? {}) },
    };
    // chat is the catch-all category — a chat representative would fire on
    // every prompt, contradicting safe-pass-through. Rejected, not honored.
    delete (out.domainRouting.representatives as { chat?: string }).chat;
  }
  return out;
}
