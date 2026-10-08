# Privacy: the agentguard CLI and Claude Code plugin

This note covers `@agentwares/agentguard` (the CLI, `npx @agentwares/agentguard`) and the agentguard
plugin for Claude Code and Gemini CLI, which only run that CLI. The hosted agentguard service has its
own note: https://agentwares-agentguard.vercel.app/privacy.

**Nothing is sent to us.** The CLI and the plugin need no account, make no network call to
agentwares, carry no telemetry and call no model. Everything below stays on your machine.

## What it reads and keeps, by command

- **`init` and the proxy (`proxy`):** reads your MCP client's config and rewrites it to route through
  the proxy, keeping a backup. While your agent runs, it forwards each MCP call to the MCP server
  you configured — the only network traffic is between your agent and your own servers. It keeps
  `agentguard.yaml`, approvals, counters and a hash-chained audit log of each call (tool, arguments,
  decision, and in dry-run the faked result) in the project's `.agentguard/` folder. That log can
  contain whatever your tools pass, including personal data, so treat it like your own logs.
- **Hook mode (`hooks install`, `hook pre-tool-use`):** the coding agent passes each tool call (the
  shell command, file path or MCP call) to the hook. In Claude Code, the hook also reads the end of
  the current session's transcript file to find the latest message a person typed, to decide whether
  an irreversible command (push, merge, publish, send, delete outside the workspace) may run. It keeps
  the command, the decision and an approval id in the same `.agentguard/` audit log; it does not copy
  messages anywhere.
- **`audit`:** reads this repository's rule files (CLAUDE.md, AGENTS.md, GEMINI.md, `.cursor/rules`)
  and this machine's Claude Code and Codex session files for this repository. It caches counts, rule
  ids, session ids, times and hashes in `~/.agentguard/audit-cache-v1/` — never message text,
  commands or file contents. The command or path behind a broken rule is shown on your screen only.
- **`report`, `diff`, `verify`, `status`:** read the local audit log.

The last line of `audit` links to a page about a future team view. Opening that page is a visit to
our website, covered by the hosted service's note above; leaving an email there is optional.

## Deleting it

Remove the project's `.agentguard/` folder and `~/.agentguard/`, run `agentguard hooks uninstall`,
and `agentguard init --undo` to restore your MCP config. Nothing else exists to delete, because
nothing was sent.

## Who and how to ask

agentwares is operated by TrainedBooks. Questions: https://agentwares.vercel.app/contact.
