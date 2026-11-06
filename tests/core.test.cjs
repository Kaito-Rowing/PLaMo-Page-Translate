const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

test('the URL guard only allows ordinary HTTP(S) pages', () => {
  assert.equal(core.isSupportedPage('https://example.org/guide'), true);
  assert.equal(core.isSupportedPage('http://localhost:8765/test'), true);
  assert.equal(core.isSupportedPage('chrome://extensions'), false);
  assert.equal(core.isSupportedPage('file:///C:/test.html'), false);
  assert.equal(core.isSupportedPage('data:text/html,foo'), false);
});

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

test('request strictly uses official PLaMo chat template options', () => {
  const request = core.makeRequest('Hello world');
  assert.equal(request.model, 'plamo-3-translate');
  assert.deepEqual(request.messages, [{ role: 'user', content: 'Hello world' }]);
  assert.deepEqual(request.chat_template_kwargs, { target_lang: 'ja', form: 'plain' });
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.stop, ['<|plamo:tag|>', '<|plamo:bos|>']);
  assert.throws(() => core.makeRequest('x'.repeat(1201)), /maximum/);
});

test('extracts only a complete translation from the API response', () => {
  const answer = (text, finish_reason = 'stop') => ({
    choices: [{ message: { content: text }, finish_reason }]
  });
  assert.equal(core.readTranslation(answer(' こんにちは。 ')), 'こんにちは。');
  assert.equal(core.readTranslation(answer('こんにちは。<|plamo:tag|>junk')), 'こんにちは。');
  assert.throws(() => core.readTranslation(answer('途中', 'length')), /上限/);
  assert.throws(() => core.readTranslation({ choices: [] }), /応答形式/);
});
