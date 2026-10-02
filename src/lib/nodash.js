'use strict';
/**
 * Removes every dash (hyphen, en dash, em dash, minus) from user-visible text.
 * Email addresses and URLs are left intact because altering them would make them wrong.
 */
const DASH = /[-‐‑‒–—―−]/;

function cleanText(s) {
  if (!s || !DASH.test(s)) return s;
  let out = s
    .replace(/(\d)[–—](\d)/g, '$1 to $2')          // ranges: 2026–2028 → 2026 to 2028
    .replace(/(^|\s)[-‐‑‒–—―−]+(?=\s|$)/g, (m, sp) => (sp ? ',' : '')); // spaced dashes → comma
  out = out.replace(/\S*[-‐‑‒–—―−]\S*/g, (tok) => {
    if (tok.includes('@') || tok.includes('://') || tok.startsWith('/')) return tok;
    return tok.replace(/[-‐‑‒–—―−]+/g, ' ').replace(/^ +| +$/g, '');
  });
  return out.trim().replace(/ ,/g, ',').replace(/,\s*,/g, ',').replace(/^\s*,\s*/, '').replace(/,\s*$/, '').replace(/  +/g, ' ');
}

const ATTRS = /(\s(?:placeholder|title|aria-label|alt|data-confirm|data-busy|data-label)=")([^"]*)(")/g;

/** Applies cleanText to text nodes and visible attributes of an HTML document. */
function cleanHtml(html) {
  if (!html || !DASH.test(html)) return html;
  const parts = html.split(/(<[^>]*>)/);
  let skip = null; // inside <script>, <style> or <textarea>
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith('<')) {
      const m = p.match(/^<\/?\s*([a-zA-Z]+)/);
      const tag = m ? m[1].toLowerCase() : '';
      if (skip) {
        if (p.toLowerCase().startsWith(`</${skip}`)) skip = null;
        continue;
      }
      if (['script', 'style', 'textarea'].includes(tag) && !p.startsWith('</') && !p.endsWith('/>')) skip = tag;
      parts[i] = p.replace(ATTRS, (all, a, v, b) => a + cleanText(v) + b);
    } else if (!skip) {
      // Preserve surrounding whitespace of the text node.
      parts[i] = p.replace(/^(\s*)([\s\S]*?)(\s*)$/, (all, a, t, b) => a + cleanText(t) + b);
    }
  }
  return parts.join('');
}

module.exports = { cleanText, cleanHtml };
