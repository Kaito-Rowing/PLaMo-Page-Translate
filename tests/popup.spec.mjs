import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

async function openPopup(page, initial = {}) {
  await page.setViewportSize({ width: 380, height: 600 });
  await page.route('https://popup.test/**', async route => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'popup.html';
    const type = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' }[extname(file)];
    await route.fulfill({ body: await readFile(resolve('extension', file)), contentType: type });
  });
  await page.addInitScript(initial => {
    globalThis.popupFixture = {
      engine: { phase: 'idle', mode: 'gpu', ...initial.engine },
      page: { phase: 'idle', total: 0, completed: 0, failed: 0, skipped: 0, ...initial.page },
      requests: [], prepareError: '',
    };
    const fixture = globalThis.popupFixture;
    globalThis.chrome = {
      runtime: { async sendMessage(message) {
        fixture.requests.push(message);
        if (message.type === 'ENGINE_STATUS') return { ok: true, ...fixture.engine };
        if (fixture.prepareError) return { ok: false, error: fixture.prepareError };
        fixture.engine = { phase: 'downloading', mode: message.mode, loaded: 600000000, total: 1800000000, message: 'モデルをダウンロードしています。' };
        return { ok: true, ...fixture.engine };
      } },
      tabs: {
        async query() { return [{ id: 7, url: initial.url || 'https://example.com/guide', title: 'いつものWebページ — 調べものと長い記事のサンプル' }]; },
        async sendMessage(id, message) {
          if (message.type === 'PAGE_TRANSLATE') fixture.page = { phase: 'translating', total: 14, completed: 0, failed: 0, skipped: 0 };
          if (message.type === 'PAGE_RESTORE') fixture.page = { phase: 'idle', total: 0, completed: 0, failed: 0, skipped: 0 };
          return { ok: true, status: { ...fixture.page } };
        },
      },
      scripting: { async executeScript() { return []; } },
    };
  }, initial);
  await page.goto('https://popup.test/popup.html');
  await expect(page.locator('#server-status')).not.toHaveText('確認中');
}
async function snapshot(page, name) {
  if (!process.env.PLAMO_PREVIEW_DIR) return;
  await mkdir(process.env.PLAMO_PREVIEW_DIR, { recursive: true });
  await page.locator('.panel').screenshot({ path: resolve(process.env.PLAMO_PREVIEW_DIR, `${name}.png`) });
}

test('guides model preparation, shows progress, and makes translation primary when ready', async ({ page }) => {
  await openPopup(page);
  await expect(page.locator('#engine-details')).toHaveAttribute('open', '');
  await expect(page.locator('#translate')).toBeDisabled();
  expect(await page.locator('.panel').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(600);
  await snapshot(page, 'idle-light');
  await page.locator('#prepare').click();
  await expect(page.locator('#model-progress')).toHaveAttribute('aria-valuenow', '33');
  await expect(page.locator('#prepare-cpu')).toBeDisabled();
  await snapshot(page, 'downloading-light');
  await page.evaluate(() => { popupFixture.engine = { phase: 'ready', mode: 'gpu', message: 'モデル準備完了。ページを翻訳できます。' }; });
  await expect(page.locator('#translate')).toBeEnabled();
  await expect(page.locator('#engine-details')).not.toHaveAttribute('open');
  await expect(page.locator('#page-host')).toHaveText('example.com');
  await snapshot(page, 'ready-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await snapshot(page, 'ready-dark');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(380);
});

test('engine polling cannot re-enable translation or mode changes during a running page job', async ({ page }) => {
  await openPopup(page, { engine: { phase: 'ready' } });
  await page.locator('#translate').click();
  await expect(page.locator('#translate')).toBeDisabled();
  await expect(page.locator('#restore')).toBeEnabled();
  // Cross an engine poll: it must respect the page's translating state.
  await expect.poll(() => page.evaluate(() => popupFixture.requests.filter(r => r.type === 'ENGINE_STATUS').length)).toBeGreaterThan(1);
  await expect(page.locator('#translate')).toBeDisabled();
  await page.locator('summary').click();
  await expect(page.locator('#prepare-cpu')).toBeDisabled();
  await snapshot(page, 'translating-light');
  await page.locator('#restore').click();
  await expect(page.locator('#translate')).toBeEnabled();
  await expect(page.locator('#restore')).toBeDisabled();
});

test('keeps a failed preparation visible across status polls and permits retry', async ({ page }) => {
  await openPopup(page);
  await page.evaluate(() => { popupFixture.prepareError = 'GPUメモリが不足しています。CPUモードをお試しください。'; });
  await page.locator('#prepare').click();
  await expect(page.locator('#model-message')).toContainText('GPUメモリが不足');
  await expect.poll(() => page.evaluate(() => popupFixture.requests.filter(r => r.type === 'ENGINE_STATUS').length)).toBeGreaterThan(2);
  await expect(page.locator('#model-message')).toContainText('GPUメモリが不足');
  await expect(page.locator('#prepare-cpu')).toBeEnabled();
  await snapshot(page, 'error-light');
  await page.evaluate(() => { popupFixture.prepareError = ''; });
  await page.locator('#prepare-cpu').click();
  await expect(page.locator('#server-status')).toHaveText('ダウンロード中');
});
