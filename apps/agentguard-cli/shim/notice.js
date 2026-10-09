// One line on stderr, once per process however many shims load. Never stdout: it carries the
// stdio MCP protocol and hook answers. Silent where there is no stderr (browsers, Workers).
const KEY = Symbol.for("okgate.rename.notice");

export function notice(oldName, newName) {
  if (globalThis[KEY]) return;
  globalThis[KEY] = true;
  if (typeof process === "undefined" || !process.stderr?.write) return;
  process.stderr.write(
    `${oldName} is now ${newName} (agentguard was renamed okgate); it keeps working, switch when convenient\n`,
  );
}
