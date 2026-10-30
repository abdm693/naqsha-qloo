// End-to-end checks of the deployed app as a guest, with Playwright (Chromium). Each check prints PASS/FAIL and leaves a
// screenshot in e2e/out/. Usage: node smoke.mjs [base_url] [check ...]
// checks: landing sample taste match photos drawing rules family
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "https://naqsha-963839790554.us-central1.run.app";
const only = new Set(process.argv.slice(3));
const OUT = new URL("./out/", import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const DRAWINGS = [new URL("./fixtures/plan-ground.png", import.meta.url).pathname, new URL("./fixtures/plan-first.png", import.meta.url).pathname];

const results = [];
async function check(name, fn, page) {
  if (only.size && !only.has(name)) return;
  const t0 = Date.now();
  try {
    await fn(page);
    results.push([name, "PASS", ((Date.now() - t0) / 1000).toFixed(0) + "s"]);
  } catch (e) {
    results.push([name, "FAIL", String(e.message || e).split("\n")[0]]);
  }
  await page.screenshot({ path: `${OUT}${name}.png` }).catch(() => {});
  console.log(results.at(-1).join("  "));
}

// PW_CHROME: a local Chrome/Chromium binary when Playwright's own download isn't installed.
const browser = await chromium.launch({ executablePath: process.env.PW_CHROME || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await check("landing", async (p) => {
  await p.goto(BASE + "/");
  await p.getByRole("heading", { level: 1 }).waitFor();
  for (const t of ["Start from your own drawing", "Rules for your city", "your family"]) {
    await p.getByText(t, { exact: false }).first().waitFor({ timeout: 10000 });
  }
}, page);

await check("sample", async (p) => {
  await p.goto(BASE + "/");
  await p.getByRole("button", { name: "Explore a sample home" }).click();
  await p.waitForURL(/\/taste/, { timeout: 60000 });
  await p.getByText("Naqsha Taste").first().waitFor({ timeout: 60000 });
  await p.getByRole("radio", { name: "House" }).first().click();
  await p.waitForURL(/\/house/, { timeout: 30000 });
  await p.getByText(/LDA|CDA|local rules/).first().waitFor({ timeout: 60000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Assembling your home"), null, { timeout: 180000 });
}, page);

await check("taste", async (p) => {
  await p.getByRole("radio", { name: "Taste" }).or(p.getByRole("tab", { name: "Taste" })).first().click();
  await p.getByText("Naqsha Taste").first().waitFor({ timeout: 30000 });
  await p.getByText(/Inside: a room for each of you/).first().waitFor({ timeout: 30000 });
  await p.getByText(/How much of you is in it/).first().waitFor({ timeout: 30000 });
  // the neighbourhood: the plot pinned on its map among the places around it
  await p.getByText("Where you'll live").first().waitFor({ timeout: 30000 });
  await p.locator(".nbh-pin").first().waitFor({ timeout: 60000 });
  if (await p.getByText(/Qloo/).count()) throw new Error("the app names Qloo");
  await p.getByText("Because").first().waitFor({ timeout: 30000 });
  await p.goBack();
  await p.waitForURL(/\/house/, { timeout: 30000 });
}, page);

await check("match", async (p) => {
  const chip = p.getByRole("button", { name: /Check against the concept|Matches the concept/ }).first();
  await chip.waitFor({ timeout: 240000 });  // shown once the house has built
  await chip.click();
  const go = p.getByRole("button", { name: /^(Check against the concept|Check again)$/ }).last();
  if (await go.isVisible().catch(() => false)) await go.click();
  // the score, then (below 100%) the facade rebuild it starts
  await p.getByText(/Matches the concept: \d+%|\d+% of the concept is in the model/).first().waitFor({ timeout: 300000 });
}, page);

await check("photos", async (p) => {
  await p.keyboard.press("Escape");
  await p.getByRole("button", { name: /Photos/ }).first().click();
  const make = p.getByRole("button", { name: /Make photos|Remake/ });
  if (await make.isVisible().catch(() => false)) await make.click();
  await p.waitForFunction(() => document.querySelectorAll('[aria-label="Photos of the house"] img[src*="/views/"]').length >= 4,
    null, { timeout: 300000 });
}, page);

await check("drawing", async (p) => {
  await p.goto(BASE + "/app");
  const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.getByRole("button", { name: "Start from your drawing" }).click()]);
  await chooser.setFiles(DRAWINGS);
  await p.getByText(/rooms read on 2 floors/).first().waitFor({ timeout: 120000 });
}, page);

await check("rules", async (p) => {
  await p.goto(BASE + "/app");
  const box = p.getByRole("textbox").first();
  await box.fill("We have a 10 marla plot in G-11 Islamabad, a CDA sector, 35 by 65 ft, mid-row, facing west. Two storeys, 3 bedrooms.");
  await box.press("Enter");
  await p.getByText(/researched on the web/).first().waitFor({ timeout: 180000 });
}, page);

await check("family", async (p) => {
  // a new family: one message, then their favourites, read with Qloo into a style brief
  await p.goto(BASE + "/app");
  const box = p.getByRole("textbox").first();
  await box.fill("10 marla mid-row plot in DHA Phase 6 Lahore, facing north. Two storeys, four bedrooms, parents downstairs.");
  await box.press("Enter");
  // once the brief has a place, the neighbourhood is read on its own; then straight to Taste
  await p.getByText("DHA Phase 6").first().waitFor({ timeout: 120000 });
  await p.getByText("Your neighbourhood").first().waitFor({ timeout: 120000 });
  await p.getByRole("radio", { name: "Taste" }).first().click();
  const cards = p.locator("section").filter({ has: p.locator('input[aria-label="Who"]') });
  const add = async (card, field, value) => {
    const inp = cards.nth(card).locator(`xpath=.//div[normalize-space()="${field}"]/following-sibling::div[1]//input`).first();
    await inp.fill(value); await inp.press("Enter");
  };
  await add(0, "Places you loved", "Istanbul"); await add(0, "Music", "Abida Parveen"); await add(0, "Films and shows", "Coke Studio");
  await add(1, "Places you loved", "Kyoto"); await add(1, "Films and shows", "Spirited Away");
  await p.getByRole("button", { name: /Read our taste/ }).first().click();
  await p.getByText(/Your favourites/i).first().waitFor({ timeout: 60000 });
  await p.getByText(/What your taste decided/).first().waitFor({ timeout: 300000 });
}, page);

console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(" | ")}` : "no page errors");
await browser.close();
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
