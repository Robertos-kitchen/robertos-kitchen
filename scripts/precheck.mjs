#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// precheck.mjs — the gate before anything is pushed.
//
// Runs automatically (Claude Code hook, .claude/settings.json) before any
// `git push` or deploy script. Also safe to run by hand:  node scripts/precheck.mjs
//
// Blocks the push (exit 2) if:
//   1. any changed .js file has a syntax error            (node --check)
//   2. the unit tests fail                                 (node tests.js)
//   3. a changed file kept its old ?v= cache-bust tag      (bump.mjs --check)
// Claude sees the reason and fixes it before trying again.
// ──────────────────────────────────────────────────────────────────────────
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// When called as a hook, stdin holds the tool call. Only gate pushes/deploys.
let cmd = '';
try { if (!process.stdin.isTTY) cmd = JSON.parse(readFileSync(0, 'utf8') || '{}')?.tool_input?.command || ''; } catch {}
if (cmd && !/\bgit\s+push\b|deploy-[a-z]+\.sh(?!\s+--check)/.test(cmd)) process.exit(0);

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
process.chdir(ROOT);
const sh = c => { try { return execSync(c, { stdio: ['ignore', 'pipe', 'ignore'] }).toString(); } catch { return ''; } };
const problems = [];

sh('git fetch origin --quiet');
const changed = [...new Set([
  ...sh('git diff --name-only origin/main...HEAD').split('\n'),
  ...sh('git status --porcelain').split('\n').map(l => l.slice(3).trim()),
])].filter(f => f && existsSync(f));

// 1. syntax
for (const f of changed.filter(f => /\.(m?js)$/.test(f))) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`Syntax error in ${f}:\n${(r.stderr || '').trim().split('\n').slice(0, 6).join('\n')}`);
}
// 2. unit tests
if (existsSync('tests.js')) {
  const r = spawnSync(process.execPath, ['tests.js'], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`tests.js failed:\n${(r.stdout + r.stderr).trim().split('\n').slice(-12).join('\n')}`);
}
// 3. cache-bust
const b = spawnSync(process.execPath, ['scripts/bump.mjs', '--check'], { encoding: 'utf8' });
if (b.status !== 0) problems.push((b.stderr || b.stdout).trim());

if (problems.length) {
  console.error('PUSH BLOCKED by precheck:\n\n' + problems.join('\n\n'));
  process.exit(cmd ? 2 : 1);
}
console.log('✅ precheck passed: syntax, tests, cache-bust');
