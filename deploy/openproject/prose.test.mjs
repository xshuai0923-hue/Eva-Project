import test from 'node:test';
import assert from 'node:assert/strict';
import { highlightRuns, inlineRuns, localTime, parseProse, splitInstants } from './assets/prose.js';

test('an alert line and the quoted lines under it become one highlight block', () => {
  assert.deepEqual(parseProse('> [!WARNING] 跨仓库告警\n> 别的 Session 也在动那个仓库。\n> 只 add 自己的文件。'), [
    { kind: 'callout', type: 'WARNING', title: '跨仓库告警', text: '别的 Session 也在动那个仓库。\n只 add 自己的文件。' }
  ]);
});

test('the title is optional and the type is matched case-insensitively', () => {
  assert.deepEqual(parseProse('> [!tip]\n> 先取摘要。'), [
    { kind: 'callout', type: 'TIP', title: '', text: '先取摘要。' }
  ]);
});

test('a plain blockquote becomes a quote block, which is how 用户原文 is written', () => {
  assert.deepEqual(parseProse('## 用户原文\n\n> 创建一个给 codex 的需求'), [
    { kind: 'heading', level: 2, text: '用户原文' },
    { kind: 'quote', text: '创建一个给 codex 的需求' }
  ]);
});

test('consecutive quoted lines are one block, blank quoted lines included', () => {
  assert.deepEqual(parseProse('> 第一句\n>\n> 第二句'), [
    { kind: 'quote', text: '第一句\n\n第二句' }
  ]);
  // A run of bare markers quotes nothing, so nothing is drawn for it.
  assert.deepEqual(parseProse('>\n>'), []);
});

test('a quote splits the text around it instead of swallowing it', () => {
  assert.deepEqual(parseProse('他说：\n> 就按这个来\n然后就散会了。'), [
    { kind: 'text', text: '他说：' },
    { kind: 'quote', text: '就按这个来' },
    { kind: 'text', text: '然后就散会了。' }
  ]);
});

test('an alert still wins over the plain quote, including the lines under it', () => {
  assert.deepEqual(parseProse('> [!NOTE] 注意\n> 正文\n\n> 引用'), [
    { kind: 'callout', type: 'NOTE', title: '注意', text: '正文' },
    { kind: 'quote', text: '引用' }
  ]);
});

test('a markdown heading becomes a heading, and only owns its own line', () => {
  assert.deepEqual(parseProse('### 范围\n在范围内：这一条。'), [
    { kind: 'heading', level: 3, text: '范围' },
    { kind: 'text', text: '在范围内：这一条。' }
  ]);
  // A hash that is not a heading — no space after it — stays text.
  assert.deepEqual(parseProse('#160 是本次要修的'), [{ kind: 'text', text: '#160 是本次要修的' }]);
});

test('text around a block is kept verbatim and split into its own runs', () => {
  assert.deepEqual(parseProse('开头一段。\n\n> [!NOTE] 注意\n> 正文\n\n结尾一段。'), [
    { kind: 'text', text: '开头一段。' },
    { kind: 'callout', type: 'NOTE', title: '注意', text: '正文' },
    { kind: 'text', text: '结尾一段。' }
  ]);
});

test('an alert line directly under another one starts a second block', () => {
  assert.deepEqual(parseProse('> [!CAUTION] 一\n> [!IMPORTANT] 二\n> 二的正文'), [
    { kind: 'callout', type: 'CAUTION', title: '一', text: '' },
    { kind: 'callout', type: 'IMPORTANT', title: '二', text: '二的正文' }
  ]);
});

test('a blank quoted line is kept inside the block but trimmed at its edges', () => {
  assert.deepEqual(parseProse('> [!NOTE] 标题\n>\n> 第一段\n>\n> 第二段\n>'), [
    { kind: 'callout', type: 'NOTE', title: '标题', text: '第一段\n\n第二段' }
  ]);
});

test('empty, blank and nullish content produce no blocks at all', () => {
  for (const content of ['', '   \n\n  ', null, undefined]) assert.deepEqual(parseProse(content), []);
});

test('an unknown alert type is not a highlight block, just a quote of its own text', () => {
  // The same thing GitHub does with an alert type it does not know.
  assert.deepEqual(parseProse('> [!DANGER] 不认识'), [{ kind: 'quote', text: '[!DANGER] 不认识' }]);
});

