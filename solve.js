// solve.js — a fast, dependency-free reimplementation of makefun-site 1.0.0's
// build, written from its specification (vendor/makefun-site/README.md).
// run(input) returns the output tree for one case: every path the build
// writes, mapped to that file's text. One case is answered alone; nothing
// is shared or cached from one case to the next.

// ---------------------------------------------------------------- helpers

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escRep(c) { return ESC_MAP[c]; }
function esc(s) { return ESC_TEST.test(s) ? s.replace(ESC_RE, escRep) : s; }

const MARK_RE = /\p{M}/gu;
const NON_ALNUM = /[^a-z0-9]+/g;

// A slug: NFKD, combining marks dropped, A-Z lowered, each run of
// characters other than a-z and 0-9 one '-', none at either end, cut to
// 64 characters with a '-' left at the cut dropped, 'untitled' when
// nothing is left.
function slugify(ctx, text) {
  const hit = ctx.slugCache.get(text);
  if (hit !== undefined) return hit;
  const s = text.normalize('NFKD').replace(MARK_RE, '').toLowerCase().replace(NON_ALNUM, '-');
  let a = 0;
  let b = s.length;
  if (b > 0 && s.charCodeAt(0) === 45) a = 1;
  if (b > a && s.charCodeAt(b - 1) === 45) b -= 1;
  if (b - a > 64) {
    b = a + 64;
    if (s.charCodeAt(b - 1) === 45) b -= 1;
  }
  const out = b <= a ? 'untitled' : s.slice(a, b);
  ctx.slugCache.set(text, out);
  return out;
}

