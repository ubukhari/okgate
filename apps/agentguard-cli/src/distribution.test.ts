/**
 * The files that put agentguard where agent builders already are: the README's install buttons,
 * this package's CHANGELOG (the release notes), and the repo-root files the sync copies from
 * `distribution/root` (Claude Code plugin marketplace, Gemini CLI extension, Dockerfile, release
 * workflow). The public repo has those at its root and not under this package, so their checks
 * run in the monorepo only; `scripts/sync-oss-repos.sh` re-validates them when it copies them.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { parsePolicy } from "@agentwares/agentguard-core";
import { isProxyEntry, type ServerEntry } from "./configs.js";

const here = (rel: string): URL => new URL(`../${rel}`, import.meta.url);
const read = (rel: string): string => readFileSync(here(rel), "utf8");
const json = <T>(rel: string): T => JSON.parse(read(rel)) as T;
const pkg = json<{ name: string; version: string }>("package.json");

describe("install links in the README", () => {
  const readme = read("README.md");
  const href = (prefix: string): URL => {
    const match = readme.match(new RegExp(`\\]\\((${prefix.replace(/[.?]/g, "\\$&")}[^)\\s]+)\\)`));
    expect(match, `a link starting ${prefix}`).toBeTruthy();
    return new URL(match![1]!);
  };

  it("Add to Cursor carries the base64 server config that `init` recognises as the proxy", () => {
    const url = href("https://cursor.com/link/mcp/install?");
    expect(url.searchParams.get("name")).toBe("agentguard");
    const config = JSON.parse(
      Buffer.from(url.searchParams.get("config")!, "base64").toString("utf8"),
    ) as ServerEntry;
    expect(config).toEqual({ command: "npx", args: ["-y", pkg.name, "proxy"] });
    // so a later `init` skips it instead of wrapping agentguard in itself
    expect(isProxyEntry(config)).toBe(true);
  });

  it("Install in VS Code carries the same server, as vscode:mcp/install expects it", () => {
    const url = href("https://vscode.dev/redirect/mcp/install?");
    expect(url.searchParams.get("name")).toBe("agentguard");
    const config = JSON.parse(url.searchParams.get("config")!) as ServerEntry;
    expect(config).toEqual({ type: "stdio", command: "npx", args: ["-y", pkg.name, "proxy"] });
    expect(isProxyEntry(config)).toBe(true);
  });
});

describe("CHANGELOG", () => {
  it("has a section for this version, which the release workflow uses as the notes", () => {
    expect(read("CHANGELOG.md")).toMatch(
      new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")} `, "m"),
    );
  });
});

const root = "distribution/root";
describe.skipIf(!existsSync(here(root)))("repo-root files (distribution/root)", () => {
  it("the marketplace's plugin resolves, and versions match this package", () => {
    const marketplace = json<{
      name: string;
      owner: { name: string };
      plugins: { name: string; source: string }[];
    }>(`${root}/.claude-plugin/marketplace.json`);
    expect(marketplace.owner.name).toBe("agentwares");
    for (const entry of marketplace.plugins) {
      expect(entry.source.startsWith("./")).toBe(true);
      const plugin = json<{ name: string; version: string }>(
        `${root}/${entry.source.slice(2)}/.claude-plugin/plugin.json`,
      );
      expect(plugin.name).toBe(entry.name);
      expect(plugin.version).toBe(pkg.version);
    }
    const gemini = json<{ name: string; version: string }>(`${root}/gemini-extension.json`);
    expect(gemini).toMatchObject({ name: "agentguard", version: pkg.version });
  });

  it("every skill and Gemini command says what it runs: the published package", () => {
    const skills = readdirSync(here(`${root}/plugins/agentguard/skills`));
    expect(skills.sort()).toEqual(["audit", "hooks", "init", "report"]);
    for (const skill of skills) {
      const text = read(`${root}/plugins/agentguard/skills/${skill}/SKILL.md`);
      const front = YAML.parse(text.split("---")[1]!) as Record<string, unknown>;
      expect(front.name).toBe(skill);
      expect(String(front.description).length).toBeGreaterThan(80);
      expect(text).toContain(`npx -y ${pkg.name}@latest ${skill}`);
    }
    // init and hooks rewrite configs: only the user starts them
    for (const skill of ["init", "hooks"]) {
      const front = YAML.parse(
        read(`${root}/plugins/agentguard/skills/${skill}/SKILL.md`).split("---")[1]!,
      ) as Record<string, unknown>;
      expect(front["disable-model-invocation"]).toBe(true);
    }
    // the audit reads counts only: it never runs --enforce on its own
    const audit = read(`${root}/plugins/agentguard/skills/audit/SKILL.md`);
    expect(audit).toContain(`npx -y ${pkg.name}@latest audit --json`);
    expect(audit).toContain("Do not run `--enforce` unless the user asks");

    // Claude's plugin directory holds any skill that pre-approves shell commands ("Pre-approves
    // broad shell access in allowed-tools", 8 Oct 2026), even npx-specific ones: Claude Code asks.
    for (const skill of skills) {
      const front = YAML.parse(
        read(`${root}/plugins/agentguard/skills/${skill}/SKILL.md`).split("---")[1]!,
      ) as Record<string, unknown>;
      expect(front["allowed-tools"], `${skill} pre-approves tools`).toBeUndefined();
    }

    for (const command of ["audit", "hooks", "init", "report"]) {
      const toml = read(`${root}/commands/agentguard/${command}.toml`);
      expect(toml).toMatch(/^description = ".+"$/m);
      expect(toml).toMatch(/^prompt = """\n[\s\S]+\n"""\n$/m);
      expect(toml).toContain(`npx -y ${pkg.name}@latest ${command}`);
    }
  });

  it("the plugin has the directory's icon: a square PNG, 512-2048 px, under 2 MB", () => {
    const png = readFileSync(here(`${root}/plugins/agentguard/.claude-plugin/icon.png`));
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(width).toBe(height);
    expect(width).toBeGreaterThanOrEqual(512);
    expect(width).toBeLessThanOrEqual(2048);
    expect(png.length).toBeLessThan(2 * 1024 * 1024);
  });

  it("the Docker demo policy parses and points at the CRM fixture this package builds", () => {
    const demo = parsePolicy(YAML.parse(read(`${root}/docker/demo.agentguard.yaml`)));
    expect(demo.mode).toBe("dry-run");
    expect(demo.upstreams).toEqual([
      expect.objectContaining({
        name: "crm",
        command: "node",
        args: ["/app/dist/fixtures/crm-server.js"],
      }),
    ]);
    expect(read("tsup.config.ts")).toContain('"fixtures/crm-server": "src/fixtures/crm-server.ts"');
    const dockerfile = read(`${root}/Dockerfile`);
    expect(dockerfile).toContain("COPY docker/demo.agentguard.yaml /app/demo/agentguard.yaml");
    expect(dockerfile).toContain(`pnpm --filter ${pkg.name} deploy --prod`);
  });

  it("the release workflow fires on the tag the registry workflow uses", () => {
    const release = YAML.parse(read(`${root}/.github/workflows/release.yml`)) as {
      on: { push: { tags: string[] } };
      permissions: Record<string, string>;
    };
    const registry = YAML.parse(read("publish-mcp.workflow.yml")) as {
      on: { push: { tags: string[] } };
    };
    expect(release.on.push.tags).toEqual(registry.on.push.tags);
    expect(release.permissions).toEqual({ contents: "write" });
  });
});
