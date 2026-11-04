import test from 'node:test';
import assert from 'node:assert/strict';
import { focusSnippet, highlightParts, hitHref, matchNote, resultsHref, stepActive } from './assets/search.js';

const marked = parts => parts.filter(part => part.hit).map(part => part.text);

// #218: the words are marked wherever they occur, in the title, the numbers and the snippet.
test('every place a word occurs is marked, whatever its case', () => {
  assert.deepEqual(highlightParts('Search box: search here', ['search']), [
    { text: 'Search', hit: true },
    { text: ' box: ', hit: false },
    { text: 'search', hit: true },
    { text: ' here', hit: false }
  ]);
  assert.deepEqual(marked(highlightParts('顶栏全局搜索：支持全文搜索', ['搜索', '顶栏'])), ['顶栏', '搜索', '搜索']);
});

test('a word inside a longer one does not cut it short', () => {
  assert.deepEqual(marked(highlightParts('需求池页面', ['需求', '需求池'])), ['需求池']);
});

test('a word is taken as text, not as a pattern', () => {
  assert.deepEqual(marked(highlightParts('a.b and axb', ['a.b'])), ['a.b']);
  assert.deepEqual(marked(highlightParts('#57 与 57', ['#57'])), ['#57']);
});

test('text with nothing to mark comes back whole, and no text comes back empty', () => {
  assert.deepEqual(highlightParts('无关的标题', ['搜索']), [{ text: '无关的标题', hit: false }]);
  assert.deepEqual(highlightParts('', ['搜索']), []);
});

test('a result opens on its own page in its project, with it open', () => {
  assert.equal(
    hitHref({ kind: 'requirement', id: 'EVAPROJECT-REQ-20260924-006', workPackageId: 218, project: 'eva-project' }),
    '/projects/eva-project/requirements?open=EVAPROJECT-REQ-20260924-006'
  );
  assert.equal(
    hitHref({ kind: 'handoff', id: 'EVAPROJECT-HO-20260924-001', workPackageId: 219, project: 'eva-project' }),
    '/projects/eva-project/handoff?open=EVAPROJECT-HO-20260924-001'
  );
  assert.equal(hitHref({ kind: 'requirement', id: null, workPackageId: 57, project: 'mila-3' }), '/projects/mila-3/requirements?open=57');
});

test('the results page carries the query in its address', () => {
  assert.equal(resultsHref(' 全文 搜索 '), '/requirements/search?q=%E5%85%A8%E6%96%87%20%E6%90%9C%E7%B4%A2');
});

test('the arrow keys go round the options at either end', () => {
  assert.equal(stepActive(-1, 3, 1), 0);
  assert.equal(stepActive(-1, 3, -1), 2);
  assert.equal(stepActive(2, 3, 1), 0);
  assert.equal(stepActive(0, 3, -1), 2);
  assert.equal(stepActive(-1, 0, 1), -1);
});

test('a match in the body shows the text around it; one only in a comment says so', () => {
  assert.deepEqual(matchNote({ matched: ['title', 'body'], snippet: '…支持全文搜索…' }), { snippet: '…支持全文搜索…' });
  assert.deepEqual(matchNote({ matched: ['title', 'comment'], snippet: null }), { where: '命中评论' });
  assert.equal(matchNote({ matched: ['title'], snippet: null }), null);
});

// The top bar's line is short: a snippet that led with its heading hid the match itself.
test('a snippet on the short line starts just before its first match, never inside a word', () => {
  assert.equal(focusSnippet('用户原文 我们考虑把 Eva-Project 原生的需求池改成我们自己的 GUI', ['需求池']), '…原生的需求池改成我们自己的 GUI');
  assert.equal(focusSnippet('开头就是需求池', ['需求池']), '开头就是需求池');
  assert.equal(focusSnippet('没有命中的片段', ['需求池']), '没有命中的片段');
});
