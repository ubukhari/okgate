/**
 * Where a running HTTP proxy registers itself (`<state>/http.json`) so `kill`, `approve` and the
 * hook can find it. Kept apart from `proxy/http.ts` so reading it does not load the MCP SDK:
 * `okgate hook pre-tool-use` runs before every guarded tool call and must start fast.
 */
import { join } from "node:path";

export interface HttpRegistration {
  url: string;
  baseUrl: string;
  token: string;
  pid: number;
  startedAt: string;
}

export function registrationPath(stateDir: string): string {
  return join(stateDir, "http.json");
}
