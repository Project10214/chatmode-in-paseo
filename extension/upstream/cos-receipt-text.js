/* Chat On Steroids — MIT, Copyright (c) 2026 Chat On Steroids contributors.
 * Source: extension/content.js @ e40562640361ca8f74158b2262ca8c555b00abed,
 * unescapeMarkdown (827–828) and matchesSubmittedBootstrap (878–887).
 * CIP extraction: raw comparison first, then exactly one native Markdown decode.
 * No Goal/continuation-marker exception. Preserve whitespace via the caller's
 * existing normalization, rather than upstream sendText's whitespace deletion.
 * Only the caller's current native user source may enable the decoded comparison;
 * this helper does not establish message identity, navigation or authorization.
 */
(() => {
  'use strict';
  // Kept verbatim from the pinned CoS source. Do not repeatedly unescape, strip
  // Markdown, HTML-decode other entities or normalize the outgoing editor text.
  const unescapeMarkdown = (value) => String(value || '').replace(/\\\r?\n/g, '\n').replace(/\\([!-\/:-@\[-`{-~])/g, '$1')
    .replace(/(^|\n)&#x20;/g, '$1 ');
  globalThis.CIP_createCoSReceiptText = ({ normalize }) => {
    if (typeof normalize !== 'function') throw new TypeError('RECEIPT_NORMALIZER_REQUIRED');
    function matchesSubmittedBootstrap(actual, expected, allowNativeMarkdown = false) {
      if (typeof actual !== 'string' || typeof expected !== 'string' ||
          actual.length > 256000 || expected.length > 240000) return 'mismatch';
      const wanted = normalize(expected);
      if (!wanted) return 'mismatch';
      if (normalize(actual) === wanted) return 'raw';
      if (allowNativeMarkdown === true && normalize(unescapeMarkdown(actual)) === wanted) return 'markdown';
      return 'mismatch';
    }
    return Object.freeze({ classify: matchesSubmittedBootstrap });
  };
})();
