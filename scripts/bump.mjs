#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// bump.mjs — cache-bust every changed file in one go.
//
//   node scripts/bump.mjs            bump files changed vs origin/main (+ uncommitted)
//   node scripts/bump.mjs app.js     bump just these files
//   node scripts/bump.mjs --check    don't write; exit 1 if a changed file kept its old ?v=
//
// What it does, so nobody has to remember:
//   1. every "<file>?v=XXX" in every .html, for each changed file -> new stamp
//   2. sw.js CACHE name -> new stamp (forces the screens to drop the old cache)
//   3. APP_VERSION in app.js -> new stamp (Kitchen)
//   4. lazy-load build constants that ride outside index.html (FM_BUILD, ML_HELPER_BUILD)
// Stamp style follows the repo: unix seconds where tags are numbers (Kitchen),
// YYYYMMDDhhmm Dubai time where tags are dates (FOH).
// ──────────────────────────────────────────────────────────────────────────
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
process.chdir(ROOT);
const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const explicit = args.filter(a => !a.startsWith('--'));

const sh = c => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };

// ---- which files changed -------------------------------------------------
let changed = explicit;
if (!changed.length) {
  sh('git fetch origin --quiet');
  const committed = sh('git diff --name-only origin/main...HEAD').split('\n');
  const working = sh('git status --porcelain').split('\n').map(l => l.slice(3).trim());
  changed = [...new Set([...committed, ...working])].filter(Boolean);
}
// Only things a page loads. SQL, docs, tests and tooling never need a bump.
const ASSET = /\.(js|css|json|html|png|jpe?g|svg|webp|exe|pdf|xlsx)$/i;
const IGNORE = /^(tests?\/|scripts\/|\.claude\/|\.github\/|supabase\/|node_modules\/)|(^|\/)(package(-lock)?\.json|tests\.js)$/;
changed = changed.filter(f => ASSET.test(f) && !IGNORE.test(f) && f !== 'sw.js');

// ---- all html pages ------------------------------------------------------
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n.startsWith('.') || n === 'node_modules' || n === 'supabase') continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.html$/i.test(n)) out.push(relative(ROOT, p));
  }
  return out;
}
const pages = walk(ROOT);

// ---- stamp style ---------------------------------------------------------
const sample = pages.map(p => readFileSync(p, 'utf8').match(/\?v=([A-Za-z0-9_-]+)/)).find(Boolean);
const numeric = sample && /^\d{9,}$/.test(sample[1]);
const now = new Date();
const dubai = new Date(now.getTime() + 4 * 3600e3).toISOString().replace(/\D/g, '').slice(0, 12); // YYYYMMDDhhmm
const STAMP = numeric ? String(Math.floor(now.getTime() / 1000)) : dubai;

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
let stale = [], edits = 0;

// 1. sw.js, APP_VERSION, lazy constants — first, so files edited here get their ?v= bumped too
function patch(file, re, repl, label) {
  if (!existsSync(file)) return;
  const s = readFileSync(file, 'utf8'), t = s.replace(re, repl);
  if (t !== s) { writeFileSync(file, t); edits++; console.log(`  ✓ ${label}`); if (file !== 'sw.js' && !changed.includes(file)) changed.push(file); }
}
if (!CHECK && changed.length) {
  patch('sw.js', /const CACHE = '([^']*?)(-v?\d{9,})?'/, (m, name) =>
    numeric ? `const CACHE = '${name.replace(/-v\d+$/, '')}-v${STAMP}'` : `const CACHE = '${name}-${STAMP}'`, 'sw.js CACHE');
  if (numeric) patch('app.js', /const APP_VERSION = \d+;/, `const APP_VERSION = ${STAMP};`, 'app.js APP_VERSION');
  if (changed.includes('article-catalogue.js'))
    patch('fmc-match.js', /var FM_BUILD = '[^']*'/, `var FM_BUILD = '${STAMP}'`, 'fmc-match.js FM_BUILD');
  if (changed.some(f => f.startsWith('downloads/')))
    patch('market-list.js', /var ML_HELPER_BUILD = '[^']*'/, `var ML_HELPER_BUILD = '${STAMP}'`, 'market-list.js ML_HELPER_BUILD');
}


// 2. ?v= in every page
for (const page of pages) {
  let html = readFileSync(page, 'utf8'), before = html;
  for (const f of changed) {
    const base = f.split('/').pop();
    // match "f?v=", "./f?v=", "dir/f?v=" — the file name with any leading path
    const re = new RegExp(`((?:^|[\"'(/\\s=])(?:\\./)?(?:[A-Za-z0-9_./-]*/)?${esc(base)}\\?v=)([A-Za-z0-9_-]+)`, 'g');
    html = html.replace(re, (m, pre, old) => {
      if (CHECK) { const head = sh(`git show origin/main:${page}`); if (head.includes(`${base}?v=${old}`)) stale.push(`${page} → ${base}?v=${old}`); return m; }
      return pre + STAMP;
    });
  }
  if (!CHECK && html !== before) { writeFileSync(page, html); edits++; console.log(`  ✓ ${page}`); }
}

if (CHECK) {
  if (stale.length) { console.error('❌ Changed but still on the old ?v= (screens will keep the stale file):\n  ' + stale.join('\n  ') + '\n  Fix: node scripts/bump.mjs'); process.exit(1); }
  console.log('✅ cache-bust OK'); process.exit(0);
}
console.log(changed.length ? `Stamp ${STAMP} · ${changed.length} changed file(s) · ${edits} file(s) updated` : 'Nothing to bump.');