// First of s, s-2, s-3, ... not yet taken.
function uniqueSlugIn(taken, base) {
  if (!taken.has(base)) { taken.add(base); return base; }
  let k = 2;
  while (taken.has(base + '-' + k)) k += 1;
  const out = base + '-' + k;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// The date in words from the string alone: 2026-11-09 is 9 November 2026.
function dateLong(ctx, d) {
  const hit = ctx.dateCache.get(d);
  if (hit !== undefined) return hit;
  const out = (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
  ctx.dateCache.set(d, out);
  return out;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = +v.slice(0, 4);
  const m = +v.slice(5, 7);
  const d = +v.slice(8, 10);
  if (m < 1 || m > 12) return false;
  let dim = DAYS_IN_MONTH[m - 1];
  if (m === 2 && y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) dim = 29;
  if (d < 1 || d > dim) return false;
  return v >= '1970-01-01' && v <= '2099-12-31';
}

const WORD_RE = /\S+/g;
function wordCount(s) {
  const m = s.match(WORD_RE);
  return m ? m.length : 0;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

// ----------------------------------------------------------- front matter

const KEY_RE = /^([a-z_]+):(.*)$/;
const KNOWN_KEYS = new Set(['title', 'summary', 'date', 'tags', 'draft', 'layout', 'slug']);
const DATE_ERR = 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';

function parseStringValue(key, value) {
  if (value.charCodeAt(0) === 34) { // '"': a quoted string
    let out = '';
    let i = 1;
    while (i < value.length) {
      const c = value[i];
      if (c === '\\') {
        const n = value[i + 1];
        if (n === '"' || n === '\\') { out += n; i += 2; }
        else { out += '\\'; i += 1; }
      } else if (c === '"') {
        if (i !== value.length - 1) return { error: 'key "' + key + '": a quoted string is not closed' };
        return { value: out };
      } else { out += c; i += 1; }
    }
    return { error: 'key "' + key + '": a quoted string is not closed' };
  }
  if (value.charCodeAt(0) === 91) return { error: 'key "' + key + '": a bare string opens on [' }; // '['
  return { value };
}

function parseTagsValue(value) {
  if (value.length < 2 || value.charCodeAt(0) !== 91 || value.charCodeAt(value.length - 1) !== 93) {
    return { error: 'key "tags": not a list [a, b]' };
  }
  const inner = value.slice(1, -1);
  if (inner === '') return { value: [] };
  const parts = inner.split(',');
  const out = [];
  for (let p of parts) {
    p = p.replace(/^[ \t]+|[ \t]+$/g, '');
    if (p === '' || p.indexOf('"') !== -1 || p.indexOf('[') !== -1 || p.indexOf(']') !== -1) {
      return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    out.push(p);
  }
  return { value: out };
}

function parseFMValue(key, value) {
  switch (key) {
    case 'title':
    case 'summary':
      return parseStringValue(key, value);
    case 'date':
      return isRealDate(value) ? { value } : { error: DATE_ERR };
    case 'tags':
      return parseTagsValue(value);
    case 'draft':
      if (value === 'true') return { value: true };
      if (value === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return /^[a-z0-9-]+$/.test(value) ? { value } : { error: 'key "layout": not a template name' };
    case 'slug':
      return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && value.length <= 64
        ? { value }
        : { error: 'key "slug": not a slug' };
    default:
      return { value };
  }
}

// Parses a source's lines. Returns { fm, body } or { error }.
function parseFM(lines) {
  if (lines.length === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const fm = {};
  const seen = new Set();
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue;
    if (line.charCodeAt(0) === 35) continue; // '#': a comment
    const m = KEY_RE.exec(line);
    if (!m) return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    const key = m[1];
    if (!KNOWN_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (seen.has(key)) return { error: 'key "' + key + '" is given twice' };
    seen.add(key);
    let value = m[2];
    if (value.charCodeAt(0) === 32) value = value.slice(1); // one space
    value = value.replace(/[ \t]+$/, '');
    if (value === '') return { error: 'key "' + key + '" has no value' };
    const parsed = parseFMValue(key, value);
    if (parsed.error) return { error: parsed.error };
    fm[key] = parsed.value;
  }
  return { fm, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const BLANK_RE = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+\-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const TRIM_RE = /^[ \t]+|[ \t]+$/g;
function trimWs(s) { return s.replace(TRIM_RE, ''); }

const SPECIAL_RE = /[\\`*[]/g;
const ESCAPABLE = '\\`*_[]()#+-.!>';

function isEscaped(s, j) {
  let k = j - 1;
  let c = 0;
  while (k >= 0 && s[k] === '\\') { c += 1; k -= 1; }
  return (c & 1) === 1;
}

function findStrongCloser(s, i) {
  let j = s.indexOf('**', i + 2);
  while (j !== -1) {
    if (j >= i + 3 && !isEscaped(s, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

function findEmCloser(s, i) {
  // The next '*' that is not escaped and not part of a '**' pair: a pair
  // is skipped whole, so in a run of three stars the third one closes.
  let j = s.indexOf('*', i + 1);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    if (j >= i + 2) return j;
    j = s.indexOf('*', j + 1);
  }
  return -1;
}

function tryLink(s, i, link, srcPath) {
  let j = s.indexOf(']', i + 1);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(']', j + 1);
  if (j === -1 || s[j + 1] !== '(') return null;
  const k = s.indexOf(')', j + 2);
  if (k === -1) return null;
  const target = s.slice(j + 2, k);
  if (target.length === 0 || /\s/.test(target)) return null;
  const href = link(target, srcPath);
  return {
    html: '<a href="' + esc(href) + '">' + inlineParse(s.slice(i + 1, j), link, srcPath) + '</a>',
    end: k + 1,
  };
}

// Inline markup, left to right: escapes, code spans, strong, emphasis,
// links; every other character written escaped. Raw HTML is text.
function inlineParse(s, link, srcPath) {
  const out = [];
  const n = s.length;
  let i = 0;
  let lit = 0;
  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(s);
    if (!m) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\') {
      const nx = s[j + 1];
      if (nx !== undefined && ESCAPABLE.indexOf(nx) !== -1) {
        if (j > lit) out.push(esc(s.slice(lit, j)));
        out.push(ESC_MAP[nx] || nx);
        i = j + 2;
        lit = i;
      } else { i = j + 1; }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > lit) out.push(esc(s.slice(lit, j)));
        out.push('<code>' + esc(s.slice(j + 1, k)) + '</code>');
        i = k + 1;
        lit = i;
      } else { i = j + 1; }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        // '**' opens strong unless what follows it opens on '**' too: the
        // content must not start with '**' (a run of four stars leaves the
        // first two literal and opens on the second pair). A rejected
        // '**' is literal text, both stars.
        if (s[j + 2] === '*' && s[j + 3] === '*') { i = j + 2; continue; }
        const k = findStrongCloser(s, j);
        if (k !== -1) {
          if (j > lit) out.push(esc(s.slice(lit, j)));
          out.push('<strong>' + inlineParse(s.slice(j + 2, k), link, srcPath) + '</strong>');
          i = k + 2;
          lit = i;
        } else { i = j + 2; }
      } else {
        // a single '*' opens emphasis (a '*' left over from a '**'
        // closer still opens, as in '***at*** x')
        const k = findEmCloser(s, j);
        if (k !== -1) {
          if (j > lit) out.push(esc(s.slice(lit, j)));
          out.push('<em>' + inlineParse(s.slice(j + 1, k), link, srcPath) + '</em>');
          i = k + 1;
          lit = i;
        } else { i = j + 1; }
      }
      continue;
    }
    const r = tryLink(s, j, link, srcPath);
    if (r) {
      if (j > lit) out.push(esc(s.slice(lit, j)));
      out.push(r.html);
      i = r.end;
      lit = i;
    } else { i = j + 1; }
  }
  if (lit < n) out.push(esc(s.slice(lit, n)));
  return out.join('');
}

// Renders one source body. Returns { html, excerpt, toc }: the body's
// HTML, the HTML of its first paragraph (or ''), and its level 2 and 3
// headings ({ level, id, html }).
function renderMd(body, link, srcPath, headingId) {
  const lines = body.split('\n');
  const out = [];
  let excerpt = null;
  const toc = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (BLANK_RE.test(line)) { i += 1; continue; }
    let m = FENCE_OPEN.exec(line);
    if (m) {
      const lang = m[1];
      const buf = [];
      i += 1;
      while (i < n && !FENCE_CLOSE.test(lines[i])) { buf.push(esc(lines[i])); i += 1; }
      if (i < n) i += 1; // consume the closing fence
      out.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' +
        buf.join('\n') + (buf.length ? '\n' : '') + '</code></pre>\n');
      continue;
    }
    m = HEADING_RE.exec(line);
    if (m) {
      const text = trimWs(m[2]);
      if (text !== '') {
        const level = m[1].length;
        const html = inlineParse(text, link, srcPath);
        const id = headingId(text);
        if (level === 2 || level === 3) toc.push({ level, id, html });
        out.push('<h' + level + ' id="' + id + '">' + html + '</h' + level + '>\n');
        i += 1;
        continue;
      }
    }
    if (HR_RE.test(line)) { out.push('<hr>\n'); i += 1; continue; }
    if (line.charCodeAt(0) === 62) { // '>': blockquote
      const parts = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        t = trimWs(t);
        if (t !== '') parts.push(t);
        i += 1;
      }
      out.push(parts.length
        ? '<blockquote>\n<p>' + inlineParse(parts.join('\n'), link, srcPath) + '</p>\n</blockquote>\n'
        : '<blockquote>\n</blockquote>\n');
      continue;
    }
    const bMatch = /^[-*] /.exec(line);
    const oMatch = bMatch ? null : /^(\d+)\. /.exec(line);
    if (bMatch || oMatch) { // list: one kind at a time, no nesting
      const isOrdered = !!oMatch;
      const startNum = oMatch ? parseInt(oMatch[1], 10) : 0;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const mm = /^(\d+)\. /.exec(l);
          if (mm) {
            if (cur !== null) items.push(cur);
            cur = trimWs(l.slice(mm[0].length));
            i += 1;
            continue;
          }
        } else if (/^[-*] /.test(l)) {
          if (cur !== null) items.push(cur);
          cur = trimWs(l.slice(2));
          i += 1;
          continue;
        }
        if (cur !== null && /^  +[^ ]/.test(l)) {
          cur += '\n' + trimWs(l);
          i += 1;
          continue;
        }
        break;
      }
      if (cur !== null) items.push(cur);
      let html = isOrdered
        ? (startNum !== 1 ? '<ol start="' + startNum + '">' : '<ol>') + '\n'
        : '<ul>\n';
      for (const it of items) html += '<li>' + inlineParse(it, link, srcPath) + '</li>\n';
      html += isOrdered ? '</ol>\n' : '</ul>\n';
      out.push(html);
      continue;
    }
    // paragraph: lines up to a blank line, a fence, a heading or a break
    const parts = [];
    while (i < n) {
      const l = lines[i];
      if (BLANK_RE.test(l)) break;
      if (FENCE_OPEN.test(l)) break;
      const hm = HEADING_RE.exec(l);
      if (hm && trimWs(hm[2]) !== '') break;
      if (HR_RE.test(l)) break;
      parts.push(trimWs(l));
      i += 1;
    }
    const inner = inlineParse(parts.join('\n'), link, srcPath);
    if (excerpt === null) excerpt = inner;
    out.push('<p>' + inner + '</p>\n');
  }
  return { html: out.join(''), excerpt: excerpt === null ? '' : excerpt, toc };
}

// --------------------------------------------------------------- templates

// A path is names joined by '.': a name starts with a letter or '_',
// then letters, digits or '_'. Spaces are allowed inside the braces
// around a path, not inside it.
function parsePath(str) {
  const t = str.replace(/^[ \t]+|[ \t]+$/g, '');
  if (t === '') return null;
  const parts = t.split('.');
  for (const p of parts) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return null;
  }
  return parts;
}

// Op kinds: 0 text, 1 output ({{ }} escaped, {{{ }}} raw), 2 for,
// 3 if, 4 include, 5 endfor, 6 endif, 7 else.
function parseTag(content) {
  if (content === 'endfor') return { t: 5 };
  if (content === 'endif') return { t: 6 };
  if (content === 'else') return { t: 7 };
  let m = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.+)$/.exec(content);
  if (m) {
    const path = parsePath(m[2]);
    if (!path) return { error: 'a path is not one' };
    return { t: 2, v: m[1], path };
  }
  m = /^if\s+not\s+(.+)$/.exec(content);
  if (m) {
    const path = parsePath(m[1]);
    if (!path) return { error: 'a path is not one' };
    return { t: 3, path, neg: true };
  }
  m = /^if\s+(.+)$/.exec(content);
  if (m) {
    const path = parsePath(m[1]);
    if (!path) return { error: 'a path is not one' };
    return { t: 3, path, neg: false };
  }
  m = /^include\s+"([^"]*)"$/.exec(content);
  if (m) return { t: 4, name: m[1] };
  return { error: 'a tag is none of the above' };
}

