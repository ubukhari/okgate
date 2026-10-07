# Changelog

`@agentwares/agentguard-core`, the policy engine behind `@agentwares/agentguard` and
`@agentwares/agentguard-sdk`. Earlier versions are described in the CLI's changelog.

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
