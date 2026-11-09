import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';

const root = resolve('extension');
async function install(page, html, translate) {
  const requests = [];
  await page.exposeFunction('translateForTest', async message => {
    requests.push(message);
    return { ok: true, translation: await translate(message.text) };
  });
  await page.setContent(html);
  await page.evaluate(() => {
    globalThis.chrome = { runtime: {
      onMessage: { addListener(listener) { globalThis.command = type => new Promise(reply => listener({ type }, {}, reply)); } },
      sendMessage: message => globalThis.translateForTest(message),
    } };
  });
  await page.addScriptTag({ path: resolve(root, 'core.js') });
  await page.addScriptTag({ path: resolve(root, 'content.js') });
  return requests;
}
const command = (page, type) => page.evaluate(type => globalThis.command(type), type);
const idle = page => expect.poll(async () => (await command(page, 'PAGE_STATUS')).status.phase).toBe('translated');

test('translates complete paragraphs, reorders original links, and restores exact markup', async ({ page }) => {
  const source = '<p id="intro">Layered agent memory for <a href="/harness"><em>DeepSeek Harness</em></a>, with a nightly pass that <strong>corrects</strong> what the agent got wrong.</p>';
  const requests = await install(page, source, text => text.includes('<x0>')
    ? '<x0><x1>DeepSeek Harness</x1></x0>向けの階層型エージェントメモリ。毎晩、エージェントの誤りを<x2>修正</x2>する。' : '訳文');
  const before = await page.locator('#intro').evaluate(el => el.outerHTML);
  await page.evaluate(() => { globalThis.originalLink = document.querySelector('a'); globalThis.clicks = 0; originalLink.onclick = event => { event.preventDefault(); clicks++; }; });
  await command(page, 'PAGE_TRANSLATE');
  await idle(page);
  expect(requests.filter(r => r.text.includes('Layered agent memory'))).toHaveLength(1);
  expect(requests.some(r => r.text === 'Layered agent memory for ')).toBe(false);
  await expect(page.locator('#intro')).toHaveText('DeepSeek Harness向けの階層型エージェントメモリ。毎晩、エージェントの誤りを修正する。');
  expect(await page.evaluate(() => originalLink === document.querySelector('a'))).toBe(true);
  await page.locator('a').click();
  expect(await page.evaluate(() => clicks)).toBe(1);
  await new Promise(r => setTimeout(r, 400));
  expect(requests).toHaveLength(1); // own DOM mutations cannot cause an inference loop
  await command(page, 'PAGE_RESTORE');
  expect(await page.locator('#intro').evaluate(el => el.outerHTML)).toBe(before);
});

test('keeps inline code byte-for-byte even when the model translates it', async ({ page }) => {
  await install(page, '<p>The <code>memory_dream</code> tool verifies <strong>existing notes</strong>.</p>', () => '既存の<x1>ノート</x1>を検証する<x0>メモリードリーム</x0>ツール。');
  await command(page, 'PAGE_TRANSLATE');
  await idle(page);
  await expect(page.locator('code')).toHaveText('memory_dream');
  await expect(page.locator('p')).toHaveText('既存のノートを検証するmemory_dreamツール。');
  await command(page, 'PAGE_RESTORE');
  await expect(page.locator('p')).toHaveText('The memory_dream tool verifies existing notes.');
});

for (const [name, bad] of [['missing', '翻訳だけ。'], ['duplicated', '<x0>リンク</x0><x0>重複</x0>']]) {
  test(`rejects ${name} markers without changing the original DOM`, async ({ page }) => {
    await install(page, '<p id="target">Read <a href="/guide">the guide</a> first.</p>', () => bad);
    const before = await page.locator('#target').evaluate(el => el.outerHTML);
    await command(page, 'PAGE_TRANSLATE');
    await idle(page);
    expect((await command(page, 'PAGE_STATUS')).status.failed).toBe(1);
    expect(await page.locator('#target').evaluate(el => el.outerHTML)).toBe(before);
  });
}

test('does not overwrite a site re-render while paragraph translation is in flight', async ({ page }) => {
  let release;
  const waiting = new Promise(r => { release = r; });
  await install(page, '<p id="target">Read <a href="/guide">the guide</a> first.</p>', async text => { await waiting; return text.includes('<x0>') ? '<x0>ガイド</x0>を読む。' : '新しい内容。'; });
  await command(page, 'PAGE_TRANSLATE');
  await page.locator('#target').evaluate(el => { el.textContent = 'New content from the site.'; });
  release();
  await idle(page);
  await expect(page.locator('#target')).toHaveText('新しい内容。');
  await command(page, 'PAGE_RESTORE');
  await expect(page.locator('#target')).toHaveText('New content from the site.');
});

test('treats model-generated HTML as literal text', async ({ page }) => {
  await install(page, '<p>Read <a href="/guide">the guide</a> first.</p>', () => '<img src=x onerror="globalThis.injected=true"><x0>ガイド</x0>を読む。');
  await command(page, 'PAGE_TRANSLATE');
  await idle(page);
  expect(await page.locator('p img').count()).toBe(0);
  expect(await page.evaluate(() => globalThis.injected)).toBeUndefined();
});

test('does not translate code-only paragraphs or Japanese prose around inline identifiers', async ({ page }) => {
  const requests = await install(page, '<p> <code>MEMORY.md</code> </p><p>これは<code>operations</code>の説明です。</p>', () => '変更してはいけない。');
  const before = await page.locator('body').innerHTML();
  await command(page, 'PAGE_TRANSLATE');
  await idle(page);
  expect(requests).toHaveLength(0);
  expect(await page.locator('body').innerHTML()).toBe(before);
});
