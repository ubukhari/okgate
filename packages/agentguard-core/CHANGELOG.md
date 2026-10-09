# Changelog

`@agentwares/agentguard-core`, the policy engine behind `@agentwares/agentguard` and
`@agentwares/agentguard-sdk`. Earlier versions are described in the CLI's changelog.

## 0.1.6 — 2026-10-08

### Changed

- **agentguard is now okgate.** Policy defaults are `.okgate/` (`state.dir`, `audit.path`,
  `kill.file`) and `OKGATE_KILL`; messages name `okgate` and the policy file actually loaded.
- `names.ts`: the product's names in one place (`POLICY_FILES`, `STATE_DIR`, `envTwin`,
  `resolveToolName`, `OLD_NAMES_UNTIL`), and a `TOOL_RENAMED` error code.

### Kept working

- `Guard` halts on `AGENTGUARD_KILL` and `OKGATE_KILL` as well as the policy's `kill.env`.
- `loadPolicyFile` keeps an existing `.agentguard/` (when there is no `.okgate/`) for every path
  the policy does not name, so its hash chain continues; `findPolicyFile` reads `okgate.yaml`,
  else `agentguard.yaml`. `FileKillSwitch` takes more KILL files that also halt
  (`killSwitchFor(loaded)` checks both directories).
- Hook mode refuses the agent's own `okgate`/`agentguard` approvals (including
  `npx -p @agentwares/agentguard okgate approve`) and writes to either state directory.
- `<!-- agentguard: … -->` inline checks, `X-Agentguard-Key`, `agentguard*.yaml` in permission
  diffs.

## 0.1.5 — 2026-10-07

### Added

- **Rule extraction** (`extractRules`, `matchRuleText`, `parseCheck`, `formatCheck`,
  `CHECK_PATTERNS`): the rules CLAUDE.md, AGENTS.md, GEMINI.md and `.cursor/rules` state, each
  mapped by a pattern library (no LLM) to a mechanical check, or by an inline
  `<!-- agentguard: <check> -->`, or by `audit.rules` in the policy. Thirteen check kinds:
  `no-push`, `no-commit-to`, `no-force-push`, `no-verify`, `run-before`, `package-manager`,
  `no-edit`, `no-commit`, `no-new-deps`, `no-rm-outside`, `no-publish`, `no-deploy`, `never`,
  each with an optional `unless-asked`.
- **Adherence** (`ClaudeCodeAuditReader`, `CodexAuditReader`, `evaluateChecks`,
  `summarizeAudit`, `describeStep`): transcript lines to steps through hook mode's own reading of
  a tool call (`hookActionFromInput`, `assessHookAction`) and of a person's turn
  (`classifyTranscriptEntry`, `evaluateHumanTurn`); per-check results that hold counts, times,
  line numbers and hashed call ids only, so they can be cached without any transcript text.
- **`planEnforcement`**: the checks as hook-mode rules (`hooks.shell.deny|approval`,
  `hooks.paths.deny`, built-in irreversible classes, custom irreversible rules), with the ones a
  pre-execution hook cannot express listed as audit-only.
- `audit.rules` in the policy schema (`AuditRulesSchema`).