// --- what authors actually write ---------------------------------------------

test('a paragraph led by an emoji marker becomes a highlight block of that type', () => {
  assert.deepEqual(parseProse('⛔⛔ **部署时只能带这一刀。** Brian 明确要求。'), [
    { kind: 'callout', type: 'CAUTION', title: '', text: '⛔⛔ **部署时只能带这一刀。** Brian 明确要求。' }
  ]);
  assert.equal(parseProse('⚠️ 靠手改 DB 撑住的。')[0].type, 'WARNING');
  assert.equal(parseProse('⭐ 本交接只做一条。')[0].type, 'IMPORTANT');
});

test('a marker in the middle of a sentence is an ordinary character', () => {
  const line = '同一次故障里还查出 #154 / #155，⛔不在本次范围。';
  assert.deepEqual(parseProse(line), [{ kind: 'text', text: line }]);
});

test('only the marked paragraph is lifted out; its neighbours stay plain', () => {
  assert.deepEqual(parseProse('开头一段。\n\n⚠️ 要当心。\n\n结尾一段。'), [
    { kind: 'text', text: '开头一段。' },
    { kind: 'callout', type: 'WARNING', title: '', text: '⚠️ 要当心。' },
    { kind: 'text', text: '结尾一段。' }
  ]);
});

test('a marked paragraph keeps its own line breaks', () => {
  assert.equal(parseProse('⛔ 第一行\n第二行')[0].text, '⛔ 第一行\n第二行');
});

test('a timestamp with its timezone is shown in the reader\'s, with the exact value kept', () => {
  // Written by agents into notes and records, UTC or with an offset (Brian 2026-09-23).
  assert.deepEqual(splitInstants('- 2026-09-23T04:25:15.555Z：状态更新为「待验证/验收」'), [
    { text: '- ' },
    { instant: '2026-09-23T04:25:15.555Z', text: localTime('2026-09-23T04:25:15.555Z') },
    { text: '：状态更新为「待验证/验收」' }
  ]);
  assert.deepEqual(splitInstants('提出时间：2026-09-22T21:22:00+08:00（timestamp）')[1],
    { instant: '2026-09-22T21:22:00+08:00', text: localTime('2026-09-22T21:22:00+08:00') });
  // The same moment, however it was written down, reads the same.
  assert.equal(localTime('2026-09-22T21:22:00+08:00'), localTime('2026-09-22T13:22:00Z'));
});

test('a date alone, or a time that names no timezone, is left as written', () => {
  assert.deepEqual(splitInstants('提出时间：2026-09-22'), [{ text: '提出时间：2026-09-22' }]);
  assert.deepEqual(splitInstants('约 2026-09-22T21:22:00 左右'), [{ text: '约 2026-09-22T21:22:00 左右' }]);
});

// --- a marker where a line starts, not only a paragraph (#208) ----------------

test('lines led by different markers are blocks of their own types', () => {
  // 注意事项 is written as a run of ⛔ and ⚠️ lines with no blank line between them.
  assert.deepEqual(parseProse('⛔ 第一条\n⛔ 第二条\n第二条接着写\n⚠️ 第三条\n⚠️ 第四条'), [
    { kind: 'callout', type: 'CAUTION', title: '', text: '⛔ 第一条\n⛔ 第二条\n第二条接着写' },
    { kind: 'callout', type: 'WARNING', title: '', text: '⚠️ 第三条\n⚠️ 第四条' }
  ]);
});

test('a marked line under plain text is lifted out of it', () => {
  assert.deepEqual(parseProse('背景一句。\n⚠️ 要当心。'), [
    { kind: 'text', text: '背景一句。' },
    { kind: 'callout', type: 'WARNING', title: '', text: '⚠️ 要当心。' }
  ]);
});

test('⛔ or ⚠️ right after the end of a sentence starts a block there', () => {
  assert.deepEqual(parseProse('工作区干净，与 origin/main 一致。⚠️ Codex 也在同一仓库上提交推送。'), [
    { kind: 'text', text: '工作区干净，与 origin/main 一致。' },
    { kind: 'callout', type: 'WARNING', title: '', text: '⚠️ Codex 也在同一仓库上提交推送。' }
  ]);
});

