#!/usr/bin/env node
// Every reference to a file under assets/ carries `?v=<hash of that file's content>`.
//
// Browsers cache these files by URL, so the query string is the only thing that makes a
// changed file reach anyone. It used to be a hand-kept counter: a stylesheet was edited a
// dozen times without its counter moving, the author's self-tests bypassed the cache with
// random query strings, and Brian kept seeing the first version for two rounds. Deriving
// the version from the content removes the step that can be forgotten; `check` (also run
// by the test suite) catches a commit made without running `stamp`.
//
// References are quoted strings starting with `/evaproject/` (the initializers, and CSS
// url()) or `./` (module imports between assets). A hash change is itself a content
// change of the referencing file, so `stamp` repeats until nothing moves: editing
// prose.js re-versions handoff.js and requirements.js, which import it.
//
//   node deploy/openproject/asset-versions.mjs stamp   # rewrite versions in place
//   node deploy/openproject/asset-versions.mjs check   # exit 1 if any version is stale
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(ROOT, 'assets');
const REFERENCE = /(["'])((?:\/evaproject\/|\.\/)[\w./-]+?)(?:\?v=([\w-]*))?\1/g;

export function versionOf(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 10);
}

// The files that may reference assets: the initializers that inject them into the page,
// and the assets themselves. Tests import assets without a version and are left alone.
export function referencingFiles(root = ROOT) {
  const initializers = readdirSync(root).filter((name) => name.endsWith('.rb')).map((name) => join(root, name));
  const assets = walk(join(root, 'assets')).filter((path) => /\.(js|css)$/.test(path));
  return [...initializers, ...assets];
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

function targetOf(reference, from, assets) {
  if (reference.startsWith('/evaproject/')) return join(assets, reference.slice('/evaproject/'.length));
  // A relative reference only means an asset when it is made from inside assets/.
  const target = join(dirname(from), reference);
  return relative(assets, target).startsWith('..') ? null : target;
}

// One pass over one file's text: every reference rewritten to the version its target has
// right now. Returns the new text and what was wrong with the old one.
export function restamp(text, from, { assets = ASSETS, read = readFileSync, exists = existsSync } = {}) {
  const problems = [];
  const next = text.replace(REFERENCE, (whole, quote, reference, version) => {
    const target = targetOf(reference, from, assets);
    if (target === null) return whole;
    if (!exists(target)) {
      problems.push(`${reference}: no such asset`);
      return whole;
    }
    const expected = versionOf(read(target));
    if (version !== expected) problems.push(`${reference}: v=${version ?? '(none)'}, content is ${expected}`);
    return `${quote}${reference}?v=${expected}${quote}`;
  });
  return { text: next, problems };
}

export function check(root = ROOT) {
  const assets = join(root, 'assets');
  return referencingFiles(root).flatMap((path) =>
    restamp(readFileSync(path, 'utf8'), path, { assets }).problems.map((problem) => `${relative(root, path).replaceAll('\\', '/')}: ${problem}`)
  );
}

export function stamp(root = ROOT) {
  const assets = join(root, 'assets');
  const files = referencingFiles(root);
  const changed = new Set();
  // Each round settles at least one more level of the import graph, so a graph with no
  // cycle settles within one round per file. More than that means a cycle, which content
  // versions cannot settle: each file's version would depend on its own.
  for (let round = 0; round <= files.length; round += 1) {
    let moved = false;
    for (const path of files) {
      const before = readFileSync(path, 'utf8');
      const { text, problems } = restamp(before, path, { assets });
      const missing = problems.filter((problem) => problem.endsWith('no such asset'));
      if (missing.length) throw new Error(`${relative(root, path).replaceAll('\\', '/')}: ${missing.join('; ')}`);
      if (text === before) continue;
      // writeFileSync truncates and rewrites the same inode. The .rb files are single-file
      // bind mounts; replacing the inode (as `sed -i` or an editor's save-and-rename does)
      // leaves the container's mount pointing at a deleted file.
      writeFileSync(path, text);
      changed.add(relative(root, path));
      moved = true;
    }
    if (!moved) return [...changed];
  }
  throw new Error('asset versions did not settle: the assets import each other in a cycle');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const command = process.argv[2];
  if (command === 'stamp') {
    const changed = stamp();
    console.log(changed.length ? `restamped:\n  ${changed.join('\n  ')}` : 'all asset versions already match their content');
  } else if (command === 'check') {
    const problems = check();
    if (problems.length) {
      console.error(`stale asset versions — run: node deploy/openproject/asset-versions.mjs stamp\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log('all asset versions match their content');
  } else {
    console.error('usage: asset-versions.mjs stamp|check');
    process.exit(2);
  }
}
