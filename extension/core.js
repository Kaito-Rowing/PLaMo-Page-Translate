/* Shared, dependency-free helpers (Chrome content script, service worker, Node tests). */
(function (root, factory) {
  "use strict";
  const api = factory();
  root.PLaMoCore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis, function () {
  "use strict";

  const STOP_TOKENS = ["<|plamo:tag|>", "<|plamo:bos|>"];

  function isSupportedPage(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }

  function shouldTranslateText(value) {
    if (typeof value !== "string") return false;
    const text = value.trim();
    if (!text || !/\p{L}/u.test(text)) return false;
    if (/^(?:https?:\/\/|www\.|mailto:|data:|javascript:)/i.test(text)) return false;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return false;
    // Japanese text with no Latin words usually needs no ja→ja translation.
    if (/[ぁ-ゟ゠-ヿ]/u.test(text) && !/[A-Za-z]{2,}/.test(text)) return false;
    // Skip long strings that consist only of paths, code tokens or machine IDs.
    if (text.length > 12 && !/\s/.test(text) && /^[\w./\\:#?&=%+@~-]+$/.test(text) && /[/\\#?=&]/.test(text)) return false;
    return true;
  }

  function splitText(value, maxChars = 900) {
    if (typeof value !== "string" || !Number.isInteger(maxChars) || maxChars < 80) {
      throw new TypeError("Invalid text or maximum chunk length");
    }
    let remaining = value.trim();
    const parts = [];
    while (remaining.length > maxChars) {
      const windowText = remaining.slice(0, maxChars);
      const min = Math.floor(maxChars * 0.55);
      let cut = -1;
      // Prefer sentence boundaries so fragments keep their semantic context.
      for (const marker of ["。", "！", "？", ". ", "! ", "? ", "\n", " "]) {
        const index = windowText.lastIndexOf(marker);
        const candidate = index < 0 ? -1 : index + marker.length;
        if (candidate >= min && candidate > cut) cut = candidate;
      }
      if (cut < min) cut = maxChars;
      const part = remaining.slice(0, cut).trim();
      if (part) parts.push(part);
      remaining = remaining.slice(cut).trim();
    }
    if (remaining) parts.push(remaining);
    return parts;
  }

  function restoreWhitespace(original, translated) {
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(original);
    return match ? match[1] + translated + match[3] : translated;
  }

  function makeRequest(text) {
    if (!shouldTranslateText(text) || text.length > 1200) {
      throw new TypeError("Invalid translation segment (maximum 1200 characters)");
    }
    return {
      model: "plamo-3-translate",
      messages: [{ role: "user", content: text }],
      chat_template_kwargs: { target_lang: "ja", form: "plain" },
      temperature: 0,
      max_tokens: Math.min(2048, Math.max(128, Math.ceil(text.length * 2))),
      stop: STOP_TOKENS
    };
  }

  function readTranslation(response) {
    const answer = response?.choices?.[0]?.message?.content;
    if (typeof answer !== "string") throw new Error("モデルの応答形式が正しくありません。");
    if (response.choices[0].finish_reason === "length") {
      throw new Error("訳文がトークン上限で切れました。文章を短くしてください。");
    }
    // The documented stop sequences are passed to llama-server; strip as a safeguard.
    const clean = answer.split(/<\|plamo:(?:tag|bos)\|>/u, 1)[0].trim();
    if (!clean) throw new Error("モデルから空の訳文が返されました。");
    return clean;
  }

  return Object.freeze({
    isSupportedPage, shouldTranslateText, splitText,
    restoreWhitespace, makeRequest, readTranslation
  });
});