// --- what the text names is marked, in two colours (#208) ---------------------

const marked = (text) => highlightRuns(text).filter((run) => run.mark).map((run) => [run.mark, run.text]);

test('a requirement or handoff named is marked as a reference', () => {
  assert.deepEqual(marked('#201、#203 待验收；见 EVAPROJECT-HO-20260923-004 与 EVAPROJECT-REQ-20260924-001。#75–#132'), [
    ['ref', '#201'], ['ref', '#203'], ['ref', 'EVAPROJECT-HO-20260923-004'], ['ref', 'EVAPROJECT-REQ-20260924-001'],
    ['ref', '#75'], ['ref', '#132']
  ]);
});

test('commits, paths, files and the like are marked as code', () => {
  assert.deepEqual(marked('HEAD 1af8336bc48532ea9215e26a092179513e59bfa6，推送 81edddf..1af8336，含 5e8970e。'), [
    ['code', '1af8336bc48532ea9215e26a092179513e59bfa6'], ['code', '81edddf..1af8336'], ['code', '5e8970e']
  ]);
  assert.deepEqual(marked('新增 deploy/openproject/assets/theme.css（在 chrome.css 之前），与 origin/main 一致；另有 .env、assets.tar.gz。'), [
    ['code', 'deploy/openproject/assets/theme.css'], ['code', 'chrome.css'], ['code', 'origin/main'],
    ['code', '.env'], ['code', 'assets.tar.gz']
  ]);
  // A folder with a space in it stays one path; the sentence after it does not join it.
  assert.deepEqual(marked('仓库 /Users/brian/Documents/Brian AI/Eva-Project，分支 main'), [
    ['code', '/Users/brian/Documents/Brian AI/Eva-Project']
  ]);
  assert.deepEqual(marked('变量 --main-menu-*、--mp-brand，颜色 #c2683f/#00897b，DOCKER_CONTEXT=colima-evaproject。'), [
    ['code', '--main-menu-*'], ['code', '--mp-brand'], ['code', '#c2683f'], ['code', '#00897b'],
    ['code', 'DOCKER_CONTEXT=colima-evaproject']
  ]);
  assert.deepEqual(marked('本机 localhost:28080，服务器 operator@192.0.2.10:22，生产 http://192.0.2.10:8080。'), [
    ['code', 'localhost:28080'], ['code', 'operator@192.0.2.10:22'], ['code', 'http://192.0.2.10:8080']
  ]);
  assert.deepEqual(marked('来源 Session：8914b537-fd1f-491f-b607-14f43c315eea。'), [
    ['code', '8914b537-fd1f-491f-b607-14f43c315eea']
  ]);
  assert.deepEqual(marked('改 fetchStream 与 handoff_latest 的 page_size'), [
    ['code', 'fetchStream'], ['code', 'handoff_latest'], ['code', 'page_size']
  ]);
});

test('a colour is code even when all its digits are numbers; a requirement number is short', () => {
  assert.deepEqual(marked('深色以 #141413 为底，次按钮 #252320，按下 #a9583e；见 #203 与 #12345。'), [
    ['code', '#141413'], ['code', '#252320'], ['code', '#a9583e'], ['ref', '#203'], ['ref', '#12345']
  ]);
});

test('ordinary words, names, numbers and dates are left as written', () => {
  const plain = 'Partner（Claude/Codex）、iOS、macOS、iPhone、OpenProject、GitHub、N/A、TCP/IP、'
    + '2026/09/24、17.8.0、20260924、deadbeef、p50 3.6 秒、第 2 页、分支 main';
  assert.deepEqual(highlightRuns(plain), [{ text: plain }]);
});

test('marking keeps every character in place', () => {
  const text = '见 #203：提交 5e8970e 改了 theme.css，⚠️ 与 origin/main 一致。';
  assert.equal(highlightRuns(text).map((run) => run.text).join(''), text);
});

// --- the rest of what a body carries: tables, code, lists, rules, links (#267) -

