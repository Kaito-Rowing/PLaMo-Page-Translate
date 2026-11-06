const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const TEXT = 3;
const ELEMENT = 1;
class FakeText {
  constructor(value) {
    this.nodeType = TEXT;
    this.nodeValue = value;
    this.isConnected = true;
    this.parentElement = null;
  }
}
class FakeElement {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = ELEMENT;
    this.parentElement = null;
    this.isConnected = true;
    this.children = [];
    this.attrs = new Map(Object.entries(attributes));
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  getAttribute(attr) { return this.attrs.has(attr) ? this.attrs.get(attr) : null; }
  setAttribute(attr, value) { this.attrs.set(attr, value); }
  hasAttribute(attr) { return this.attrs.has(attr); }
  matches(selector) {
    return selector.split(',').some((part) => {
      const s = part.trim();
      if (s.startsWith('.')) return (this.getAttribute('class') || '').split(' ').includes(s.slice(1));
      const match = /^(\w[\w-]*)?(?:\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\])?$/.exec(s);
      if (!match) return false;
      if (match[1] && this.tagName !== match[1].toUpperCase()) return false;
      if (!match[2]) return true;
      if (!this.hasAttribute(match[2])) return false;
      return match[3] === undefined || this.getAttribute(match[2]) === match[3];
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.nodeType === ELEMENT) {
          if (child.matches(selector)) results.push(child);
          visit(child);
        }
      }
    };
    visit(this);
    return results;
  }
  getClientRects() { return [{}]; }
  getBoundingClientRect() { return { top: 10, bottom: 50 }; }
}

function makeBrowser(translate = async (text) => `訳:${text}`) {
  const html = new FakeElement('html');
  const head = html.appendChild(new FakeElement('head'));
  const title = head.appendChild(new FakeElement('title'));
  const titleText = title.appendChild(new FakeText('Example Page'));
  const body = html.appendChild(new FakeElement('body'));
  const heading = body.appendChild(new FakeElement('h1'));
  const headingText = heading.appendChild(new FakeText('Welcome to our website.'));
  const code = body.appendChild(new FakeElement('code'));
  const codeText = code.appendChild(new FakeText('const user = "Hello";'));
  const notranslate = body.appendChild(new FakeElement('p', { translate: 'no' }));
  const noTranslateText = notranslate.appendChild(new FakeText('Do not translate this.'));
  const japanese = body.appendChild(new FakeElement('p'));
  const japaneseText = japanese.appendChild(new FakeText('これは日本語の文章です。'));
  const input = body.appendChild(new FakeElement('input', { placeholder: 'Search documents' }));
  const document = {
    body, documentElement: html,
    querySelector(selector) { return selector === 'title' ? title : null; },
    createTreeWalker(root) {
      const nodes = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (child.nodeType === TEXT) nodes.push(child);
          else walk(child);
        }
      };
      walk(root);
      let index = -1;
      return {
        currentNode: null,
        nextNode() {
          index++;
          if (index >= nodes.length) return false;
          this.currentNode = nodes[index];
          return true;
        }
      };
    }
  };
  const observers = [];
  class MockObserver {
    constructor(callback) { this.callback = callback; observers.push(this); this.active = false; }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  }
  let listener;
  const ctx = vm.createContext({
    document, Node: { TEXT_NODE: TEXT, ELEMENT_NODE: ELEMENT },
    NodeFilter: { SHOW_TEXT: 4 }, MutationObserver: MockObserver,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    innerHeight: 800, setTimeout, clearTimeout,
    chrome: { runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      async sendMessage(request) {
        if (request.type !== 'TRANSLATE_TEXT') throw new Error('Unexpected message');
        return { ok: true, translation: await translate(request.text) };
      }
    } }
  });
  const root = path.join(__dirname, '../extension');
  for (const name of ['core.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), ctx, { filename: name });
  }
  function command(type) {
    return new Promise((resolve) => listener({ type }, {}, resolve));
  }
  function emit(change) {
    for (const obs of observers) if (obs.active) obs.callback([change]);
  }
  return { command, emit, body, headingText, codeText, noTranslateText,
    japaneseText, input, titleText };
}

async function settle(ms = 35) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test('translates visible DOM text and attributes, skips code and restores original content', async () => {
  const browser = makeBrowser();
  const started = await browser.command('PAGE_TRANSLATE');
  assert.equal(started.ok, true);
  await settle();
  assert.equal(browser.headingText.nodeValue, '訳:Welcome to our website.');
  assert.equal(browser.titleText.nodeValue, '訳:Example Page');
  assert.equal(browser.input.getAttribute('placeholder'), '訳:Search documents');
  assert.equal(browser.codeText.nodeValue, 'const user = "Hello";');
  assert.equal(browser.noTranslateText.nodeValue, 'Do not translate this.');
  assert.equal(browser.japaneseText.nodeValue, 'これは日本語の文章です。');
  const completed = (await browser.command('PAGE_STATUS')).status;
  assert.equal(completed.phase, 'translated');
  assert.equal(completed.completed, 3);
  const restored = await browser.command('PAGE_RESTORE');
  assert.equal(restored.status.phase, 'idle');
  assert.equal(browser.headingText.nodeValue, 'Welcome to our website.');
  assert.equal(browser.titleText.nodeValue, 'Example Page');
  assert.equal(browser.input.getAttribute('placeholder'), 'Search documents');
});

test('translates newly inserted DOM nodes while session remains enabled', async () => {
  const browser = makeBrowser();
  await browser.command('PAGE_TRANSLATE');
  await settle();
  const paragraph = browser.body.appendChild(new FakeElement('p'));
  const text = paragraph.appendChild(new FakeText('Dynamic content appears later.'));
  browser.emit({ type: 'childList', addedNodes: [paragraph] });
  await settle(280);
  assert.equal(text.nodeValue, '訳:Dynamic content appears later.');
  await browser.command('PAGE_RESTORE');
  assert.equal(text.nodeValue, 'Dynamic content appears later.');
});

test('ignores late translation responses after user restores the page', async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const browser = makeBrowser(async (text) => {
    await blocked;
    return `訳:${text}`;
  });
  await browser.command('PAGE_TRANSLATE');
  await browser.command('PAGE_RESTORE');
  release();
  await settle();
  assert.equal(browser.headingText.nodeValue, 'Welcome to our website.');
  assert.equal(browser.titleText.nodeValue, 'Example Page');
});
