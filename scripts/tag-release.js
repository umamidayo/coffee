'use strict';
// Runs before `npm run release` (after the scriptlet refresh). Makes sure:
//  1. the tree is committed and pushed, so the release matches GitHub;
//  2. tag v<version> exists on GitHub at HEAD. GitHub refuses to publish a
//     release without its tag ("Published releases must have a valid tag");
//  3. the GitHub release exists. electron-builder uploads its files in
//     parallel and each upload races to create a missing release, so one
//     fails with "already_exists" and assets go missing. Creating it up front
//     avoids the race.
const { execFileSync } = require('child_process');
const pkg = require('../package.json');
const patchNotes = require('../src/main/patch-notes.js');

const { version } = pkg;
const tag = `v${version}`;
const { owner, repo } = [].concat(pkg.build.publish)[0];

// execFileSync with an argument array: no shell, so cmd.exe can't mangle `^{commit}`.
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(1); };

async function main() {
  // The What's new page shows these; a version without notes would show none.
  if (!patchNotes.some((n) => n.version === version)) fail(`Add patch notes for ${version} to src/main/patch-notes.js (shown on the What's new page).`);
  if (git('status', '--porcelain')) fail('Commit your changes first (including any refreshed src/main/ubo-resources.json): a release must match a pushed commit.');
  git('fetch', 'origin', '--tags', '--quiet');
  const head = git('rev-parse', 'HEAD');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (git('rev-parse', `origin/${branch}`) !== head) fail(`Push ${branch} first (git push), so the release matches what's on GitHub.`);

  let existing = null;
  try { existing = git('rev-parse', '--verify', '--quiet', `${tag}^{commit}`); } catch { /* no such tag */ }
  if (existing && existing !== head) fail(`${tag} already exists on another commit. Bump "version" in package.json for a new release.`);
  if (!existing) {
    git('tag', '-a', tag, '-m', `Coffee ${version}`);
    console.log(`Created tag ${tag}`);
  }
  git('push', 'origin', tag, '--quiet');
  console.log(`Tag ${tag} is on GitHub at ${head.slice(0, 7)}`);

  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) fail('Set GH_TOKEN (a token with Contents: read/write on this repo).');
  const api = (path, init = {}) => fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'coffee-release', ...(init.headers || {}) },
  });
  const found = await api(`/releases/tags/${tag}`);
  if (found.ok) {
    console.log(`Release ${tag} already exists; electron-builder will upload into it.`);
    return;
  }
  if (found.status !== 404) fail(`GitHub API error ${found.status}: ${await found.text()}`);
  const created = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: version, draft: false, prerelease: false }),
  });
  if (!created.ok) fail(`Could not create release ${tag}: ${created.status} ${await created.text()}`);
  console.log(`Created release ${tag}`);
}

main().catch((err) => fail(err.message));