test('a table becomes a table: header, alignment and rows', () => {
  const body = '| Provider 类型 | 运行位置 | 本 Bug 的关系 |\n| --- | :---: | ---: |\n' +
    '| 本地 Plugin Codex | 用户本机 | **取证对象** |\n| Runtime Provider Codex | Runtime | `待查` |';
  assert.deepEqual(parseProse(body), [{
    kind: 'table',
    header: ['Provider 类型', '运行位置', '本 Bug 的关系'],
    align: [null, 'center', 'right'],
    rows: [['本地 Plugin Codex', '用户本机', '**取证对象**'], ['Runtime Provider Codex', 'Runtime', '`待查`']]
  }]);
});

test('a table needs its delimiter row; a pipe in a sentence is only a character', () => {
  assert.deepEqual(parseProse('A | B 两种都行'), [{ kind: 'text', text: 'A | B 两种都行' }]);
  // A pipe inside a cell is written \|, and a short row is padded out.
  assert.deepEqual(parseProse('| 命令 | 说明 |\n|---|---|\n| a \\| b |')[0].rows, [['a | b', '']]);
});

test('a fenced block is code, kept exactly as written', () => {
  const inside = '[\n  { "sha": "81f96f2" },\n> 不是引用\n| 不是表 |\n- 不是列表\n]';
  assert.deepEqual(parseProse('完成时间：见下\n\n```json\n' + inside + '\n```\n\n之后一段'), [
    { kind: 'text', text: '完成时间：见下' },
    { kind: 'code', lang: 'json', text: inside },
    { kind: 'text', text: '之后一段' }
  ]);
  // An unclosed fence runs to the end.
  assert.deepEqual(parseProse('```\n一行'), [{ kind: 'code', lang: '', text: '一行' }]);
});

test('list items become a list, the blank lines between them included', () => {
  // 来源 is written this way.
  assert.deepEqual(parseProse('- 项目：eva-project\n\n- 提出者：人 / Brian\n\n- 可见性：公开'), [{
    kind: 'list', ordered: false, start: 1,
    items: [
      { text: '项目：eva-project', checked: null, lists: [] },
      { text: '提出者：人 / Brian', checked: null, lists: [] },
      { text: '可见性：公开', checked: null, lists: [] }
    ]
  }]);
});

test('a numbered list keeps its start, nests by indentation and carries indented lines on', () => {
  assert.deepEqual(parseProse('3. 第三步\n   接着写\n   - 细节一\n   - 细节二\n4. 第四步'), [{
    kind: 'list', ordered: true, start: 3,
    items: [
      { text: '第三步\n接着写', checked: null, lists: [{ ordered: false, start: 1, items: [
        { text: '细节一', checked: null, lists: [] }, { text: '细节二', checked: null, lists: [] }
      ] }] },
      { text: '第四步', checked: null, lists: [] }
    ]
  }]);
});

test('a task item says whether it is ticked, and text after the list is a paragraph again', () => {
  assert.deepEqual(parseProse('- [x] 已完成的\n- [ ] 没完成的\n\n之后一段'), [
    { kind: 'list', ordered: false, start: 1, items: [
      { text: '已完成的', checked: true, lists: [] }, { text: '没完成的', checked: false, lists: [] }
    ] },
    { kind: 'text', text: '之后一段' }
  ]);
});

test('a rule is a rule, and a heading after it still owns its line', () => {
  assert.deepEqual(parseProse('上面\n\n---\n\n### 下面\n正文'), [
    { kind: 'text', text: '上面' }, { kind: 'rule' },
    { kind: 'heading', level: 3, text: '下面' }, { kind: 'text', text: '正文' }
  ]);
});

test('a link goes to the web or to this site, and nowhere else', () => {
  assert.deepEqual(inlineRuns('见 [PR](https://github.com/x/y/pull/1) 与 [需求池](/requirements)'), [
    { kind: 'text', text: '见 ' }, { kind: 'link', text: 'PR', href: 'https://github.com/x/y/pull/1' },
    { kind: 'text', text: ' 与 ' }, { kind: 'link', text: '需求池', href: '/requirements' }
  ]);
  for (const href of ['javascript:alert(1)', '//evil.example/x', 'data:text/html,x']) {
    const runs = inlineRuns(`[点我](${href})`);
    assert.ok(runs.every((run) => run.kind === 'text'), href);
    assert.equal(runs.map((run) => run.text).join(''), `[点我](${href})`);
  }
});
