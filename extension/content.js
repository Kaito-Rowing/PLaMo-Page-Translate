/* Runs in Chrome's isolated world and edits only text/selected text attributes. */
(() => {
  "use strict";
  if (globalThis.__plamoPageTranslateInstalled) return;
  globalThis.__plamoPageTranslateInstalled = true;

  const core = globalThis.PLaMoCore;
  const IGNORE_SUBTREE = [
    "script", "style", "noscript", "template", "code", "pre", "kbd", "samp",
    "textarea", "select", "option", "svg", "math", "canvas", "iframe",
    "[contenteditable]", "[translate='no']", ".notranslate",
    "[data-plamo-ignore]", "[aria-hidden='true']", "[hidden]"
  ].join(",");
  const IGNORE_ATTRIBUTES = [
    "script", "style", "noscript", "template", "code", "pre", "kbd", "samp",
    "svg", "math", "canvas", "iframe", "[contenteditable]",
    "[translate='no']", ".notranslate", "[data-plamo-ignore]",
    "[aria-hidden='true']", "[hidden]"
  ].join(",");
  const TRANSLATABLE_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];
  const MAX_TASKS = 1200;
  const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,dt,dd,figcaption,td,th,blockquote";
  const INLINE = new Set(["A", "EM", "STRONG", "B", "I", "SPAN", "SMALL", "DEL", "S", "SUB", "SUP", "MARK", "ABBR", "CITE", "Q", "CODE", "KBD", "SAMP", "BR"]);
  const CONCURRENCY = 2;
  let currentSession = null;
  let nextId = 0;

  function visible(element) {
    if (!element || element.tagName === "TITLE") return true;
    if (!element.getClientRects().length) return false;
    const computed = getComputedStyle(element);
    return computed.display !== "none" && computed.visibility !== "hidden" &&
      computed.visibility !== "collapse";
  }

  function canTranslateNode(node) {
    const parent = node.parentElement;
    return !!parent && !parent.closest(IGNORE_SUBTREE) && visible(parent);
  }

  function canTranslateAttribute(element, attribute) {
    if (!element || element.closest(IGNORE_ATTRIBUTES) || !visible(element)) return false;
    if (element.matches("input[type='password'],input[type='hidden']")) return false;
    if (attribute === "placeholder" && !element.matches("input,textarea")) return false;
    if (attribute === "alt" && element.tagName !== "IMG") return false;
    return true;
  }

  function priorityOf(node) {
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!element || element.tagName === "TITLE") return 0;
    const rect = element.getBoundingClientRect();
    return rect.bottom >= 0 && rect.top <= innerHeight ? 0 : 1;
  }

  function withinLimit(session) {
    if (session.total >= MAX_TASKS) {
      session.limited = true;
      return false;
    }
    return true;
  }

  function enqueueText(session, node) {
    if (!node || node.nodeType !== Node.TEXT_NODE || !node.isConnected) return;
    if (!canTranslateNode(node) || !core.shouldTranslateText(node.nodeValue)) return;
    if (enqueueBlock(session, node)) return;
    const original = node.nodeValue;
    const recorded = session.textRecords.get(node);
    if (recorded && recorded.translated === original) return;
    if (recorded) session.textRecords.delete(node);
    if (!core.shouldTranslateText(original) || session.pendingText.has(node) || !withinLimit(session)) return;
    session.pendingText.add(node);
    session.queue.push({ kind: "text", node, original });
    session.total++;
  }

  // Translate a sentence with its inline markup in one request. Only these
  // synthetic tags cross the engine boundary; model-generated HTML is never used.
  function describeBlock(root) {
    const elements = [];
    const snapshots = new Map([[root, [...root.childNodes]]]);
    const walk = (parent) => [...parent.childNodes].map(child => {
      if (child.nodeType === Node.TEXT_NODE) return child.nodeValue;
      if (child.nodeType !== Node.ELEMENT_NODE) throw new Error('unsupported node');
      if (!INLINE.has(child.tagName)) throw new Error('non-inline element');
      const protectedCode = ["CODE", "KBD", "SAMP"].includes(child.tagName);
      if (!protectedCode && (child.matches(IGNORE_ATTRIBUTES) || !visible(child))) throw new Error('excluded element');
      const id = elements.length;
      elements.push({ node: child, parent, protectedCode });
      snapshots.set(child, [...child.childNodes]);
      const text = protectedCode ? child.textContent : child.tagName === 'BR' ? '' : walk(child);
      return `<x${id}>${text}</x${id}>`;
    }).join('');
    try {
      const markup = walk(root);
      if (!elements.length || markup.length > 1200 || /<\/?x\d+>/u.test(root.textContent)) return null;
      return { root, elements, snapshots, markup };
    } catch { return null; }
  }

  function blockMarkup(block) {
    const ids = new Map(block.elements.map((entry, id) => [entry.node, id]));
    const walk = parent => [...parent.childNodes].map(child => {
      if (child.nodeType === Node.TEXT_NODE) return child.nodeValue;
      const id = ids.get(child);
      if (id === undefined) return '\u0000';
      return `<x${id}>${block.elements[id].protectedCode ? child.textContent : walk(child)}</x${id}>`;
    }).join('');
    return walk(block.root);
  }

  function enqueueBlock(session, node) {
    const root = node.parentElement.closest(BLOCKS);
    if (!root?.childNodes || !canTranslateNode(node)) return false;
    const record = session.blockRecords.get(root);
    if (record && blockMarkup(record.block) === record.translated) return true;
    if (record) session.blockRecords.delete(root); // site-owned edits become the new source
    if (session.pendingBlocks.has(root)) return true;
    const block = describeBlock(root);
    if (!block || !core.shouldTranslateText(root.textContent)) return false;
    if (!withinLimit(session)) return true;
    session.pendingBlocks.add(root);
    session.queue.push({ kind: 'block', node: root, original: block.markup, block });
    session.total++;
    return true;
  }

  function parseInlineTranslation(block, text) {
    const parts = text.split(/(<\/?x\d+>)/u);
    const stack = [{ node: block.root, children: [] }];
    const seen = new Set();
    const replacements = new Map();
    for (const part of parts) {
      const match = /^<(\/?)x(\d+)>$/u.exec(part);
      if (!match) { if (part) stack.at(-1).children.push(document.createTextNode(part)); continue; }
      const id = Number(match[2]);
      const entry = block.elements[id];
      if (!entry) throw new Error('翻訳で未知の書式マーカーが返されました。原文を保持します。');
      if (!match[1]) {
        if (seen.has(id) || entry.parent !== stack.at(-1).node) throw new Error('翻訳で書式の構造が変わりました。原文を保持します。');
        seen.add(id);
        stack.at(-1).children.push(entry.node);
        stack.push({ node: entry.node, children: [], id });
      } else {
        if (stack.length === 1 || stack.at(-1).id !== id) throw new Error('翻訳の書式マーカーが対応していません。原文を保持します。');
        const current = stack.pop();
        if (!entry.protectedCode) replacements.set(current.node, current.children);
      }
    }
    if (stack.length !== 1 || seen.size !== block.elements.length) throw new Error('翻訳で書式マーカーが欠落しました。原文を保持します。');
    replacements.set(block.root, stack[0].children);
    return replacements;
  }

  function enqueueAttribute(session, element, attribute) {
    if (!element?.isConnected || !canTranslateAttribute(element, attribute)) return;
    const original = element.getAttribute(attribute);
    const recorded = session.attributeRecords.get(element)?.get(attribute);
    if (recorded && recorded.translated === original) return;
    if (recorded) session.attributeRecords.get(element).delete(attribute);
    if (!core.shouldTranslateText(original) || !withinLimit(session)) return;
    let pending = session.pendingAttributes.get(element);
    if (!pending) {
      pending = new Set();
      session.pendingAttributes.set(element, pending);
    }
    if (pending.has(attribute)) return;
    pending.add(attribute);
    session.queue.push({ kind: "attribute", node: element, attribute, original });
    session.total++;
  }

  function scanSubtree(session, root) {
    if (!root || !session.enabled || currentSession !== session) return;
    if (root.nodeType === Node.TEXT_NODE) {
      enqueueText(session, root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(IGNORE_ATTRIBUTES)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) enqueueText(session, walker.currentNode);

    const elements = [root, ...root.querySelectorAll("[placeholder],[title],[aria-label],[alt]")];
    for (const element of elements) {
      for (const attribute of TRANSLATABLE_ATTRIBUTES) {
        if (element.hasAttribute(attribute)) enqueueAttribute(session, element, attribute);
      }
    }
    session.queue.sort((a, b) => priorityOf(a.node) - priorityOf(b.node));
  }

  function taskValue(task) {
    if (task.kind === 'block') return blockMarkup(task.block);
    return task.kind === "text" ? task.node.nodeValue : task.node.getAttribute(task.attribute);
  }

  function isTaskStillValid(task) {
    if (!task.node.isConnected || taskValue(task) !== task.original) return false;
    if (task.kind === 'block') return visible(task.node) && !task.node.closest(IGNORE_SUBTREE) && !!describeBlock(task.node);
    return task.kind === "text" ? canTranslateNode(task.node) :
      canTranslateAttribute(task.node, task.attribute);
  }

  function releasePending(session, task) {
    if (task.kind === 'block') { session.pendingBlocks.delete(task.node); return; }
    if (task.kind === "text") {
      session.pendingText.delete(task.node);
    } else {
      session.pendingAttributes.get(task.node)?.delete(task.attribute);
    }
  }

  function updateRecordAndDOM(session, task, translated) {
    if (task.kind === 'block') {
      const replacements = parseInlineTranslation(task.block, translated);
      for (const [element, children] of replacements) element.replaceChildren(...children);
      session.blockRecords.set(task.node, { block: task.block, translated: blockMarkup(task.block) });
    } else if (task.kind === "text") {
      session.textRecords.set(task.node, { original: task.original, translated });
      task.node.nodeValue = translated;
    } else {
      let attrs = session.attributeRecords.get(task.node);
      if (!attrs) {
        attrs = new Map();
        session.attributeRecords.set(task.node, attrs);
      }
      attrs.set(task.attribute, { original: task.original, translated });
      task.node.setAttribute(task.attribute, translated);
    }
  }

  async function translateTask(session, task) {
    const pieces = task.kind === 'block' ? [task.original] : core.splitText(task.original, 900);
    const results = [];
    for (const piece of pieces) {
      if (!session.enabled || currentSession !== session) return false;
      const answer = await chrome.runtime.sendMessage({ type: "TRANSLATE_TEXT", text: piece, context: session.context });
      if (!answer?.ok) throw new Error(answer?.error || "翻訳APIが応答しませんでした。");
      results.push(answer.translation);
    }
    if (!session.enabled || currentSession !== session || !isTaskStillValid(task)) return false;
    updateRecordAndDOM(session, task, task.kind === 'block' ? results.join('') : core.restoreWhitespace(task.original, results.join("")));
    return true;
  }

  function pump(session) {
    if (!session.enabled || currentSession !== session) return;
    while (session.activeWorkers < CONCURRENCY && session.queue.length) {
      session.activeWorkers++;
      void worker(session);
    }
  }

  async function worker(session) {
    try {
      while (session.enabled && currentSession === session && session.queue.length) {
        session.queue.sort((a, b) => priorityOf(a.node) - priorityOf(b.node));
        const task = session.queue.shift();
        try {
          if (!isTaskStillValid(task)) {
            session.skipped++;
          } else if (await translateTask(session, task)) {
            session.completed++;
            session.consecutiveErrors = 0;
          } else {
            session.skipped++;
          }
        } catch (error) {
          session.failed++;
          session.consecutiveErrors++;
          session.lastError = String(error?.message || error);
          if (session.consecutiveErrors >= 3) {
            session.phase = "error";
            session.enabled = false;
            session.observer?.disconnect();
          }
        } finally {
          releasePending(session, task);
          // Site re-render during an in-flight request: queue the replacement text.
          if (session.enabled && currentSession === session &&
              task.node.isConnected && taskValue(task) !== task.original) {
            if (task.kind === 'block') scanSubtree(session, task.node);
            else if (task.kind === "text") enqueueText(session, task.node);
            else enqueueAttribute(session, task.node, task.attribute);
          }
        }
      }
    } finally {
      session.activeWorkers--;
      if (session.enabled && currentSession === session) {
        if (session.queue.length) pump(session);
        else if (session.activeWorkers === 0) session.phase = "translated";
      }
    }
  }

  function observeChanges(session) {
    let scanTimer = null;
    const added = new Set();
    const modifiedTexts = new Set();
    const modifiedAttrs = new Map();
    function schedule() {
      if (scanTimer !== null) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        if (!session.enabled || currentSession !== session) return;
        for (const node of added) scanSubtree(session, node);
        for (const node of modifiedTexts) enqueueText(session, node);
        for (const [element, attributes] of modifiedAttrs) {
          for (const attr of attributes) enqueueAttribute(session, element, attr);
        }
        added.clear();
        modifiedTexts.clear();
        modifiedAttrs.clear();
        if (session.queue.length) {
          session.phase = "translating";
          pump(session);
        }
      }, 180);
    }
    session.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        let managed = mutation.target?.nodeType === Node.TEXT_NODE ? mutation.target.parentElement : mutation.target;
        while (managed && !session.blockRecords.has(managed)) managed = managed.parentElement;
        const record = managed && session.blockRecords.get(managed);
        if (record && blockMarkup(record.block) === record.translated) continue;
        if (mutation.type === "childList") {
          for (const node of mutation.addedNodes) added.add(node);
        } else if (mutation.type === "characterData") {
          const node = mutation.target;
          if (session.textRecords.get(node)?.translated !== node.nodeValue) {
            modifiedTexts.add(node);
          }
        } else if (mutation.type === "attributes") {
          const element = mutation.target;
          const attr = mutation.attributeName;
          if (session.attributeRecords.get(element)?.get(attr)?.translated !== element.getAttribute(attr)) {
            if (!modifiedAttrs.has(element)) modifiedAttrs.set(element, new Set());
            modifiedAttrs.get(element).add(attr);
          }
        }
      }
      if (added.size || modifiedTexts.size || modifiedAttrs.size) schedule();
    });
    session.observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: TRANSLATABLE_ATTRIBUTES
    });
  }

  function status() {
    const s = currentSession;
    if (!s) return { phase: "idle", total: 0, completed: 0, failed: 0, skipped: 0,
      limited: false, lastError: null };
    return {
      phase: s.phase, total: s.total, completed: s.completed,
      failed: s.failed, skipped: s.skipped, limited: s.limited,
      lastError: s.lastError
    };
  }

  function restore() {
    const s = currentSession;
    if (!s) return status();
    s.enabled = false;
    s.observer?.disconnect();
    for (const [root, record] of s.blockRecords) {
      if (root.isConnected && blockMarkup(record.block) === record.translated) {
        for (const [element, children] of [...record.block.snapshots].reverse()) element.replaceChildren(...children);
      }
    }
    for (const [node, record] of s.textRecords) {
      if (node.isConnected && node.nodeValue === record.translated) node.nodeValue = record.original;
    }
    for (const [element, attrs] of s.attributeRecords) {
      if (!element.isConnected) continue;
      for (const [attribute, record] of attrs) {
        if (element.getAttribute(attribute) === record.translated) {
          element.setAttribute(attribute, record.original);
        }
      }
    }
    currentSession = null;
    return status();
  }

  function pageContext() {
    const area = document.querySelector('article') || document.querySelector('main') || document.body;
    const introduction = [...(area?.querySelectorAll('p') || [])]
      .find(p => p.textContent?.trim().length >= 60 && !p.closest(IGNORE_SUBTREE));
    return `${document.title || ''}\n${introduction?.textContent || ''}`.trim().slice(0, 400);
  }

  function start() {
    if (currentSession && currentSession.enabled) {
      scanSubtree(currentSession, document.body);
      pump(currentSession);
      return status();
    }
    if (currentSession) restore();
    const session = {
      id: ++nextId, enabled: true, phase: "translating", queue: [],
      pendingText: new Set(), pendingAttributes: new Map(), pendingBlocks: new Set(), blockRecords: new Map(),
      context: pageContext(),
      textRecords: new Map(), attributeRecords: new Map(), observer: null,
      total: 0, completed: 0, failed: 0, skipped: 0,
      activeWorkers: 0, consecutiveErrors: 0, lastError: null, limited: false
    };
    currentSession = session;
    observeChanges(session);
    scanSubtree(session, document.body);
    scanSubtree(session, document.querySelector("title"));
    if (session.queue.length) pump(session);
    else session.phase = "translated";
    return status();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    try {
      if (message.type === "PAGE_STATUS") sendResponse({ ok: true, status: status() });
      else if (message.type === "PAGE_TRANSLATE") sendResponse({ ok: true, status: start() });
      else if (message.type === "PAGE_RESTORE") sendResponse({ ok: true, status: restore() });
      else return false;
    } catch (error) {
      sendResponse({ ok: false, error: String(error.message || error) });
    }
    return false;
  });
})();
