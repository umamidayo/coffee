'use strict';
// Self-check for the find results scan in main.js. Run: npx electron scripts/test-find.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { app, BrowserWindow } = require('electron');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
const FIND_SCAN = eval('`' + src.match(/const FIND_SCAN = `([\s\S]*?)`;\r?\n/)[1] + '`'); // same string main.js builds

const html = `<body><p>intro apple</p><h2>Fruit <i>list</i></h2><p>app<b>le</b> pie</p>
  <p style="display:none">apple hidden</p><script>var apple</script><p>Some extraordinarily long sentence that goes on wonderfully before the banana</p><h3>Odd</h3><p>a.b(c) apple</p></body>`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false });
  await w.loadURL('data:text/html,' + encodeURIComponent(html));
  const run = (q, goto) => w.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: `${FIND_SCAN}(${JSON.stringify(q)}, ${goto}, 300)` }]);
  try {
    const r = await run('APPLE', -1);
    assert.deepStrictEqual(r.map((x) => x.section), ['', 'Fruit list', 'Odd'], 'sections, hidden + script skipped');
    assert.strictEqual(r[1].hit, 'apple', 'match across <b>');
    assert.strictEqual(r[1].post, ' pie');
    assert.strictEqual((await run('a.b(c)', -1)).length, 1, 'regex chars are literal');
    const long = (await run('banana', -1))[0].pre;
    const words = 'Some extraordinarily long sentence that goes on wonderfully before the'.split(' ');
    assert.ok(long.startsWith('… ') && long.slice(2).trim().split(' ').every((x) => words.includes(x)), 'long lead-in cut at a word: ' + long);
    assert.strictEqual(await run('apple', 2), true);
    assert.strictEqual(await w.webContents.executeJavaScript('getSelection().anchorNode.data'), 'a.b(c) apple', 'goto puts caret at match');
    assert.strictEqual(await run('apple', 9), false);
    await w.webContents.executeJavaScript("document.body.insertAdjacentHTML('beforeend', '<p>late apple</p>')");
    assert.strictEqual((await run('apple', -1)).length, 4, 'index rebuilt after the page changes');
    console.log('find scan: ok');
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
  app.quit();
});
