import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, stamp, versionOf } from './asset-versions.mjs';

test('every asset reference in the repository carries the version of its content', () => {
  assert.deepEqual(check(), [], 'run: node deploy/openproject/asset-versions.mjs stamp');
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'asset-versions-'));
  mkdirSync(join(root, 'assets'));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return root;
}

test('stamping settles an import chain: a change deep in it re-versions every file above', () => {
  const root = fixture({
    'nav.rb': `<script src="/evaproject/page.js?v=1"></script>`,
    'assets/page.js': `import { x } from './lib.js?v=1';`,
    'assets/lib.js': `export const x = 1;`
  });
  stamp(root);
  assert.deepEqual(check(root), []);
  const before = readFileSync(join(root, 'nav.rb'), 'utf8');

  writeFileSync(join(root, 'assets/lib.js'), 'export const x = 2;');
  assert.equal(check(root).length, 1, 'only the direct reference is stale before stamping');
  stamp(root);
  assert.deepEqual(check(root), []);
  assert.match(readFileSync(join(root, 'assets/page.js'), 'utf8'), new RegExp(`lib\\.js\\?v=${versionOf('export const x = 2;')}`));
  assert.notEqual(readFileSync(join(root, 'nav.rb'), 'utf8'), before, 'the page entry moved because page.js did');
});

test('an unversioned reference is stale, and a comment naming an asset is not a reference', () => {
  const root = fixture({
    'assets/a.css': `/* art lives at /evaproject/art.png */\n.x { background: url("/evaproject/art.png"); }`,
    'assets/art.png': 'png'
  });
  assert.deepEqual(check(root), [`assets/a.css: /evaproject/art.png: v=(none), content is ${versionOf('png')}`]);
  stamp(root);
  assert.equal(
    readFileSync(join(root, 'assets/a.css'), 'utf8'),
    `/* art lives at /evaproject/art.png */\n.x { background: url("/evaproject/art.png?v=${versionOf('png')}"); }`
  );
});

test('a reference to an asset that does not exist stops the stamp', () => {
  const root = fixture({ 'nav.rb': `<link href="/evaproject/gone.css?v=1">` });
  assert.throws(() => stamp(root), /gone\.css: no such asset/);
});

test('stamping rewrites an initializer in place: its inode is what the container mounts', () => {
  const root = fixture({ 'nav.rb': `<link href="/evaproject/a.css?v=1">`, 'assets/a.css': '' });
  const inode = statSync(join(root, 'nav.rb')).ino;
  stamp(root);
  assert.deepEqual(check(root), []);
  assert.equal(statSync(join(root, 'nav.rb')).ino, inode);
});

test('assets that import each other in a cycle cannot be versioned by content', () => {
  const root = fixture({
    'assets/a.js': `import './b.js';`,
    'assets/b.js': `import './a.js';`
  });
  assert.throws(() => stamp(root), /cycle/);
});
