// Prose shared by the module pages.
//
// Extracted once the requirement pool became a second consumer — not before, because a
// shell pulled out while it had one consumer is what left the earlier "reusable" layer
// covering almost nothing. Everything here is pure DOM building from text, so nothing an
// author wrote is ever interpreted as HTML.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// Section prose is author-written text. What authors actually write, in every handoff
// on the instance, is a leading \u26d4 / \u26a0\ufe0f / \u2b50 on the paragraph they want to stand out,
// plus **bold** and `code` inline -- so that is what gets rendered here. The explicit
// GitHub alert syntax is understood too, for anyone who prefers to name the type.
// A plain "> quoted" line becomes a quote block: a requirement keeps the user's own
// words under 用户原文 that way, and handoff prose quotes the user with it too.
const CALLOUT_LABELS = {
  NOTE: '\u6ce8\u8bb0', TIP: '\u63d0\u793a', IMPORTANT: '\u8981\u70b9', WARNING: '\u8b66\u544a', CAUTION: '\u5371\u9669'
};
const CALLOUT_START = /^>[ \t]?\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(.*)$/i;
const QUOTE = /^>[ \t]?(.*)$/;

// Leading markers, matched only at the start of a paragraph so that an inline \u26d4 in the
// middle of a sentence stays an ordinary character. Repeats (\u26d4\u26d4) are the author adding
// weight; they are kept in the text rather than normalised away.
const EMOJI_CALLOUTS = [
  [/^(?:\u26d4|\ud83d\uded1|\ud83d\udeab|\u274c)+/u, 'CAUTION'],
  [/^(?:\u26a0\ufe0f|\u26a0)+/u, 'WARNING'],
  [/^(?:\u2b50|\ud83c\udf1f|\u2757|\u203c\ufe0f)+/u, 'IMPORTANT'],
  [/^(?:\ud83d\udca1|\u2705)+/u, 'TIP'],
  [/^(?:\u2139\ufe0f|\ud83d\udccc|\ud83d\udcdd)+/u, 'NOTE']
];

const trimBlankEdges = (lines) => {
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
};

const emojiType = (text) => {
  for (const [pattern, type] of EMOJI_CALLOUTS) if (pattern.test(text)) return type;
  return null;
};

// A requirement's body is a whole document with ## headings, unlike a handoff section
// which is already one. Left alone the hashes render as literal text.
const HEADING = /^(#{2,4})[ \t]+(.+)$/;

// ⛔ and ⚠️ straight after the end of a sentence start a block of their own:
// 「…与 origin/main 一致。⚠️ Codex 也在…」 was one plain paragraph with the warning buried in
// it (Brian 2026-09-24, #208). After a comma the marker is still part of the sentence.
const SENTENCE_MARKER = /([。！？；.!?;])[ \t]*(?=⛔|⚠)/gu;

// A marker opens a block where a line starts with it, not only where a paragraph does:
// 注意事项 is typically a run of ⛔ and ⚠️ lines with no blank line between them, and read
// as one paragraph they all took the first line's colour. Lines of one type stay together,
// and a line with no marker belongs to the block above it.
function markedRuns(para) {
  const runs = [];
  for (const line of para.replace(SENTENCE_MARKER, '$1\n').split('\n')) {
    const type = emojiType(line.trimStart());
    const last = runs[runs.length - 1];
    if (last && (!type || type === last.type)) last.lines.push(line);
    else runs.push({ type, lines: [line] });
  }
  return runs;
}

function paragraphBlocks(text) {
  const blocks = [];
  for (const raw of text.split(/\n[ \t]*\n/)) {
    let para = raw.trim();
    if (!para) continue;
    // A heading owns its line only; anything under it stays an ordinary paragraph.
    const lines = para.split('\n');
    const heading = HEADING.exec(lines[0] ?? '');
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      para = lines.slice(1).join('\n').trim();
      if (!para) continue;
    }
    for (const run of markedRuns(para)) {
      const body = run.lines.join('\n').trim();
      if (!body) continue;
      blocks.push(run.type ? { kind: 'callout', type: run.type, title: '', text: body } : { kind: 'text', text: body });
    }
  }
  return blocks;
}

