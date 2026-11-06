const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

test('patched worker catches null native result and unread GLUE header before allocation', async () => {
  const { generateWorkers } = await import('../scripts/build.mjs');
  const destination = await mkdtemp(join(tmpdir(), 'plamo-worker-test-'));
  try {
    await generateWorkers({ destination });
    const code = await readFile(join(destination, 'llama-worker.js'), 'utf8');
    const parsed = spawnSync(process.execPath, ['--check', join(destination, 'llama-worker.js')], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.match(code, /let lastNativeError = ''/);
    assert.match(code, /if \(RUN_OPTIONS.noWebGPU\)/);
    assert.match(code, /WorkerNavigator.prototype/);
    assert.match(code, /if \(outputPtr == null \|\| outputPtr === 0 \|\| outputPtr === 0n\)/);
    assert.match(code, /outputLen < 16 \|\| outputLen > 16 \* 1024 \* 1024/);
    const magic = Buffer.from('GLUE').readUInt32LE(0);
    assert.equal(magic, 1163217991);
    assert.ok(magic > 16 * 1024 * 1024);
    assert.ok(code.indexOf('outputLen > 16 * 1024 * 1024') < code.indexOf('new Uint8Array(outputLen)'));
  } finally {
    await rm(destination, { force: true, recursive: true });
  }
});
