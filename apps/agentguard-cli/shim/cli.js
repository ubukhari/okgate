#!/usr/bin/env node
// `agentguard` (and the interim `npx -p @agentwares/agentguard okgate`) run @agentwares/okgate.
// MCP configs and docs that say `npx -y @agentwares/agentguard` land here (pinned hooks keep the
// version they name), so it must behave exactly like the okgate CLI: same argv, same stdout, same
// exit code. The one deprecation line goes to stderr.
import { notice } from "./notice.js";

notice("@agentwares/agentguard", "@agentwares/okgate");

// okgate's cli.js runs itself when it is the process's entry point; this flag tells it that it is
// being run from here, so main() runs once.
globalThis[Symbol.for("okgate.cli.embedded")] = true;
const { main } = await import("@agentwares/okgate/cli");
main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