// The other block forms a body carries, counted on production (2026-09-25, #267): lists in
// nearly every requirement — 来源 is one — fenced code in 78 (交付证据's JSON), links in
// 29, and a few tables and rules. They showed as their raw markup until then.
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const TASK = /^\[([ xX])\][ \t]+/;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const indentOf = (line) => /^[ \t]*/.exec(line)[0].replace(/\t/g, '    ').length;
const isListItem = (line) => LIST_ITEM.test(line) && !RULE.test(line);

/** A table row's cells, the outer pipes dropped; a pipe inside a cell is written \|. */
function tableCells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  const cells = [''];
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') { cells[cells.length - 1] += '|'; i += 1; }
    else if (row[i] === '|') cells.push('');
    else cells[cells.length - 1] += row[i];
  }
  return cells.map((cell) => cell.trim());
}

const alignOf = (cell) => {
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.endsWith(':')) return 'right';
  return cell.startsWith(':') ? 'left' : null;
};

/** A header row with a delimiter row under it, cell for cell, opens a table. */
function opensTable(lines, at) {
  if (!lines[at].includes('|') || at + 1 >= lines.length || !TABLE_DELIMITER.test(lines[at + 1])) return false;
  return tableCells(lines[at]).length === tableCells(lines[at + 1]).length;
}

function takeTable(lines, at) {
  const header = tableCells(lines[at]);
  const align = tableCells(lines[at + 1]).map(alignOf);
  const rows = [];
  let i = at + 2;
  for (; i < lines.length && lines[i].trim() && lines[i].includes('|'); i += 1) {
    const cells = tableCells(lines[i]).slice(0, header.length);
    while (cells.length < header.length) cells.push('');
    rows.push(cells);
  }
  return { block: { kind: 'table', header, align, rows }, next: i };
}

