'use strict';
// Builds src/main/ubo-resources.json: uBlock Origin's scriptlet library, taken
// from uBO's source at its latest stable release, in the resource format the
// filtering engine expects.
//
// The source is only *parsed* (with acorn), never executed: we read each
// registerScriptlet(fn, { name, aliases, dependencies, requiresTrust }) call
// and copy the referenced function/class declaration's source text, which is
// exactly what uBO itself injects (it uses fn.toString()).
//
// Redirect resources (tiny placeholder files like noop.js / 1x1.gif) rarely
// change and are taken from Ghostery's packaging of uBO's resources.
//
// Usage: node scripts/build-scriptlets.js [uBO tag]
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const OUT = path.join(__dirname, '..', 'src', 'main', 'ubo-resources.json');
const RAW = 'https://raw.githubusercontent.com/gorhill/uBlock';
const API = 'https://api.github.com/repos/gorhill/uBlock';
const REDIRECTS = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json';

async function get(url, json = false) {
  const res = await fetch(url, { headers: { 'User-Agent': 'coffee-build' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return json ? res.json() : res.text();
}

async function main() {
  const tag = process.argv[2] || (await get(`${API}/releases/latest`, true)).tag_name;
  console.log(`uBlock Origin ${tag}`);
  // Already built from this uBO release: keep the file untouched so the
  // working tree stays clean (the build is deterministic for a given tag).
  try {
    const current = JSON.parse(fs.readFileSync(OUT, 'utf8'));
    if (current.ubo === tag && !process.argv.includes('--force')) {
      console.log(`${path.relative(process.cwd(), OUT)} is already built from ${tag}`);
      return;
    }
  } catch { /* no file yet */ }

  // Fetch src/js/resources/* plus any ../ helpers they import.
  const files = new Map(); // repo path -> source text
  const listing = await get(`${API}/contents/src/js/resources?ref=${encodeURIComponent(tag)}`, true);
  const queue = listing.filter((f) => f.name.endsWith('.js')).map((f) => `src/js/resources/${f.name}`);
  while (queue.length) {
    const p = queue.shift();
    if (files.has(p)) continue;
    const text = await get(`${RAW}/${encodeURIComponent(tag)}/${p}`);
    files.set(p, text);
    for (const m of text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(p), m[1]));
      if (!files.has(dep)) queue.push(dep);
    }
  }

  // Index every file: top-level declarations, import bindings, simple aliases.
  const mods = new Map();
  for (const [p, text] of files) {
    const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
    const decls = new Map();   // local name -> source text
    const imports = new Map(); // local name -> { file, name }
    const aliases = new Map(); // local name -> other local name (const X = Y)
    const registers = [];
    for (let node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const file = path.posix.normalize(path.posix.join(path.posix.dirname(p), node.source.value));
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier') imports.set(s.local.name, { file, name: s.imported.name });
        }
        continue;
      }
      if (node.type === 'ExportNamedDeclaration' && node.declaration) node = node.declaration;
      if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id) {
        decls.set(node.id.name, text.slice(node.start, node.end));
      } else if (node.type === 'VariableDeclaration') {
        for (const d of node.declarations) {
          if (d.id.type === 'Identifier' && d.init && d.init.type === 'Identifier') aliases.set(d.id.name, d.init.name);
        }
      } else if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression') {
        const call = node.expression;
        // registerScriptlet(fn, { name, ... })
        if (call.callee.name === 'registerScriptlet') {
          registers.push({ fnNode: call.arguments[0], details: call.arguments[1] });
        // builtinScriptlets.push({ name, fn, ... }) - the older style in scriptlets.js
        } else if (call.callee.type === 'MemberExpression' && call.callee.object.name === 'builtinScriptlets'
          && call.callee.property.name === 'push') {
          for (const obj of call.arguments) {
            const fnProp = obj.properties.find((pr) => (pr.key.name || pr.key.value) === 'fn');
            registers.push({ fnNode: fnProp.value, details: obj });
          }
        }
      }
    }
    mods.set(p, { decls, imports, aliases, registers });
  }

  // Resolve an identifier in a file to its declaration source.
  function resolve(file, name, depth = 0) {
    const m = mods.get(file);
    if (!m || depth > 10) return null;
    if (m.decls.has(name)) return { file, name, source: m.decls.get(name) };
    if (m.aliases.has(name)) return resolve(file, m.aliases.get(name), depth + 1);
    if (m.imports.has(name)) { const i = m.imports.get(name); return resolve(i.file, i.name, depth + 1); }
    return null;
  }

  const literal = (n) => (n && n.type === 'Literal' ? n.value : undefined);
  const entries = [];
  const nameOf = new Map(); // "file#ident" of the declaration -> registered scriptlet name
  const pending = [];
  for (const [file, m] of mods) {
    for (const { fnNode, details } of m.registers) {
      const target = resolve(file, fnNode.name);
      if (!target) throw new Error(`Cannot resolve ${fnNode.name} in ${file}`);
      const props = Object.fromEntries(details.properties.map((pr) => [pr.key.name || pr.key.value, pr.value]));
      const entry = {
        name: literal(props.name),
        aliases: props.aliases ? props.aliases.elements.map(literal) : [],
        body: target.source,
        dependencies: [],
        requiresTrust: literal(props.requiresTrust) === true,
      };
      // A few scriptlets must run in an isolated world instead of the page's.
      const world = literal(props.world);
      if (world) entry.executionWorld = String(world).toUpperCase();
      nameOf.set(`${target.file}#${target.name}`, entry.name);
      pending.push({ file, entry, deps: props.dependencies ? props.dependencies.elements : [] });
      entries.push(entry);
    }
  }
  for (const { file, entry, deps } of pending) {
    for (const d of deps) {
      if (d.type === 'Literal') { entry.dependencies.push(d.value); continue; }
      const t = resolve(file, d.name);
      const n = t && nameOf.get(`${t.file}#${t.name}`);
      if (!n) throw new Error(`Unknown dependency ${d.name} of ${entry.name}`);
      entry.dependencies.push(n);
    }
  }

  const redirects = JSON.parse(await get(REDIRECTS)).redirects;
  const out = { ubo: tag, built: new Date().toISOString(), scriptlets: entries, redirects };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`Wrote ${path.relative(process.cwd(), OUT)}: ${entries.length} scriptlets, ${redirects.length} redirects`);
}

main().catch((err) => { console.error(err); process.exit(1); });
