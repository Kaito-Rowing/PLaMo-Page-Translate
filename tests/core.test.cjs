const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

test('text filter preserves numbers, Japanese, URLs and email addresses', () => {
  assert.equal(core.shouldTranslateText('Welcome to the website.'), true);
  assert.equal(core.shouldTranslateText('Search'), true);
  assert.equal(core.shouldTranslateText(' '), false);
  assert.equal(core.shouldTranslateText('12345'), false);
  assert.equal(core.shouldTranslateText('日本語の文章です。'), false);
  assert.equal(core.shouldTranslateText('https://example.com/test'), false);
  assert.equal(core.shouldTranslateText('user@example.com'), false);
});

test('splits long texts into bounded sentence-like pieces without loss of content', () => {
  const sentence = 'This is a test sentence. ';
  const input = sentence.repeat(130);
  const chunks = core.splitText(input, 200);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((part) => part.length > 0 && part.length <= 200));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), input.trim());
});

test('preserves leading/trailing whitespace when applying translations', () => {
  assert.equal(core.restoreWhitespace('\n  Hello  ', 'こんにちは'), '\n  こんにちは  ');
  assert.equal(core.restoreWhitespace('Hello', 'こんにちは'), 'こんにちは');
});