/** Everything up to the closing fence stays exactly as written. An unclosed one runs on. */
function takeFence(lines, at, open) {
  const marker = open[1];
  const closing = new RegExp(`^[ \\t]{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
  const body = [];
  let i = at + 1;
  for (; i < lines.length && !closing.test(lines[i]); i += 1) body.push(lines[i]);
  const lang = open[2].trim().split(/\s+/)[0] ?? '';
  return { block: { kind: 'code', lang, text: body.join('\n') }, next: i + 1 };
}

/**
 * A run of list items, nested by indentation. A blank line keeps the list going when more
 * of it follows — 来源 separates every item with one — and a line indented under an item
 * carries that item on. Items of one kind next to each other are one list; a switch from
 * bullets to numbers, or back, starts another.
 */
function takeList(lines, at) {
  const flat = [];
  let i = at;
  let gap = false;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    const item = isListItem(line) ? LIST_ITEM.exec(line) : null;
    if (item) {
      const task = TASK.exec(item[3]);
      flat.push({
        indent: indentOf(item[1]),
        ordered: /\d/.test(item[2]),
        start: /\d/.test(item[2]) ? Number.parseInt(item[2], 10) : 1,
        checked: task ? task[1] !== ' ' : null,
        text: task ? item[3].slice(task[0].length) : item[3]
      });
      gap = false;
      continue;
    }
    if (!line.trim()) {
      let next = i + 1;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && (isListItem(lines[next]) || indentOf(lines[next]) > 0)) {
        i = next - 1;
        gap = true;
        continue;
      }
      break;
    }
    if (indentOf(line) > 0 && flat.length) {
      const last = flat[flat.length - 1];
      last.text += (gap ? '\n\n' : '\n') + line.trim();
      gap = false;
      continue;
    }
    break;
  }

  const root = { children: [] };
  const stack = [{ indent: -1, node: root }];
  for (const { indent, ...item } of flat) {
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const node = { ...item, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  const group = (nodes) => {
    const lists = [];
    for (const node of nodes) {
      let list = lists[lists.length - 1];
      if (!list || list.ordered !== node.ordered) {
        list = { ordered: node.ordered, start: node.start, items: [] };
        lists.push(list);
      }
      list.items.push({ text: node.text, checked: node.checked, lists: group(node.children) });
    }
    return lists;
  };
  return { blocks: group(root.children).map((list) => ({ kind: 'list', ...list })), next: i };
}

export function parseProse(content) {
  const lines = String(content ?? '').split('\n');
  const blocks = [];
  let text = [];
  const flushText = () => {
    if (trimBlankEdges(text).length) blocks.push(...paragraphBlocks(text.join('\n')));
    text = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const fence = FENCE.exec(lines[i]);
    // Three backticks with more on the line is inline code, not a fence.
    if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
      flushText();
      const { block, next } = takeFence(lines, i, fence);
      blocks.push(block);
      i = next - 1;
      continue;
    }
    const start = CALLOUT_START.exec(lines[i]);
    if (start) {
      flushText();
      const body = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith('>') && !CALLOUT_START.test(lines[i + 1])) {
        i += 1;
        body.push(lines[i].replace(/^>[ \t]?/, ''));
      }
      const type = start[1].toUpperCase();
      blocks.push({ kind: 'callout', type, title: start[2].trim(), text: trimBlankEdges(body).join('\n') });
      continue;
    }
    // Reached only when the line did not open a callout and was not swallowed as one's
    // body, so what is left is an ordinary quote: the user's own words, kept as theirs.
    const quote = QUOTE.exec(lines[i]);
    if (!quote) {
      if (RULE.test(lines[i])) {
        flushText();
        blocks.push({ kind: 'rule' });
      } else if (opensTable(lines, i)) {
        flushText();
        const { block, next } = takeTable(lines, i);
        blocks.push(block);
        i = next - 1;
      } else if (isListItem(lines[i])) {
        flushText();
        const { blocks: lists, next } = takeList(lines, i);
        blocks.push(...lists);
        i = next - 1;
      } else {
        text.push(lines[i]);
      }
      continue;
    }
    flushText();
    const quoted = [quote[1]];
    while (i + 1 < lines.length && QUOTE.test(lines[i + 1]) && !CALLOUT_START.test(lines[i + 1])) {
      i += 1;
      quoted.push(QUOTE.exec(lines[i])[1]);
    }
    // A run of bare '>' markers quotes nothing; dropping it beats drawing an empty bar.
    const quotedText = trimBlankEdges(quoted).join('\n');
    if (quotedText) blocks.push({ kind: 'quote', text: quotedText });
  }
  flushText();
  return blocks;
}

/**
 * A timestamp in the reader's own timezone.
 *
 * This used to be `createdAt.replace('T', ' ').slice(0, 16)`, which is not formatting but
 * string surgery: OpenProject answers in UTC, so every entry in the history read eight
 * hours early, silently and plausibly — the digits looked like a time, just the wrong
 * one. Parsing and formatting hands the conversion to the browser, which knows where the
 * reader is. Every time a page shows goes through here.
 */
export function localTime(value) {
  if (!value) return '';
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(when);
}

// A complete timestamp that says which timezone it is in. Only these are converted: a
// date alone, or a time with no zone, does not say which moment it means.
const INSTANT = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))(?![\d:])/;

/**
 * Text split into plain runs and timestamps. Records and notes carry the timestamps
 * agents write — UTC, or with an offset — and a page read by a person showed them raw
 * next to headers already in local time (Brian 2026-09-23). Pure, so it can be tested.
 */
export function splitInstants(text) {
  return String(text ?? '').split(INSTANT).filter((part) => part !== '').map((part) =>
    INSTANT.test(part) && localTime(part) ? { instant: part, text: localTime(part) } : { text: part });
}

// What a reader looks for in a section, marked where it stands. Authors — agents mostly —
// seldom put a commit, a path or a requirement number in backticks, so a section read as
// plain text with all of it buried inside (Brian 2026-09-24, #208). Two colours, so the two
// kinds tell apart: a requirement or a handoff named in blue, and in terracotta, as code,
// anything one would type or look up in a repository. Recognised by shape alone; a word is
// never guessed at, so ordinary Chinese and English stay as written.
const WORD_EXTENSIONS = 'css|js|mjs|cjs|ts|tsx|jsx|rb|py|sh|zsh|json|jsonl|md|yml|yaml|toml|lock|dump|gz|tgz|zip|tar|'
  + 'env|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|html?|txt|log|sql|plist|xml|csv|pdf|sock|conf|ini';
const FILE_NAME = new RegExp(`\\.(?:${WORD_EXTENSIONS})$`);
const VALUE = '[^\\s，。；、！？（）()「」<>"\'`]';
const SHAPES = [
  ['url', 'code', 'https?:\\/\\/[^\\s<>"\'`，。；、！？（）()「」]+'],
  ['business', 'ref', '(?<![\\w-])[A-Z][A-Z0-9]*-(?:REQ|HO)-\\d{8}-\\d{3,}(?![\\w-])'],
  // A requirement number has at most five digits; six or eight are a colour (#141413).
  ['number', 'ref', '(?<![\\w&#/])#\\d{1,5}(?!\\w)'],
  ['colour', 'code', '(?<![\\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?!\\w)'],
  ['uuid', 'code', '(?<![\\w-])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\\w-])'],
  ['range', 'code', '(?<![\\w-])[0-9a-f]{7,40}\\.{2,3}[0-9a-f]{7,40}(?![\\w-])'],
  ['host', 'code', '(?<![\\w.@/-])(?:[\\w.-]+@)?(?:localhost|\\d{1,3}(?:\\.\\d{1,3}){3})(?::\\d{2,5})?(?:\\/[\\w.@+%*/-]*)?(?![\\w.])'],
  // A folder of a path may have a space in it — the checkout is in 「Brian AI」 — but not
  // the last part, so a path ends where the sentence goes on.
  ['path', 'code', '(?<![\\w.~/:-])(?:~|\\.\\.?)?\\/(?:[\\w.@+%-]+(?: [\\w.@+%-]+)*\\/)*[\\w.@+%*-]+\\/?'],
  ['relative', 'code', '(?<![\\w.@/~:#-])[\\w.@-]+(?:\\/[\\w.@+%*-]*)+'],
  ['file', 'code', `(?<![\\w./@-])(?:[\\w-][\\w*.-]*)?\\.(?:${WORD_EXTENSIONS})(?![\\w-])`],
  ['flag', 'code', `(?<![\\w-])--[A-Za-z][\\w-]*(?:\\*|=${VALUE}+)?`],
  ['constant', 'code', `(?<![\\w-])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+(?:=${VALUE}*)?(?!\\w)`],
  ['commit', 'code', '(?<![\\w-])[0-9a-f]{7,40}(?![\\w-])'],
  ['snake', 'code', '(?<![\\w.-])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\\w-])'],
  ['camel', 'code', '(?<![\\w.-])[a-z][a-z0-9]+(?:[A-Z][a-z0-9]+)+(?![\\w-])']
];
const SHAPE = new RegExp(SHAPES.map(([name, , source]) => `(?<${name}>${source})`).join('|'), 'gu');
const MARK_OF = Object.fromEntries(SHAPES.map(([name, mark]) => [name, mark]));

const hexWord = (value) => /\d/.test(value) && /[a-f]/.test(value);

// Shapes that also fit ordinary words need a second look: a commit has digits and
// letters both, 「Claude/Codex」 is two names rather than a path, and a colour is not a
// requirement number.
function accepted(name, value) {
  if (name === 'commit') return hexWord(value);
  if (name === 'range') return value.split(/\.{2,3}/).every(hexWord);
  if (name === 'colour') return value.length > 5 || /[a-fA-F]/.test(value);
  if (name === 'relative') {
    const last = value.split('/').filter(Boolean).pop() ?? '';
    return FILE_NAME.test(last) || (/[a-z]/.test(value) && !/[A-Z]/.test(value));
  }
  return true;
}

/**
 * Text split into plain runs and the runs to mark, each `{ text, mark }` with mark 'ref'
 * or 'code'. Pure, so it can be tested.
 */
export function highlightRuns(text) {
  const value = String(text ?? '');
  const runs = [];
  let plainFrom = 0;
  SHAPE.lastIndex = 0;
  for (let found = SHAPE.exec(value); found; found = SHAPE.exec(value)) {
    const [name, match] = Object.entries(found.groups).find(([, part]) => part !== undefined);
    // A link or a path ends before the full stop of the sentence around it.
    const token = name === 'url' ? match.replace(/[.,:;!?'"\]}]+$/, '')
      : ['host', 'path', 'relative'].includes(name) ? match.replace(/\.+$/, '') : match;
    if (!token || !accepted(name, token)) {
      SHAPE.lastIndex = found.index + 1;
      continue;
    }
    if (found.index > plainFrom) runs.push({ text: value.slice(plainFrom, found.index) });
    runs.push({ text: token, mark: MARK_OF[name] });
    plainFrom = found.index + token.length;
    SHAPE.lastIndex = plainFrom;
  }
  if (plainFrom < value.length) runs.push({ text: value.slice(plainFrom) });
  return runs;
}

function textNodes(text) {
  return splitInstants(text).flatMap((part) => {
    if (!part.instant) {
      return highlightRuns(part.text).map((run) =>
        run.mark === 'ref' ? el('span', 'mp-mention', run.text)
          : run.mark === 'code' ? el('code', 'mp-code', run.text)
            : document.createTextNode(run.text));
    }
    // The stored value stays in the markup only: it is not a time a person reads, so it
    // is not shown on hover either (Brian 2026-09-25).
    const node = el('time', 'mp-time', part.text);
    node.dateTime = part.instant;
    return [node];
  });
}

// Inline markup: bold, code and links. Everything is built as DOM nodes from text, so no
// author content is ever interpreted as HTML. Code is left exactly as written, timestamps
// included.
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/** Where a link may go: the web, or a path on this site. Anything else is left as text. */
export function safeHref(url) {
  if (/^https?:\/\/\S+$/i.test(url)) return url;
  if (/^\/(?!\/)\S*$/.test(url)) return url;
  return null;
}

/** The inline runs of a line, pure so they can be tested. */
export function inlineRuns(text) {
  return String(text ?? '').split(INLINE).filter((part) => part !== '').map((part) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return { kind: 'strong', text: part.slice(2, -2) };
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return { kind: 'code', text: part.slice(1, -1) };
    const link = LINK.exec(part);
    const href = link && safeHref(link[2]);
    return href ? { kind: 'link', text: link[1], href } : { kind: 'text', text: part };
  });
}

export function inlineNodes(text) {
  return inlineRuns(text).flatMap((run) => {
    if (run.kind === 'strong') {
      const strong = el('strong', '');
      strong.append(...textNodes(run.text));
      return [strong];
    }
    if (run.kind === 'code') return [el('code', 'mp-code', run.text)];
    if (run.kind === 'link') {
      const link = el('a', 'mp-link', run.text);
      link.href = run.href;
      // Another site opens beside this page rather than in place of it.
      if (/^https?:/i.test(run.href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      return [link];
    }
    return textNodes(run.text);
  });
}

function listNode(list) {
  const node = el(list.ordered ? 'ol' : 'ul', 'mp-list');
  if (list.ordered && list.start !== 1) node.start = list.start;
  for (const item of list.items) {
    const entry = el('li', item.checked === null ? '' : 'mp-task');
    if (item.checked !== null) entry.append(el('span', 'mp-task-box', item.checked ? '☑' : '☐'));
    entry.append(...inlineNodes(item.text));
    for (const sub of item.lists) entry.append(listNode(sub));
    node.append(entry);
  }
  return node;
}

function tableNode(block) {
  const cell = (tag, text, index) => {
    const node = el(tag);
    if (block.align[index]) node.style.textAlign = block.align[index];
    node.append(...inlineNodes(text));
    return node;
  };
  const table = el('table', 'mp-prose-table');
  const head = el('thead');
  const headRow = el('tr');
  block.header.forEach((text, index) => headRow.append(cell('th', text, index)));
  head.append(headRow);
  const body = el('tbody');
  for (const cells of block.rows) {
    const row = el('tr');
    cells.forEach((text, index) => row.append(cell('td', text, index)));
    body.append(row);
  }
  table.append(head, body);
  // A wide table scrolls on its own instead of widening the panel it sits in.
  const wrap = el('div', 'mp-table-scroll');
  wrap.append(table);
  return wrap;
}

export function proseNodes(content) {
  const blocks = parseProse(content);
  if (!blocks.length) return [el('div', 'mp-prose', '\u5c1a\u65e0\u3002')];
  return blocks.map((block) => {
    if (block.kind === 'heading') {
      return el(`h${Math.min(block.level + 2, 6)}`, 'mp-prose-heading', block.text);
    }
    if (block.kind === 'quote') {
      const node = el('blockquote', 'mp-quote');
      node.append(...inlineNodes(block.text));
      return node;
    }
    if (block.kind === 'list') return listNode(block);
    if (block.kind === 'table') return tableNode(block);
    if (block.kind === 'rule') return el('hr', 'mp-rule');
    if (block.kind === 'code') {
      const node = el('pre', 'mp-code-block');
      node.append(el('code', '', block.text));
      return node;
    }
    if (block.kind === 'text') {
      const node = el('div', 'mp-prose');
      node.append(...inlineNodes(block.text));
      return node;
    }
    const node = el('div', 'mp-callout mp-callout-' + block.type.toLowerCase());
    if (block.title) node.append(el('div', 'mp-callout-label', block.title));
    if (block.text) {
      const body = el('div', 'mp-callout-body');
      body.append(...inlineNodes(block.text));
      node.append(body);
    }
    return node;
  });
}
