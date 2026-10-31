// End-to-end checks of the deployed app as a guest, with Playwright (Chromium). Each check prints PASS/FAIL and leaves a
// screenshot in e2e/out/. Usage: node smoke.mjs [base_url] [check ...]
// checks: landing sample taste match photos drawing rules family link judges phone
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.argv[2] || "https://naqsha-qloo-242926648187.us-central1.run.app";
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

// What a judge does: open a family from the landing page, watch the reveal, follow it to the house. Words must stay local.
const FAMILIES = [["The Maliks", "Lahore"], ["The Garcias", "Austin"], ["The Al Mansouris", "Dubai"], ["The Parks", "Toronto"]];

async function clean(p, city) {
  const t = await p.locator("body").innerText();
  if (/qloo/i.test(t)) throw new Error(`${city}: the app names Qloo`);
  const m = city !== "Lahore" && t.match(/.{0,50}\b(marla|kanal|LDA|DHA|Bahria|mumty)\b.{0,50}/i);
  if (m) throw new Error(`${city} on ${new URL(p.url()).pathname.split("/").pop()}: Lahore words: ${m[0]}`);
}

async function imagesLoaded(p, min) {
  await p.waitForFunction((n) => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length >= n, min, { timeout: 45000 });
}

async function walk(p, family, city) {
  await p.goto(BASE + "/");
  await p.getByRole("heading", { name: "Four sample families, four homes." }).waitFor({ timeout: 20000 });
  const card = p.getByRole("button", { name: new RegExp(`${family}, ${city}`) }).last();  // the card in the list, not the hero's line
  await card.waitFor({ timeout: 20000 });
  await p.waitForFunction((n) => [...document.querySelectorAll("button")].some((b) => b.textContent.includes(n) && !b.disabled), `${family}, ${city}`, { timeout: 20000 });
  await card.click();
  await p.waitForURL(/\/taste/, { timeout: 60000 });
  await p.getByText(/answered alone\./).waitFor({ timeout: 20000 });
  const inside = p.getByRole("button", { name: "Look inside" });
  await inside.waitFor({ timeout: 30000 });
  if (!(await p.locator("section img").count())) throw new Error(`${city}: no favourite behind the word`);
  await clean(p, city);
  await inside.click();
  await p.getByRole("heading", { name: /Everything opens onto/ }).waitFor({ timeout: 10000 });
  await p.getByText(/How much of you is in it/).first().waitFor({ timeout: 10000 });
  await clean(p, city);
  await p.getByRole("button", { name: /See the home/ }).first().click();
  await p.waitForURL(/\/concepts/, { timeout: 20000 });
  await imagesLoaded(p, 3);
  await clean(p, city);
  await p.getByRole("radio", { name: "Plan" }).first().click();
  await p.waitForURL(/\/plan/, { timeout: 20000 });
  await p.waitForTimeout(2500);
  await clean(p, city);
  await p.getByRole("radio", { name: "Brief" }).first().click();
  await p.waitForURL(/\/brief/, { timeout: 20000 });
  await p.waitForTimeout(2000);
  await clean(p, city);
  await p.getByRole("radio", { name: "House" }).first().click();
  await p.waitForURL(/\/house/, { timeout: 20000 });
  await p.waitForTimeout(4000);
  await p.waitForFunction(() => !/Assembling your home|Opening the house/.test(document.body.innerText), null, { timeout: 240000 });
  await p.waitForTimeout(3000);
  const broken = await p.getByText(/didn't build/).count();
  if (broken) throw new Error(`${city}: ${broken} parts of the house didn't build`);
  const bare = await p.getByText(/Matches the concept: (\d+)%/).first().textContent().catch(() => "");
  if (Number(bare.match(/(\d+)%/)?.[1] ?? 100) < 50) throw new Error(`${city}: ${bare}`);
  await clean(p, city);
}

for (const [family, city] of FAMILIES) {
  await check("judges", async (p) => {
    const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const q = await c.newPage();
    const bad = [];
    q.on("pageerror", (e) => bad.push(e.message));
    try {
      await walk(q, family, city);
      await q.screenshot({ path: `${OUT}judges-${city}.png` });
      if (bad.length) throw new Error(`${city}: ${bad[0]}`);
    } finally { await c.close(); }
  }, page);
}

await check("phone", async () => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const q = await c.newPage();
  try {
    await q.goto(BASE + "/");
    await q.getByRole("button", { name: /The Garcias, Austin/ }).last().scrollIntoViewIfNeeded({ timeout: 20000 });
    await q.getByRole("button", { name: /The Garcias, Austin/ }).last().click();
    await q.waitForURL(/\/taste/, { timeout: 60000 });
    await q.getByRole("button", { name: "Look inside" }).waitFor({ timeout: 30000 });
    const over = await q.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) throw new Error(`the page scrolls sideways by ${over}px`);
    await q.screenshot({ path: `${OUT}phone.png` });
  } finally { await c.close(); }
}, page);

