# Graph Report - .  (2026-08-24)

## Corpus Check
- Corpus is ~23,455 words - fits in a single context window. You may not need a graph.

## Summary
- 140 nodes · 224 edges · 21 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_CLI Commands|CLI Commands]]
- [[_COMMUNITY_Plugin Discovery|Plugin Discovery]]
- [[_COMMUNITY_Intent Scoring|Intent Scoring]]
- [[_COMMUNITY_Config & Types|Config & Types]]
- [[_COMMUNITY_Usage Logging|Usage Logging]]
- [[_COMMUNITY_Eval Harness|Eval Harness]]
- [[_COMMUNITY_Metadata Extraction|Metadata Extraction]]
- [[_COMMUNITY_Routing & Fingerprinting|Routing & Fingerprinting]]
- [[_COMMUNITY_Index Store|Index Store]]
- [[_COMMUNITY_Path Resolution|Path Resolution]]
- [[_COMMUNITY_Phase 5 Integration Tests|Phase 5 Integration Tests]]
- [[_COMMUNITY_Phase 4 Enhancer Tests|Phase 4 Enhancer Tests]]
- [[_COMMUNITY_Phase 6 Hardening Tests|Phase 6 Hardening Tests]]
- [[_COMMUNITY_Phase 7 Stats Tests|Phase 7 Stats Tests]]
- [[_COMMUNITY_Phase 8 Commands Tests|Phase 8 Commands Tests]]
- [[_COMMUNITY_Phase 1 Discovery Tests|Phase 1 Discovery Tests]]
- [[_COMMUNITY_Phase 2 Scoring Tests|Phase 2 Scoring Tests]]
- [[_COMMUNITY_Phase 3 Planner Tests|Phase 3 Planner Tests]]
- [[_COMMUNITY_LLama Guard Install|LLama Guard Install]]
- [[_COMMUNITY_LLama Guard Runner|LLama Guard Runner]]
- [[_COMMUNITY_LLama Guard Tuned Launcher|LLama Guard Tuned Launcher]]

## God Nodes (most connected - your core abstractions)
1. `main()` - 8 edges
2. `install()` - 7 edges
3. `discoverAgents()` - 7 edges
4. `discoverSkills()` - 6 edges
5. `discoverCommands()` - 6 edges
6. `discoverPlugins()` - 6 edges
7. `discoverAll()` - 6 edges
8. `extractFromMarkdown()` - 6 edges
9. `uninstall()` - 5 edges
10. `validate()` - 5 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "CLI Commands"
Cohesion: 0.25
Nodes (10): atomicWrite(), copyRuntime(), getHookList(), hasHookRegistration(), hookCommand(), install(), readSettings(), uninstall() (+2 more)

### Community 1 - "Plugin Discovery"
Cohesion: 0.36
Nodes (12): discoverAgents(), discoverAll(), discoverCommands(), discoverMcp(), discoverPlugins(), discoverSkills(), isFile(), readSafe() (+4 more)

### Community 2 - "Intent Scoring"
Cohesion: 0.24
Nodes (7): buildAliasLookup(), extractMainClause(), normalizeTokens(), tablesFor(), tokenize(), fieldMatch(), scoreCapability()

### Community 3 - "Config & Types"
Cohesion: 0.24
Nodes (8): loadConfig(), mergeConfig(), buildEnhancedPrompt(), escapeXml(), estimateTokens(), invocationFor(), computeStats(), tsOf()

### Community 4 - "Usage Logging"
Cohesion: 0.27
Nodes (8): appendDecisionLog(), appendUsageLog(), compactLog(), loadDecisionLog(), loadUsageLog(), promptHash(), readJsonl(), toDecisionEntry()

### Community 5 - "Eval Harness"
Cohesion: 0.5
Nodes (8): collectExpectedIds(), defaultCorpusPath(), defaultFixtureRoots(), discoveryCoverage(), loadCorpus(), main(), repoRoot(), runRoutingMetrics()

### Community 6 - "Metadata Extraction"
Cohesion: 0.47
Nodes (8): asList(), asString(), defaultCategory(), extractFromMarkdown(), extractFromMcpServer(), firstSentence(), parseFrontmatter(), unquote()

### Community 7 - "Routing & Fingerprinting"
Cohesion: 0.28
Nodes (4): fingerprint(), fingerprintJson(), fragmentWeight(), splitIntents()

### Community 8 - "Index Store"
Cohesion: 0.46
Nodes (7): buildIndex(), indexFile(), loadIndex(), manifestFile(), saveIndex(), updateIndex(), writeAtomic()

### Community 9 - "Path Resolution"
Cohesion: 0.36
Nodes (4): cmrHome(), installRoot(), logsDir(), stateDir()

### Community 10 - "Phase 5 Integration Tests"
Cohesion: 0.4
Nodes (0): 

### Community 11 - "Phase 4 Enhancer Tests"
Cohesion: 0.5
Nodes (0): 

### Community 12 - "Phase 6 Hardening Tests"
Cohesion: 0.5
Nodes (0): 

### Community 13 - "Phase 7 Stats Tests"
Cohesion: 0.5
Nodes (0): 

### Community 14 - "Phase 8 Commands Tests"
Cohesion: 0.5
Nodes (0): 

### Community 15 - "Phase 1 Discovery Tests"
Cohesion: 0.67
Nodes (0): 

### Community 16 - "Phase 2 Scoring Tests"
Cohesion: 0.67
Nodes (0): 

### Community 17 - "Phase 3 Planner Tests"
Cohesion: 1.0
Nodes (0): 

### Community 18 - "LLama Guard Install"
Cohesion: 1.0
Nodes (0): 

### Community 19 - "LLama Guard Runner"
Cohesion: 1.0
Nodes (0): 

### Community 20 - "LLama Guard Tuned Launcher"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **Thin community `Phase 3 Planner Tests`** (2 nodes): `makeRouter()`, `phase3-planner.test.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LLama Guard Install`** (1 nodes): `install-task.ps1`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LLama Guard Runner`** (1 nodes): `run-guard.ps1`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `LLama Guard Tuned Launcher`** (1 nodes): `tuned-launch.ps1`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Not enough signal to generate questions. This usually means the corpus has no AMBIGUOUS edges, no bridge nodes, no INFERRED relationships, and all communities are tightly cohesive. Add more files or run with --mode deep to extract richer edges._