// Compiles a template source into an op tree. Returns { ops } or { error }.
// A {% %} tag alone on its line (only spaces or tabs beside it) takes the
// whole line with it, its newline included. Text, {{ }} and {{{ }}} never do.
function compileTemplate(src) {
  const segs = [];
  const n = src.length;
  let i = 0;
  let textStart = 0;
  while (i < n) {
    const a = src.indexOf('{{', i);
    const b = src.indexOf('{%', i);
    if (a === -1 && b === -1) break;
    let j;
    let isTag;
    if (b !== -1 && (a === -1 || b < a)) { j = b; isTag = true; }
    else { j = a; isTag = false; }
    if (!isTag) {
      const raw = src.startsWith('{{{', j);
      const close = raw ? '}}}' : '}}';
      const k = src.indexOf(close, j + (raw ? 3 : 2));
      if (k === -1) return { error: raw ? 'a {{{ is not closed' : 'a {{ is not closed' };
      if (j > textStart) segs.push({ t: 0, s: src.slice(textStart, j) });
      const path = parsePath(src.slice(j + (raw ? 3 : 2), k));
      if (!path) return { error: 'a path is not one' };
      segs.push({ t: 1, path, raw });
      i = k + close.length;
      textStart = i;
    } else {
      const k = src.indexOf('%}', j + 2);
      if (k === -1) return { error: 'a {% is not closed' };
      const tagEnd = k + 2;
      const prefix = src.slice(src.lastIndexOf('\n', j - 1) + 1, j);
      let suffixEnd = tagEnd;
      while (suffixEnd < n && (src[suffixEnd] === ' ' || src[suffixEnd] === '\t')) suffixEnd += 1;
      const standalone = /^[ \t]*$/.test(prefix) && (suffixEnd >= n || src[suffixEnd] === '\n');
      let text = src.slice(textStart, j);
      if (standalone) text = text.replace(/[ \t]+$/, '');
      if (text !== '') segs.push({ t: 0, s: text });
      const content = src.slice(j + 2, k).replace(/^[ \t]+|[ \t]+$/g, '');
      const seg = parseTag(content);
      if (seg.error) return { error: seg.error };
      segs.push(seg);
      i = tagEnd;
      if (standalone) {
        if (suffixEnd < n && src[suffixEnd] === '\n') suffixEnd += 1;
        i = suffixEnd;
      }
      textStart = i;
    }
  }
  if (textStart < n) segs.push({ t: 0, s: src.slice(textStart) });
  const root = [];
  const stack = [{ kind: 0, body: root }];
  for (const seg of segs) {
    if (seg.t === 0 || seg.t === 1 || seg.t === 4) {
      stack[stack.length - 1].body.push(seg);
      continue;
    }
    if (seg.t === 2) {
      const node = { t: 2, v: seg.v, path: seg.path, body: [] };
      stack[stack.length - 1].body.push(node);
      stack.push({ kind: 2, body: node.body });
      continue;
    }
    if (seg.t === 3) {
      const node = { t: 3, path: seg.path, neg: seg.neg, then: [], els: [] };
      stack[stack.length - 1].body.push(node);
      stack.push({ kind: 3, node, body: node.then });
      continue;
    }
    if (seg.t === 7) {
      const top = stack[stack.length - 1];
      if (top.kind !== 3 || top.body !== top.node.then) return { error: 'an else without an if' };
      top.body = top.node.els;
      continue;
    }
    if (seg.t === 5) {
      const top = stack[stack.length - 1];
      if (top.kind !== 2) return { error: top.kind === 3 ? 'an endfor closes an if' : 'an endfor without a for' };
      stack.pop();
      continue;
    }
    // endif
    const top = stack[stack.length - 1];
    if (top.kind !== 3) return { error: top.kind === 2 ? 'an endif closes a for' : 'an endif without an if' };
    stack.pop();
  }
  if (stack.length > 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 2 ? 'a for is not closed' : 'an if is not closed' };
  }
  return { ops: root };
}

