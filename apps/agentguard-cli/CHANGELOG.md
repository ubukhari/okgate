# Changelog

`@agentwares/agentguard`, the CLI and MCP proxy. A tag `agentguard-v<version>` publishes the
GitHub Release for a version with its section below as the notes.

## 0.1.6 — 2026-10-07

### Added

- **A working MCP server with no configuration.** Started with no `agentguard.yaml` and no
  `--config` / `AGENTGUARD_CONFIG` (an install button, a registry install, the Dockerfile),
  `agentguard proxy` no longer exits with `INVALID_POLICY`. It fronts no servers and serves three
  read-only tools of its own: `agentguard_get_status` (policy, mode, upstreams, caps used and
  remaining, kill switch, pending approvals), `agentguard_get_report` (what a run did, or would
  have done in dry-run, and every call that was halted) and `agentguard_verify_audit_log` (the
  hash chain). Each has a title, `readOnlyHint: true`, a strict input schema and a documented
  output schema; errors carry `code`, `cause`, `fix` and `retryable`. That mode writes nothing to
  the directory it was started in. A policy with no upstreams serves the same three tools; with
  upstreams configured the agent sees only the upstreams' tools, as before. A policy file that was
  named and is missing is still an error.
- **Claude Code plugin marketplace** at the repo root:
  `/plugin marketplace add agentwares/agentguard`, then `/plugin install agentguard@agentwares`.
  `/agentguard:init` runs `init` and explains the policy it wrote; `/agentguard:report` explains a
  run.
- **Gemini CLI extension** at the repo root:
  `gemini extensions install https://github.com/agentwares/agentguard`, with the same two
  commands.
- **`init` and `connect` read Gemini CLI's `.gemini/settings.json`** (and `~/.gemini/settings.json`
  with `--client`). Gemini's `httpUrl` is read as Streamable HTTP, and `connect` writes `httpUrl`
  there, because Gemini dials `url` as SSE.
- **A root `Dockerfile`**: `docker run -i --rm agentguard` serves the tools above over stdio;
  `proxy --config /app/demo/agentguard.yaml` puts the bundled fake CRM behind the proxy.
- **Install links** for Cursor and VS Code in the README.

### Fixed

- The README's example of the config `init` writes showed the unscoped package name, which does
  not exist on npm; `init` itself has written `@agentwares/agentguard` since 0.1.4.
- README links to the permission-diff Action pointed at a path that exists only in the private
  monorepo.

## 0.1.5 — 2026-09-11

- The 0.1.4 package was published with `workspace:^` dependency ranges and could not be installed.
  Republished with real versions.

## 0.1.4 — 2026-09-11

- The MCP config `init` writes now starts `npx -y @agentwares/agentguard proxy`. It named the
  unscoped `agentguard`, which does not exist on npm, so the proxy never started.

## 0.1.3 — 2026-09-07

- `agentguard connect <key>` points an MCP client at a hosted agentguard proxy.
- A spend cap that could fail open fails closed.

## 0.1.2 — 2026-09-07

- Absolute README links, so they work on npmjs.com.

## 0.1.1 — 2026-09-07

- Package links point at the public repository.

## 0.1.0 — 2026-09-02

- First release: the MCP policy proxy (stdio and Streamable HTTP, several upstreams), dry-run
  writes with mutation diffs, spend and blast-radius caps, approvals, a kill switch, scoped agent
  keys, a loop breaker and a hash-chained audit log.
