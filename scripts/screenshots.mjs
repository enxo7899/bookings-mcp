// Reproducible README screenshots. Run `npm run dev` in another terminal, then `npm run screenshots`.
import { createRequire } from "node:module";
const { chromium, devices } = createRequire(import.meta.url)("playwright");
const base = process.env.BASE || "http://127.0.0.1:5175/";
const out = process.env.OUT || "docs";
const browser = await chromium.launch();
const errors = [];
async function shot(name, url, { device, viewport = { width: 1400, height: 1000 }, full = false, clip, before } = {}) {
  const ctx = await browser.newContext(device ? { ...devices[device] } : { viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(base + url, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  if (before) await before(page);
  const target = clip ? page.locator(clip) : page;
  await target.screenshot({ path: `${out}/${name}.png`, fullPage: full && !clip });
  await ctx.close();
}
await shot("overview", "?run=happy,double&day=2026-11-19", { viewport: { width: 1400, height: 1300 } });
await shot("prompt-injection", "?run=happy,inject", { viewport: { width: 700, height: 900 }, clip: "main > div:first-child .panel" });
await shot("late-cancel", "?run=late&day=2026-11-17", { viewport: { width: 1400, height: 1000 }, clip: "main > div:last-child" });
await shot("tampered-log", "?run=happy,inject", { viewport: { width: 1400, height: 1000 }, clip: "main > div:last-child .panel:last-child", before: (p) => p.click("#tamper") });
await shot("tool-console", "?console", { viewport: { width: 1400, height: 1100 }, clip: "main > div:first-child .panel", before: async (p) => {
  await p.click("text=Book on a Monday"); await p.click("#callbtn");
  await p.click("text=Book in 30 minutes"); await p.click("#callbtn");
  await p.click("text=Skip the confirmation"); await p.click("#callbtn");
}});
await shot("mobile", "?run=late&day=2026-11-17", { device: "iPhone 13", full: true });
await browser.close();
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log("no console errors");