// A value is written as: a string itself; a number in JavaScript's own
// digits; true or false; an array as its items written and joined by ', ';
// anything else as ''.
function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k += 1) {
      if (k) s += ', ';
      s += writeValue(v[k]);
    }
    return s;
  }
  return '';
}

// Undefined, null, false, '', 0 and an empty array are false; anything
// else is true.
function truthy(v) {
  return !(v === undefined || v === null || v === false || v === '' || v === 0 ||
    (Array.isArray(v) && v.length === 0));
}

// A path's first name is read from the innermost loop that binds it
// (loop before the element), else from the page's values; each next name
// is an own property of the value so far, or the path is undefined.
function resolvePath(path, scope) {
  let v;
  let found = false;
  for (let i = scope.length - 1; i >= 0; i -= 1) {
    const f = scope[i];
    if (f !== null && (typeof f === 'object' || typeof f === 'function') &&
      Object.prototype.hasOwnProperty.call(f, path[0])) {
      v = f[path[0]];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let k = 1; k < path.length; k += 1) {
    if (v === null || v === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderOps(ops, scope, tplMap, depth, out) {
  for (const op of ops) {
    if (op.t === 0) { out.push(op.s); continue; }
    if (op.t === 1) {
      const v = writeValue(resolvePath(op.path, scope));
      out.push(op.raw ? v : esc(v));
      continue;
    }
    if (op.t === 2) {
      const arr = resolvePath(op.path, scope);
      if (Array.isArray(arr)) {
        const len = arr.length;
        for (let k = 0; k < len; k += 1) {
          const frame = {};
          frame[op.v] = arr[k];
          frame.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          scope.push(frame);
          renderOps(op.body, scope, tplMap, depth, out);
          scope.pop();
        }
      }
      continue;
    }
    if (op.t === 3) {
      const cond = truthy(resolvePath(op.path, scope));
      renderOps(cond !== op.neg ? op.then : op.els, scope, tplMap, depth, out);
      continue;
    }
    // include: a missing one, or one nested more than 8 deep, renders nothing
    if (depth < 8) {
      const tpl = tplMap.get(op.name);
      if (tpl) renderOps(tpl, scope, tplMap, depth + 1, out);
    }
  }
}

// ------------------------------------------------------------ link targets

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Resolves a relative path from a source's directory ('.' and '..' steps,
// never above the root).
function resolveRelPath(dir, path) {
  const segs = dir === '' ? [] : dir.split('/');
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length) segs.pop();
      continue;
    }
    segs.push(part);
  }
  return segs.join('/');
}

// A link's href: a target with a scheme, opening on '/' or opening on '#'
// is kept as written. Any other is a path from the source's directory,
// with an optional '#' fragment: the url of the page built from that
// source, or <base>/<path> of a static file, the fragment after it. A
// target that names neither is reported as a broken link and kept as written.
function resolveHref(ctx, target, srcPath) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) {
    return target;
  }
  let path = target;
  let frag = '';
  const hi = target.indexOf('#');
  if (hi !== -1) { path = target.slice(0, hi); frag = target.slice(hi); }
  const resolved = resolveRelPath(dirOf(srcPath), path);
  const pg = ctx.pageBySource.get(resolved);
  if (pg) return pg.url + frag;
  if (ctx.staticPaths.has(resolved)) return ctx.base + '/' + resolved + frag;
  ctx.broken.add('broken-link ' + srcPath + ' -> ' + target);
  return target;
}