await check("landing", async (p) => {
  await p.goto(BASE + "/");
  await p.getByRole("heading", { level: 1, name: /Home is where the heart is/ }).waitFor();
  await p.getByRole("button", { name: "Start your home" }).first().waitFor({ timeout: 10000 });
  await p.getByText("Four sample families, four homes").waitFor({ timeout: 10000 });
  if (await p.getByText(/Qloo/).count()) throw new Error("the app names Qloo");
}, page);

await check("sample", async (p) => {
  await p.goto(BASE + "/");
  await p.getByRole("button", { name: /See a family's home/ }).click();
  await p.waitForURL(/\/taste/, { timeout: 60000 });
  await p.getByRole("button", { name: "Look inside" }).click({ timeout: 60000 });
  await p.getByRole("radio", { name: "House" }).first().click();
  await p.waitForURL(/\/house/, { timeout: 30000 });
  await p.getByText(/LDA|CDA|local rules/).first().waitFor({ timeout: 60000 });
  await p.waitForFunction(() => !document.body.innerText.includes("Assembling your home"), null, { timeout: 180000 });
}, page);

await check("taste", async (p) => {
  await p.getByRole("radio", { name: "Heart" }).or(p.getByRole("tab", { name: "Heart" })).first().click();
  await p.getByRole("heading", { name: /Everything opens onto/ }).waitFor({ timeout: 30000 });
  await p.getByText(/Inside: a room for each of you/).first().waitFor({ timeout: 30000 });
  await p.getByText(/How much of you is in it/).first().waitFor({ timeout: 30000 });
  if (await p.getByText(/Qloo/).count()) throw new Error("the app names Qloo");
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
  // a new family: one message; who's home; each answers from real things; the heart is revealed; a private link works
  await p.goto(BASE + "/app");
  const box = p.getByRole("textbox").first();
  await box.fill("A family of three in Leslieville, Toronto. Two storeys, a home office.");
  await box.press("Enter");
  await p.getByText("Leslieville").first().waitFor({ timeout: 120000 });
  await p.getByRole("radio", { name: "Heart" }).first().click();
  await p.getByRole("heading", { name: "Who's home?" }).waitFor({ timeout: 30000 });
  await p.getByLabel("Person 1").fill("Maya");
  await p.getByLabel("Person 2").fill("Dev");
  await p.getByRole("button", { name: "Light the house" }).click();
  await p.getByRole("heading", { name: /Send everyone their light/ }).waitFor({ timeout: 30000 });
  const answer = async (row, things) => {
    await p.getByRole("button", { name: "Answer here" }).first().click();
    await p.getByRole("heading", { name: new RegExp(`${row}, what do you love`) }).waitFor({ timeout: 10000 });
    const field = p.getByRole("combobox").first();
    for (const t of things) {
      await field.fill(t);
      await p.getByRole("option").first().waitFor({ timeout: 15000 });
      await field.press("Enter");
    }
    await p.getByRole("button", { name: "Turn my light on" }).click();
  };
  await answer("Maya", ["Abida Parveen", "Istanbul", "Spirited Away"]);
  await p.getByText(/1 of 2 lights on/).waitFor({ timeout: 15000 });
  await answer("Dev", ["Coldplay", "Kyoto", "Parasite"]);
  await p.getByRole("heading", { name: /Everyone's home/ }).waitFor({ timeout: 15000 });
  await p.getByRole("button", { name: "See what you share" }).click();
  await p.getByRole("button", { name: "Look inside" }).click({ timeout: 90000 });
  await p.getByRole("heading", { name: /Everything opens onto/ }).waitFor({ timeout: 15000 });
  await p.getByRole("button", { name: /Build our home around it/ }).last().click({ timeout: 15000 });
  await p.waitForURL(/\/concepts/, { timeout: 300000 });
  await p.waitForFunction(() => [...document.images].some((i) => i.complete && i.naturalWidth > 300), null, { timeout: 300000 });
}, page);

await check("link", async (p) => {
  // the private link opens without any account and sees only its own name
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const q = await fresh.newPage();
  const pid = p.url().split("/p/")[1].split("/")[0];
  const fam = await p.evaluate(async (id) => (await (await fetch(`/api/projects/${id}`, { headers: { "X-Naqsha-User": Object.values(localStorage).find((v) => /^[0-9a-f-]{36}$/.test(v)) || "" } })).json()).family, pid);
  await q.goto(`${BASE}/h/${fam.people[0].token}`);
  await q.getByRole("heading", { name: /light's on/i }).waitFor({ timeout: 30000 });
  await fresh.close();
}, page);

console.log(errors.length ? `page errors: ${errors.slice(0, 5).join(" | ")}` : "no page errors");
await browser.close();
process.exit(results.some((r) => r[1] === "FAIL") ? 1 : 0);
