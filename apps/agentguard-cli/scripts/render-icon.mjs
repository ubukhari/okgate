// Renders the Claude plugin directory icon (a square PNG, 512-2048 px, no SVG accepted) from
// distribution/icon/icon.svg. Uses the Playwright the monorepo already has for the readiness
// scorer, so there is no new dependency. Run: node apps/agentguard-cli/scripts/render-icon.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const repo = path.resolve(app, "../..");
const require = createRequire(path.join(repo, "assets/readiness-scorer/package.json"));
const { chromium } = require("playwright");

const svg = readFileSync(path.join(app, "distribution/icon/icon.svg"), "utf8");
const out = path.join(app, "distribution/root/plugins/agentguard/.claude-plugin/icon.png");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
} finally {
  await browser.close();
}
console.log(`wrote ${path.relative(repo, out)}`);
