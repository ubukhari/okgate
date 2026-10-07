/**
 * The proxy's tools/list read of an upstream that pages (BUG-3), through the real MCP SDK: an
 * SDK server whose tools/list hands out cursors ↔ the proxy's upstream client, in-process over
 * InMemoryTransport.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { Guard, parsePolicy } from "@agentwares/agentguard-core";
import type { LoadedPolicy } from "@agentwares/agentguard-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { ProxyRuntime } from "./runtime.js";

/** cursor (`""` for the first request) → names on that page and the cursor it hands back */
type Pages = (cursor: string) => { names: string[]; next?: string } | undefined;

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

async function proxyOver(initial: Pages) {
  const state = { pages: initial, asked: [] as (string | undefined)[] };
  const server = new Server(
    { name: "paged", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    const cursor = req.params?.cursor;
    state.asked.push(cursor);
    const page = state.pages(cursor ?? "");
    if (!page) throw new McpError(ErrorCode.InvalidParams, `unknown cursor ${String(cursor)}`);
    return {
      tools: page.names.map((name) => ({
        name,
        description: `${name}: a test tool`,
        inputSchema: { type: "object" as const },
      })),
      ...(page.next !== undefined ? { nextCursor: page.next } : {}),
    };
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "agentguard", version: "test" }, { capabilities: {} });
  await client.connect(clientT);

  const policy = parsePolicy({ mode: "dry-run" });
  const loaded: LoadedPolicy = {
    policy,
    path: "/tmp/agentguard.yaml",
    baseDir: "/tmp",
    stateDir: "/tmp/.agentguard",
    auditPath: "/tmp/audit.jsonl",
    killPath: "/tmp/KILL",
  };
  const logs: string[] = [];
  const runtime = new ProxyRuntime({
    loaded,
    guard: new Guard({ policy, env: {} }),
    defaultRunId: "run_paging",
    log: (line) => void logs.push(line),
    clients: { big: client },
  });
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  await runtime.start();
  const names = () => runtime.listTools().map((t) => t.original);
  /**
   * The upstream says its list changed; resolves once `done()` holds (the proxy logged, or
   * applied the new list), or after 2 s — then the assertions that follow fail and say why.
   */
  const changed = async (pages: Pages, done: (logged: number) => boolean) => {
    state.pages = pages;
    const logged = logs.length;
    await server.sendToolListChanged();
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !done(logged)) await new Promise((r) => setTimeout(r, 10));
  };
  const loggedSince = (n: number) => logs.length > n;
  return { runtime, state, logs, names, changed, loggedSince };
}

const three: Pages = (c) =>
  ({
    "": { names: ["a", "b"], next: "p2" },
    p2: { names: ["c"], next: "p3" },
    p3: { names: ["d"] },
  })[c];

const endless: Pages = (c) => {
  const n = c === "" ? 0 : Number(c.slice(1));
  return { names: [`t${n}`], next: `c${n + 1}` };
};

describe("agentguard proxy: tools/list paging (BUG-3)", () => {
  it("reads a three-page list", async () => {
    const p = await proxyOver(three);
    expect(p.names()).toEqual(["a", "b", "c", "d"]);
    expect(p.state.asked).toEqual([undefined, "p2", "p3"]);
  });

  it("does not loop on an upstream that echoes its cursor", async () => {
    // The defect: `do { … } while (cursor)` asked for p2 again, and again, forever.
    const p = await proxyOver((c) =>
      c === "" ? { names: ["a"], next: "p2" } : { names: ["b"], next: "p2" },
    );
    expect(p.names()).toEqual(["a", "b"]);
    expect(p.state.asked).toEqual([undefined, "p2"]);
  });

  it("does not loop on cursors that cycle", async () => {
    const map: Record<string, { names: string[]; next?: string }> = {
      "": { names: ["a"], next: "x" },
      x: { names: ["b"], next: "y" },
      y: { names: ["c"], next: "x" },
    };
    const p = await proxyOver((c) => map[c]);
    expect(p.names()).toEqual(["a", "b", "c"]);
    expect(p.state.asked).toEqual([undefined, "x", "y"]);
  });

  it("stops after 20 pages and keeps the last good list, saying why", async () => {
    const p = await proxyOver(three);
    expect(p.names()).toEqual(["a", "b", "c", "d"]);
    const before = p.state.asked.length;
    await p.changed(endless, p.loggedSince);
    expect(p.state.asked.length - before).toBe(20);
    expect(p.names()).toEqual(["a", "b", "c", "d"]);
    expect(p.logs.join("\n")).toMatch(
      /tools\/list for "big" not applied: tools\/list had more than 20 pages .*; keeping the last good list \(4 tools\)/,
    );
  });

  it("stops past 2,000 tools and keeps the last good list", async () => {
    const p = await proxyOver(three);
    const names = Array.from({ length: 2_001 }, (_, i) => `t${i}`);
    await p.changed((c) => (c === "" ? { names } : undefined), p.loggedSince);
    expect(p.names()).toEqual(["a", "b", "c", "d"]);
    expect(p.logs.join("\n")).toContain("more than 2000 items");
  });

  it("keeps the last good list when a refresh fails", async () => {
    // It used to empty the upstream's tools on any tools/list error.
    const p = await proxyOver(three);
    await p.changed((c) => (c === "" ? { names: ["a"], next: "gone" } : undefined), p.loggedSince);
    expect(p.names()).toEqual(["a", "b", "c", "d"]);
    expect(p.logs.join("\n")).toMatch(
      /tools\/list failed for "big": .*unknown cursor gone.*; keeping the last good list \(4 tools\)/,
    );
  });

  it("applies a good refresh", async () => {
    const p = await proxyOver(three);
    await p.changed(
      (c) => (c === "" ? { names: ["e"], next: "q" } : { names: ["f"] }),
      () => p.names().join() === "e,f",
    );
    expect(p.names()).toEqual(["e", "f"]);
  });
});