// ------------------------------------------------------------------- build

export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');
  const ctx = {
    slugCache: new Map(),
    dateCache: new Map(),
    base,
    pageBySource: new Map(),
    staticPaths: new Set(),
    broken: new Set(),
  };
  const report = [];

  // Sources sorted by path in code-unit order; '.md' is a source, the
  // rest are static files.
  const sorted = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (const f of sorted) {
    if (f.path.endsWith('.md')) sources.push(f);
    else { statics.push(f); ctx.staticPaths.add(f.path); }
  }

  // Templates parsed in code-unit order of name; one that does not parse
  // is reported and left out.
  const tplMap = new Map();
  const names = Object.keys(input.templates).sort();
  for (const name of names) {
    const r = compileTemplate(input.templates[name]);
    if (r.error) report.push('template "' + name + '": ' + r.error);
    else tplMap.set(name, r.ops);
  }

  // Front matter and the checks, in order: refused front matter, a source
  // under tags/ or page/, a post with no date, a layout that is no template
  // that parses, a draft. First failure reported, the source dropped.
  const pages = [];
  const takenByDir = new Map();
  takenByDir.set('', new Set(['posts', 'tags', 'page']));
  for (const f of sources) {
    const content = f.content.replace(/\r\n?/g, '\n');
    const lines = content.split('\n');
    const fmRes = parseFM(lines);
    if (fmRes.error) { report.push('refused ' + f.path + ': ' + fmRes.error); continue; }
    const fm = fmRes.fm;
    if (!fm.title) { report.push('refused ' + f.path + ': no title'); continue; }
    const dir = dirOf(f.path);
    if (dir === 'tags' || dir.startsWith('tags/') || dir === 'page' || dir.startsWith('page/')) {
      const own = dir === 'tags' || dir.startsWith('tags/') ? 'tags/' : 'page/';
      report.push('refused ' + f.path + ': ' + own + ' is the generator\'s own');
      continue;
    }
    const isPost = dir === 'posts' || dir.startsWith('posts/');
    if (isPost && !fm.date) { report.push('refused ' + f.path + ': a post needs a date'); continue; }
    const layout = fm.layout || (isPost ? 'post' : 'page');
    if (!tplMap.has(layout)) {
      report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) { report.push('draft ' + f.path); continue; }
    // Permalinks: a post's directory is posts/; a page's is its source's
    // directory. The slug is its slug key or the slug of its title, made
    // unique in its directory in source order; at the root, posts, tags
    // and page are taken from the start.
    const pdir = isPost ? 'posts' : dir;
    let taken = takenByDir.get(pdir);
    if (!taken) { taken = new Set(); takenByDir.set(pdir, taken); }
    const slug = uniqueSlugIn(taken, fm.slug || slugify(ctx, fm.title));
    const url = base + '/' + (pdir === '' ? '' : pdir + '/') + slug + '/';
    const outPath = (pdir === '' ? '' : pdir + '/') + slug + '/index.html';
    const pg = { path: f.path, fm, isPost, layout, slug, url, outPath, body: fmRes.body };
    pages.push(pg);
    ctx.pageBySource.set(f.path, pg);
  }

  // Markdown: each source's body rendered to HTML, links resolved.
  const linkFn = (target, srcPath) => resolveHref(ctx, target, srcPath);
  for (const pg of pages) {
    const hidTaken = new Set();
    const headingId = (text) => uniqueSlugIn(hidTaken, slugify(ctx, text));
    const r = renderMd(pg.body, linkFn, pg.path, headingId);
    pg.content = r.html;
    pg.excerpt = r.excerpt;
    pg.toc = r.toc;
    pg.readingMinutes = Math.max(1, Math.ceil(wordCount(pg.body) / 200));
  }

  // Collections: posts newest date first, equal dates by slug in
  // code-unit order; each post's newer is the one before it, older the
  // one after it, null at either end.
  const posts = pages.filter((p) => p.isPost).sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date > b.fm.date ? -1 : 1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  // Tags: each post's tags, each slug once (first spelling kept); a tag is
  // all the posts whose tags have its slug, named as first met walking the
  // posts in collection order; tags ordered by count desc, then by slug.
  const tagMap = new Map();
  for (const post of posts) {
    const seen = new Set();
    const tags = post.fm.tags || [];
    for (const tname of tags) {
      const slug = slugify(ctx, tname);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let t = tagMap.get(slug);
      if (!t) { t = { name: tname, slug, count: 0, posts: [] }; tagMap.set(slug, t); }
      t.count += 1;
      t.posts.push(post);
    }
  }
  const tags = [...tagMap.values()].sort((a, b) =>
    (b.count - a.count) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const tagUrlBySlug = new Map();
  for (const t of tags) tagUrlBySlug.set(t.slug, base + '/tags/' + t.slug + '/');
  const tagsCtx = tags.map((t) => ({ name: t.name, slug: t.slug, url: tagUrlBySlug.get(t.slug), count: t.count }));

  const siteCtx = { title: site.title, base_url: base };

  // Cards: title, url, date, date_long, summary, excerpt,
  // reading_minutes, and tags. A page's tags link to the tag of the same
  // slug, so a tag's name and url come from the tag registry (the first
  // spelling met walking the posts in collection order) where one exists,
  // and its own spelling with url '' where no post has that tag.
  function cardTags(pg) {
    const out = [];
    const seen = new Set();
    for (const tname of pg.fm.tags || []) {
      const slug = slugify(ctx, tname);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const g = tagMap.get(slug);
      out.push({ name: g ? g.name : tname, slug, url: g ? tagUrlBySlug.get(slug) : '' });
    }
    return out;
  }
  for (const pg of pages) {
    pg.card = {
      title: pg.fm.title,
      url: pg.url,
      date: pg.fm.date || '',
      date_long: pg.fm.date ? dateLong(ctx, pg.fm.date) : '',
      summary: pg.fm.summary || '',
      excerpt: pg.excerpt,
      reading_minutes: pg.readingMinutes,
      tags: cardTags(pg),
    };
    pg.pageObj = {
      ...pg.card,
      slug: pg.slug,
      content: pg.content,
      toc: pg.toc,
      newer: null,
      older: null,
      is_post: pg.isPost,
    };
  }
  for (let i = 0; i < posts.length; i += 1) {
    const po = posts[i].pageObj;
    if (i > 0) {
      const nb = posts[i - 1];
      po.newer = { title: nb.fm.title, url: nb.url, date: nb.fm.date, date_long: dateLong(ctx, nb.fm.date) };
    }
    if (i < posts.length - 1) {
      const nb = posts[i + 1];
      po.older = { title: nb.fm.title, url: nb.url, date: nb.fm.date, date_long: dateLong(ctx, nb.fm.date) };
    }
  }
  // Recent: the first site.recent posts, as cards (built above).
  const recentCards = posts.slice(0, site.recent || 0).map((p) => p.card);

  // Layouts: every page through its layout (its layout key, else post for
  // a post and page for a page), with page; the index through index, the
  // tags through tag and tags. Every template also sees site, tags and
  // recent. An index/tag/tags page whose template is missing is not written.
  const out = {};
  function renderToString(ops, values) {
    const buf = [];
    renderOps(ops, [values], tplMap, 0, buf);
    return buf.join('');
  }
  let pagesWritten = 0;
  let postsWritten = 0;
  for (const pg of pages) {
    out[pg.outPath] = renderToString(tplMap.get(pg.layout),
      { site: siteCtx, tags: tagsCtx, recent: recentCards, page: pg.pageObj });
    if (pg.isPost) postsWritten += 1; else pagesWritten += 1;
  }
  const indexOps = tplMap.get('index');
  if (indexOps) {
    const perPage = Math.max(1, site.per_page || 1);
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let n = 1; n <= total; n += 1) {
      const slice = posts.slice((n - 1) * perPage, n * perPage).map((p) => p.card);
      const pager = {
        number: n,
        total,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n > 1 ? (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/') : '',
        older_url: n < total ? base + '/page/' + (n + 1) + '/' : '',
      };
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = renderToString(indexOps,
        { site: siteCtx, tags: tagsCtx, recent: recentCards, posts: slice, pager });
    }
  }
  const tagOps = tplMap.get('tag');
  let tagsWritten = 0;
  if (tagOps) {
    for (const t of tags) {
      const tagObj = {
        name: t.name,
        slug: t.slug,
        url: tagUrlBySlug.get(t.slug),
        count: t.count,
        posts: t.posts.map((p) => p.card),
      };
      out['tags/' + t.slug + '/index.html'] = renderToString(tagOps,
        { site: siteCtx, tags: tagsCtx, recent: recentCards, tag: tagObj });
      tagsWritten += 1;
    }
  }
  const tagsOps = tplMap.get('tags');
  if (tagsOps) {
    out['tags/index.html'] = renderToString(tagsOps,
      { site: siteCtx, tags: tagsCtx, recent: recentCards });
  }

  // Static files at their own paths, unless a built page has that path.
  const builtPaths = new Set(Object.keys(out));
  let staticsWritten = 0;
  for (const f of statics) {
    if (builtPaths.has(f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
      continue;
    }
    out[f.path] = f.content;
    staticsWritten += 1;
  }

  // Report: every line reported above and each broken link, sorted in
  // code-unit order, then the built line; every line ending in '\n'.
  const allLines = report.concat([...ctx.broken]);
  allLines.sort();
  allLines.push('built ' + pagesWritten + ' pages, ' + postsWritten + ' posts, ' +
    tagsWritten + ' tags and ' + staticsWritten + ' static files');
  out['build-report.txt'] = allLines.map((l) => l + '\n').join('');
  return out;
}
