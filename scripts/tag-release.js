'use strict';
// Runs before `npm run release`. GitHub refuses to publish a release whose tag
// doesn't exist yet ("Published releases must have a valid tag"), so make sure
// v<version> exists on GitHub and points at the commit being released.
const { execSync } = require('child_process');
const { version } = require('../package.json');

const git = (cmd) => execSync(`git ${cmd}`, { encoding: 'utf8' }).trim();
const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };
const tag = `v${version}`;

if (git('status --porcelain')) fail('Commit your changes first: a release must match a pushed commit.');
git('fetch origin --tags --quiet');
const head = git('rev-parse HEAD');
const branch = git('rev-parse --abbrev-ref HEAD');
if (git(`rev-parse origin/${branch}`) !== head) fail(`Push ${branch} first (git push), so the release matches what's on GitHub.`);

let existing = null;
try { existing = git(`rev-parse ${tag}^{commit}`); } catch { /* no such tag */ }

if (existing && existing !== head) {
  fail(`${tag} already exists on another commit. Bump "version" in package.json for a new release.`);
} else if (!existing) {
  git(`tag -a ${tag} -m "Coffee ${version}"`);
  console.log(`Created tag ${tag}`);
}
git(`push origin ${tag} --quiet`);
console.log(`Tag ${tag} is on GitHub at ${head.slice(0, 7)}`);
