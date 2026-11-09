/* Real MV3 extension + real PLaMo model. First run downloads ~1.81 GB. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.E2E_OUTPUT || join(root, 'test-results'));
const profile = resolve(process.env.E2E_PROFILE || join(root, '.e2e-profile'));
await mkdir(output, { recursive: true });
const demo = await readFile(join(root, 'tests/fixtures/demo.html'), 'utf8');
const wrap = body => `<!doctype html><html lang="en"><meta charset="UTF-8"><title>Translation test</title><style>body{font:18px/1.7 system-ui;max-width:850px;margin:40px auto}input,textarea{display:block;margin:10px}</style><body>${body}</body></html>`;
const fixtures = {
  '/article': demo,
  '/long': wrap(`<h1>Our research</h1><p id="long">${'This website provides information about our research. '.repeat(30)}</p>`),
  '/forms': wrap('<h1>Contact us</h1><input id="search" placeholder="Search documents" title="Search this website" aria-label="Search"><textarea id="draft" placeholder="Write a message">Keep my draft in English.</textarea><input type="password" value="Secret text" title="Private password"><div contenteditable="true">Do not change my draft.</div><p hidden>Keep hidden text.</p><p translate="no">Keep original text.</p><p class="notranslate">Keep this unchanged.</p><img alt="A beautiful garden" width="100" height="80"><button id="button">Send message</button><span id="result"></span><script>button.onclick=()=>result.textContent="Your message has been sent."</script>'),
  '/multilingual': wrap('<h1>Welcome to our website.</h1><p>Bonjour, je suis heureux de vous rencontrer.</p><p>Guten Morgen. Wie geht es Ihnen?</p><p>Esta página contiene información sobre nuestra investigación.</p><p id="japanese">これは元から日本語の文章です。</p>'),
  '/dynamic': wrap('<h1>Latest news</h1><p id="changing">The weather is nice today.</p><div id="feed"></div>'),
  '/cancel': wrap('<h1>Welcome to our website.</h1><p>The weather is nice today.</p>'),
};
const server = createServer((req, res) => {
  res.writeHead(fixtures[req.url] ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(fixtures[req.url] || 'Not found');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const extension = join(root, 'dist');
const report = { browser: null, mode: process.env.E2E_MODE || 'gpu', cases: [], errors: [] };
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.E2E_HEADED !== '1',
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  report.browser = context.browser().version();
  context.on('weberror', error => report.errors.push(error.error().message));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const harness = await context.newPage();
  const send = (type, extra = {}) => harness.evaluate(msg => chrome.runtime.sendMessage(msg), { type, ...extra });
  const pageSend = (tabId, type) => harness.evaluate(({ tabId, type }) => chrome.tabs.sendMessage(tabId, { type }), { tabId, type });
  await harness.goto(`chrome-extension://${id}/popup.html`);
  report.gpu = await harness.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter();
    const info = adapter?.info;
    return info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : null;
  });
  // Clear translations (not the 1.81 GB model) so this run exercises inference.
  await worker.evaluate(async () => { await cacheReady; cache.clear(); await chrome.storage.local.remove('plamoPageTranslateCacheV2'); });
  async function until(fn, timeout = 120000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Timed out after ${timeout} ms`);
  }
  console.log('Preparing real model:', report.mode, report.browser);
  assert.equal((await send('ENGINE_PREPARE', { mode: report.mode })).ok, true);
  let previous;
  report.engine = await until(async () => {
    const state = await send('ENGINE_STATUS');
    if (state.phase === 'error') throw new Error(JSON.stringify(state));
    if (state.message !== previous) { console.log(state.message); previous = state.message; }
    return state.phase === 'ready' && state;
  }, 1800000);
  assert.match(report.engine.smokeTranslation, /[ぁ-ゟ゠-ヿ一-龯]/u);
  const browserCDP = await context.browser().newBrowserCDPSession();
  async function open(url) {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    const { targetInfos } = await browserCDP.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const target = targetInfos.find(t => t.url === page.url());
    assert.ok(target, 'Browser tab target found');
    await browserCDP.send('Extensions.triggerAction', { id, targetId: target.targetId });
    const tabId = await harness.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
    assert.ok(tabId, 'Target tab found');
    await until(async () => {
      try { return (await pageSend(tabId, 'PAGE_STATUS'))?.ok; } catch { return false; }
    }, 10000);
    return { page, tabId };
  }
  const snapshot = page => page.evaluate(() => {
    const body = document.body.cloneNode(true);
    // Chromium autofill can create an empty style attribute on form controls.
    for (const element of body.querySelectorAll('[style=""]')) element.removeAttribute('style');
    return { title: document.title, body: body.innerHTML };
  });
  async function translated(tabId) {
    let lastProgress = Date.now();
    return until(async () => {
      const { status } = await pageSend(tabId, 'PAGE_STATUS');
      if (Date.now() - lastProgress > 15000) { console.log('Translation progress', status); lastProgress = Date.now(); }
      if (status.phase === 'error') throw new Error(JSON.stringify(status));
      if (status.phase !== 'translated') return false;
      assert.equal(status.failed, 0, JSON.stringify(status));
      return status;
    }, 600000);
  }
  const paths = Object.keys(fixtures).filter(p => !process.env.E2E_CASES || process.env.E2E_CASES.split(',').includes(p.slice(1)));
  const urls = process.env.E2E_LIVE === '1' ? [
    'https://example.com/',
    'https://info.cern.ch/hypertext/WWW/TheProject.html',
    'https://www.iana.org/help/example-domains',
    'https://developer.mozilla.org/en-US/docs/Glossary/HTML',
  ] : [];
  for (const [index, url] of [...paths.map(p => base + p), ...urls].entries()) {
    console.log('Testing', url);
    const { page, tabId } = await open(url);
    const before = await snapshot(page);
    const content = page.locator('main').first();
    const contentSelector = await content.count() ? 'main' : 'body';
    const originalContent = await page.locator(contentSelector).first().textContent();
    const start = Date.now();
    if (url.endsWith('/article')) {
      // Exercise the actual popup controls in addition to message routing.
      await harness.reload();
      await harness.locator('#translate').click();
    } else await pageSend(tabId, 'PAGE_TRANSLATE');
    if (url.endsWith('/cancel')) {
      await pageSend(tabId, 'PAGE_RESTORE');
      await new Promise(r => setTimeout(r, 1500));
      assert.deepEqual(await snapshot(page), before, 'Late responses cannot overwrite restored text');
    } else {
      const status = await translated(tabId);
      assert.ok(status.completed > 0, 'Actually translated page content');
      assert.match(await page.locator('body').innerText(), /[ぁ-ゟ゠-ヿ一-龯]/u);
      if (url.endsWith('/article')) {
        assert.equal(await page.locator('pre').innerText(), 'const message = "This code must not be translated.";');
        await page.locator('#dynamic').click();
        await until(async () => /[ぁ-ゟ゠-ヿ一-龯]/u.test(await page.locator('#more').innerText()));
        await translated(tabId);
        await page.locator('#more').evaluate(el => el.replaceChildren());
      }
      if (url.endsWith('/long')) assert.ok((await page.locator('#long').innerText()).length > 100, 'Long text was not lost');
      if (url.endsWith('/forms')) {
        assert.equal(await page.locator('#draft').inputValue(), 'Keep my draft in English.');
        assert.equal(await page.locator('[contenteditable]').innerText(), 'Do not change my draft.');
        assert.equal(await page.locator('[hidden]').textContent(), 'Keep hidden text.');
        assert.equal(await page.locator('[translate="no"]').textContent(), 'Keep original text.');
        assert.equal(await page.locator('.notranslate').textContent(), 'Keep this unchanged.');
        assert.equal(await page.locator('[type="password"]').getAttribute('title'), 'Private password');
        for (const attr of ['placeholder', 'title', 'aria-label']) assert.match(await page.locator('#search').getAttribute(attr), /[ぁ-ゟ゠-ヿ一-龯]/u);
        assert.match(await page.locator('#draft').getAttribute('placeholder'), /[ぁ-ゟ゠-ヿ一-龯]/u);
        await page.locator('#button').click();
        await until(async () => /[ぁ-ゟ゠-ヿ一-龯]/u.test(await page.locator('#result').innerText()));
        await translated(tabId);
        await page.locator('#result').evaluate(el => el.replaceChildren());
      }
      if (url.endsWith('/multilingual')) {
        for (const text of await page.locator('p').allTextContents()) assert.match(text, /[ぁ-ゟ゠-ヿ一-龯]/u);
        assert.equal(await page.locator('#japanese').innerText(), 'これは元から日本語の文章です。');
      }
      if (url.endsWith('/dynamic')) {
        await page.locator('#changing').evaluate(el => { el.textContent = 'This website provides information about our research.'; });
        await page.locator('#feed').evaluate(el => { el.innerHTML = '<p>New content has arrived.</p><input placeholder="Search documents">'; });
        await until(async () => /[ぁ-ゟ゠-ヿ一-龯]/u.test(await page.locator('#feed p').innerText()));
        await translated(tabId);
        await pageSend(tabId, 'PAGE_RESTORE');
        assert.equal(await page.locator('#changing').innerText(), 'This website provides information about our research.');
        assert.equal(await page.locator('#feed p').innerText(), 'New content has arrived.');
        await page.locator('#changing').evaluate(el => { el.textContent = 'The weather is nice today.'; });
        await page.locator('#feed').evaluate(el => el.replaceChildren());
        await pageSend(tabId, 'PAGE_TRANSLATE');
        await translated(tabId);
      }
      await page.screenshot({ path: join(output, `${index + 1}-translated.png`), fullPage: false });
      if (url.endsWith('/article')) {
        await harness.locator('.panel').screenshot({ path: join(output, 'popup.png') });
        await harness.locator('#restore').click();
        await until(async () => (await pageSend(tabId, 'PAGE_STATUS')).status.phase === 'idle');
      } else await pageSend(tabId, 'PAGE_RESTORE');
      // External sites can update unrelated DOM; compare stable content on fixtures.
      if (url.startsWith(base)) assert.deepEqual(await snapshot(page), before, 'Exact original DOM and title restored');
      else {
        assert.equal(await page.title(), before.title, 'Original page title restored');
        assert.equal(await page.locator(contentSelector).first().textContent(), originalContent, 'Original public page content restored');
      }
      report.cases.push({ url: url.startsWith(base) ? new URL(url).pathname : url, ...status, milliseconds: Date.now() - start, restored: true });
    }
    if (url.endsWith('/cancel')) report.cases.push({ url: '/cancel', restored: true });
    console.log('PASS', url, report.cases.at(-1));
    await page.close();
  }
  // Verify persistent model cache can initialize and infer with all networking disabled.
  await context.setOffline(true);
  const offscreen = await harness.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(offscreen.length, 1);
  await harness.evaluate(() => chrome.offscreen.closeDocument());
  assert.equal((await send('ENGINE_PREPARE', { mode: report.mode })).ok, true);
  await until(async () => {
    const state = await send('ENGINE_STATUS');
    if (state.phase === 'error') throw new Error(JSON.stringify(state));
    return state.phase === 'ready';
  });
  const offline = await send('ENGINE_TEST');
  assert.equal(offline.ok, true);
  assert.match(offline.translation, /[ぁ-ゟ゠-ヿ一-龯]/u);
  report.offline = offline;
  assert.deepEqual(report.errors, [], 'No uncaught browser errors');
  console.log('PASS offline reload', offline);
} catch (error) {
  report.failure = String(error.stack || error);
  console.error(report.failure);
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await context?.close();
  await new Promise(r => server.close(r));
}
