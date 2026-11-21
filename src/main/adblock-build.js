'use strict';
// Builds the ad-block engine in a short-lived utility process (see
// refresh() in adblock.js): downloads uBlock Origin's lists, resolves their
// `!#include` / `!#if` directives, compiles them, adds uBO's scriptlet
// library and writes the compact, serialized engine to disk.
//
// Compiling holds the lists as text and every filter as an object, well over
// 100 MB at its peak. Doing it here keeps all of that out of the browser's
// main process, which only ever loads the compact result (about 8 MB on disk),
// and the memory goes back to the system as soon as this process exits.
//
// Run as: utilityProcess.fork(this file, [outFile, resourcesFile])
const fs = require('fs');
const path = require('path');
const { FiltersEngine } = require('@ghostery/adblocker');

// Mirrors are tried in order, like uBO's cdnURLs.
const UBO = ['https://ublockorigin.github.io/uAssets/', 'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@latest/', 'https://ublockorigin.pages.dev/'];
const LISTS = [
  ...['filters/filters.txt', 'filters/quick-fixes.txt', 'filters/badware.txt', 'filters/privacy.txt',
    'filters/unbreak.txt', 'filters/resource-abuse.txt', 'thirdparties/easylist.txt', 'thirdparties/easyprivacy.txt']
    .map((p) => UBO.map((base) => base + p)),
  ['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/peter-lowe/serverlist.txt'],
];

// The environment uBO's `!#if` blocks are evaluated against.
const ENV = { env_chromium: true, cap_user_stylesheet: true, ext_ublock: true, ext_ubol: false, env_mv3: false,
  env_firefox: false, env_edge: false, env_safari: false, env_mobile: false, env_legacy: false, cap_html_filtering: false,
  adguard: false, adguard_app_windows: false, adguard_ext_chromium: false, false: false, true: true };

const CONFIG = { loadCosmeticFilters: true, loadNetworkFilters: true, loadGenericCosmeticsFilters: true,
  enableMutationObserver: true, loadCSPFilters: true, enableHtmlFiltering: false, loadExtendedSelectors: false,
  guessRequestTypeFromUrl: true };

async function fetchText(urls) {
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return { text: await res.text(), url };
    } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

/** Evaluate a uBO `!#if` expression: identifiers, !, &&, ||, parentheses. */
function evalCondition(expr) {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[\w-]+/g) || [];
  let i = 0;
  const primary = () => {
    const t = tokens[i++];
    if (t === '!') return !primary();
    if (t === '(') { const v = or(); i++; return v; }
    return !!ENV[t];
  };
  const and = () => { let v = primary(); while (tokens[i] === '&&') { i++; v = primary() && v; } return v; };
  const or = () => { let v = and(); while (tokens[i] === '||') { i++; v = and() || v; } return v; };
  return or();
}

/** Resolve `!#include` (fetched relative to the list) and drop inactive `!#if` blocks. */
async function preprocess(text, baseUrl, depth = 0) {
  const out = [];
  const stack = []; // each entry: is the current block active?
  const active = () => stack.every(Boolean);
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('!#if ')) { stack.push(evalCondition(line.slice(5))); continue; }
    if (line.startsWith('!#else')) { if (stack.length) stack.push(!stack.pop()); continue; }
    if (line.startsWith('!#endif')) { stack.pop(); continue; }
    if (!active()) continue;
    if (line.startsWith('!#include ') && depth < 3) {
      const rel = line.slice(10).trim();
      const url = new URL(rel, baseUrl);
      // Only follow includes on the same origin as the list (uBO's rule).
      if (url.origin !== new URL(baseUrl).origin) continue;
      try {
        const sub = await fetchText([url.href]);
        out.push(await preprocess(sub.text, sub.url, depth + 1));
      } catch { /* skip a missing sub-list */ }
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

async function main() {
  const [outFile, resourcesFile] = process.argv.slice(2);
  const results = await Promise.allSettled(LISTS.map(async (mirrors) => {
    const { text, url } = await fetchText(mirrors);
    return preprocess(text, url);
  }));
  const lists = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (lists.length < LISTS.length / 2) throw new Error('Too many filter lists failed to download');
  const engine = FiltersEngine.parse(lists.join('\n'), CONFIG);
  const text = fs.readFileSync(resourcesFile, 'utf8');
  const { ubo, built } = JSON.parse(text);
  engine.updateResources(text, `ubo-${ubo}-${built}`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp`;
  fs.writeFileSync(tmp, engine.serialize());
  fs.renameSync(tmp, outFile);
}

main().then(
  () => { process.parentPort.postMessage({ ok: true }); process.exit(0); },
  (err) => { process.parentPort.postMessage({ ok: false, error: String((err && err.message) || err) }); process.exit(1); },
);
