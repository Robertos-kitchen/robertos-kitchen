#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// Smoke test — opens the app in a real browser and taps every module.
//
//   npm run smoke                 test the DEV site (URL in package.json)
//   npm run smoke -- <url>        test any URL (LIVE after a deploy, or localhost)
//
// READ-ONLY BY DESIGN: every write (POST/PATCH/PUT/DELETE) to Supabase or any
// other outside host is blocked before it leaves the browser, so this can run
// against DEV or LIVE without touching real data. It only taps navigation
// tiles, never Send / Save / Delete buttons.
//
// FAILS when: a JS error is thrown, or the app asks for a file of its own that
// 404s (the 7 Aug outage: index.html loading a file that was never pushed).
// Screenshots of every module land in test-results/.
// ──────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const URL_ = process.argv[2] || process.env.SMOKE_URL || pkg.config.devUrl;
const origin = new URL(URL_).origin;
// Tiles that open a module. Panels (toggleHomePanel) are expanded first.
const NAV = /^\s*(open[A-Z]\w*|fohTab|openChecklists|fohBibleOpen)\(/;
const SKIP = /openHome\(/;
mkdirSync('test-results', { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(() => { window.print = () => {}; window.confirm = () => false; window.prompt = () => null; });
let blocked = 0;
await ctx.route('**/*', r => {
  const req = r.request(), m = req.method();
  const outside = !req.url().startsWith(origin);
  if (outside && !["GET", "HEAD", "OPTIONS"].includes(m)) { blocked++; if (process.env.SMOKE_DEBUG) console.log("blocked", m, req.url().slice(0, 140)); return r.abort(); }
  // Read-only RPCs to Supabase are fine; anything else with a body is blocked above.
  return r.continue();
});

const failures = [];
function watch(page, where) {
  page.__inflight = 0;
  page.on('request', () => page.__inflight++);
  page.on('requestfinished', () => page.__inflight--);
  page.on('requestfailed', () => page.__inflight--);
  page.on('pageerror', e => failures.push(`${where}: JS error — ${String(e.message).split('\n')[0]}`));
  page.on('response', res => {
    if (res.status() === 404 && res.url().startsWith(origin)) failures.push(`${where}: missing file — ${res.url().replace(origin, '')}`);
  });
}

// Wait until the screen is done: no requests in flight and the text has stopped
// changing for ~1.5s (modules fetch their data after the tap). Minimum 2s.
async function settle(p, max = 15000) {
  const t0 = Date.now(); let last = -1, still = 0;
  await p.waitForTimeout(2000);
  while (Date.now() - t0 < max) {
    const n = await p.evaluate(() => document.body.innerText.length).catch(() => 0);
    still = (n === last && !(p.__inflight > 0)) ? still + 1 : 0; last = n;
    if (still >= 3) break;
    await p.waitForTimeout(500);
  }
}

async function home(where) {
  const page = await ctx.newPage();
  page.on('dialog', d => d.dismiss().catch(() => {}));
  if (where) watch(page, where);
  for (let tries = 0; ; tries++) {               // one retry: a service worker can abort the first load
    try { await page.goto(URL_, { waitUntil: 'networkidle', timeout: 60000 }); break; }
    catch (e) { if (tries) throw e; await page.waitForTimeout(1500); }
  }
  // The app may reload itself once (new service worker / new build). Wait until the
  // home screen has the same set of tiles twice in a row before touching it.
  let last = -1;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    const n = await page.evaluate(() => document.querySelectorAll('[onclick]').length).catch(() => -2);
    if (n > 0 && n === last) break; last = n;
  }
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll('[onclick^="toggleHomePanel"]').forEach(e => e.click()));
  await page.waitForTimeout(400);
  return page;
}

// 1. Home loads
let page = await home('Home');
await page.screenshot({ path: 'test-results/00-home.png', fullPage: true });
const tiles = await page.$$eval('[onclick]', (els, src) => {
  const re = new RegExp(src[0]), skip = new RegExp(src[1]);
  return [...new Set(els.filter(e => e.offsetParent && re.test(e.getAttribute('onclick')) && !skip.test(e.getAttribute('onclick')))
    .map(e => e.getAttribute('onclick')))];
}, [NAV.source, SKIP.source]);
const links = await page.$$eval('a[href]', (as, o) => [...new Set(as.map(a => a.href)
  .filter(h => h.startsWith(o) && /\.html(\?|#|$)/.test(h)))], origin);
await page.close();

// 2. Every module tile
const results = [];
for (const [i, onclick] of tiles.entries()) {
  const before = failures.length;
  const p = await home(onclick.replace(/\(.*$/, ''));
  try {
    await p.locator(`[onclick="${onclick.replace(/"/g, '\\"')}"]`).first().click({ timeout: 5000 });
    await settle(p);
    // Blank screen = the module opened but drew nothing (the classic silent failure).
    // Count visible text in the page AND any frames (some modules open in an iframe).
    let shown = 0;
    for (const f of p.frames()) shown += await f.evaluate(() => {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n = 0, t;
      const top = window === window.top ? 70 : 0;
      while ((t = w.nextNode())) {
        const el = t.parentElement, r = el && el.getBoundingClientRect();
        if (r && r.width && r.top > top && r.top < innerHeight - 60 && getComputedStyle(el).visibility !== 'hidden') n += t.textContent.trim().length;
      }
      return n;
    }).catch(() => 0);
    if (shown < 15) failures.push(`${onclick}: screen is blank after opening`);
    await p.screenshot({ path: `test-results/${String(i + 1).padStart(2, '0')}-${onclick.replace(/\W+/g, '_').slice(0, 40)}.png` });
  } catch (e) { failures.push(`${onclick}: could not open — ${e.message.split('\n')[0]}`); }
  results.push([onclick.replace(/;.*$/, ''), failures.length === before ? 'ok' : 'FAIL']);
  await p.close();
}

// 3. Every standalone page the home screen links to
for (const href of links) {
  const before = failures.length;
  const p = await ctx.newPage(); p.on('dialog', d => d.dismiss().catch(() => {}));
  const where = href.replace(origin, '');
  watch(p, where);
  await p.goto(href, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => failures.push(`${where}: did not load — ${e.message}`));
  await p.waitForTimeout(800);
  results.push([where, failures.length === before ? 'ok' : 'FAIL']);
  await p.close();
}

await browser.close();
console.log(`\nSmoke test — ${URL_}\n`);
for (const [n, s] of results) console.log(`  ${s === 'ok' ? '✓' : '✗'} ${n}`);
console.log(`\n  ${results.length} checked · ${blocked} outside writes blocked (read-only run) · screenshots in test-results/`);
if (failures.length) { console.error('\n❌ FAILED:\n  ' + [...new Set(failures)].join('\n  ')); process.exit(1); }
console.log('✅ PASSED');
