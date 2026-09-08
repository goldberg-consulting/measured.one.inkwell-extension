const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { TemplateAssetCache } = require('../out/template-assets');

function fixture(t, maxEntries, maxBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-template-assets-test-'));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const cache = new TemplateAssetCache(root, maxEntries, maxBytes);
  t.after(() => { cache.clear(); fs.rmSync(root, { recursive: true, force: true }); });
  const add = (name, contents) => { const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file; };
  return { root, source, cache, add };
}

test('built-in support bytes are staged once into independent read-only files', t => {
  const f = fixture(t), file = f.add('class/example.cls', 'class bytes');
  const first = f.cache.acquire(f.source, [file]);
  assert.ok(first); assert.equal(first.cacheHit, false);
  const staged = path.join(first.directory, 'class/example.cls');
  assert.equal(fs.readFileSync(staged, 'utf8'), 'class bytes');
  assert.notEqual(fs.statSync(staged).ino, fs.statSync(file).ino, 'no shared hard links');
  assert.equal(fs.statSync(staged).mode & 0o222, 0); assert.equal(fs.statSync(first.directory).mode & 0o222, 0);
  first.release();
  const copy = fs.copyFileSync; fs.copyFileSync = () => { throw new Error('warm staging must not copy support files'); };
  let warm; try { warm = f.cache.acquire(f.source, [file]); } finally { fs.copyFileSync = copy; }
  assert.ok(warm); assert.equal(warm.cacheHit, true); assert.equal(warm.directory, first.directory); warm.release();
});

test('content fingerprint notices source edits even when size and mtime are unchanged', t => {
  const f = fixture(t), file = f.add('style.sty', 'first');
  const first = f.cache.acquire(f.source, [file]); first.release();
  const stat = fs.statSync(file); fs.writeFileSync(file, 'other'); fs.utimesSync(file, stat.atime, stat.mtime);
  const next = f.cache.acquire(f.source, [file]);
  assert.notEqual(next.fingerprint, first.fingerprint); assert.notEqual(next.directory, first.directory);
  assert.equal(fs.readFileSync(path.join(next.directory, 'style.sty'), 'utf8'), 'other'); next.release();
});

test('modified cached bytes and extra injected resources are never reused', t => {
  const f = fixture(t), file = f.add('style.sty', 'original');
  for (const mutation of ['bytes', 'extra']) {
    const old = f.cache.acquire(f.source, [file]); old.release();
    if (mutation === 'bytes') {
      fs.chmodSync(path.join(old.directory, 'style.sty'), 0o600);
      fs.writeFileSync(path.join(old.directory, 'style.sty'), 'tampered');
      fs.chmodSync(path.join(old.directory, 'style.sty'), 0o400);
    } else {
      fs.chmodSync(old.directory, 0o700); fs.writeFileSync(path.join(old.directory, 'injected.sty'), 'bad'); fs.chmodSync(old.directory, 0o500);
    }
    const next = f.cache.acquire(f.source, [file]);
    assert.equal(next.cacheHit, false); assert.notEqual(next.directory, old.directory);
    assert.equal(fs.readFileSync(path.join(next.directory, 'style.sty'), 'utf8'), 'original');
    assert.equal(fs.existsSync(path.join(next.directory, 'injected.sty')), false); next.release();
  }
});

test('active leases survive eviction and purge without exceeding bounds', t => {
  const f = fixture(t, 1, 50), firstFile = f.add('first.sty', 'first'), secondFile = f.add('second.sty', 'second');
  const first = f.cache.acquire(f.source, [firstFile]);
  assert.equal(f.cache.acquire(f.source, [secondFile]), undefined, 'busy cache falls back rather than evicting an in-use directory');
  f.cache.clear(); assert.equal(fs.existsSync(first.directory), true);
  assert.equal(f.cache.acquire(f.source, [secondFile]), undefined, 'retired active leases count toward bounds');
  first.release(); first.release(); assert.equal(fs.existsSync(first.directory), false);
  const second = f.cache.acquire(f.source, [secondFile]); assert.ok(second); second.release();
  const next = f.cache.acquire(f.source, [firstFile]); assert.ok(next); assert.equal(fs.existsSync(second.directory), false); next.release();
});

test('escaping resources, symbolic links, excess bytes and excess file counts use the copy fallback', t => {
  const f = fixture(t, 2, 10), file = f.add('large.sty', 'too many support bytes');
  assert.equal(f.cache.acquire(f.source, [file]), undefined);
  const external = path.join(f.root, 'outside.sty'); fs.writeFileSync(external, 'x');
  assert.equal(f.cache.acquire(f.source, [external]), undefined);
  const link = path.join(f.source, 'link.sty'); fs.symlinkSync(external, link);
  assert.equal(f.cache.acquire(f.source, [link]), undefined);
  assert.equal(f.cache.acquire(f.source, Array(257).fill(file)), undefined);
});

test('custom templates retain current per-attempt independent copying', t => {
  const f = fixture(t), file = f.add('class/custom.cls', 'custom version one');
  const modulePath = require.resolve('../out/templates'); delete require.cache[modulePath];
  const load = Module._load; Module._load = function(name, ...args) { return name === 'vscode' ? {} : load.call(this, name, ...args); };
  let templates; try { templates = require(modulePath); } finally { Module._load = load; }
  const template = { id: 'custom', dir: f.source, supportingFiles: [file] };
  const one = path.join(f.root, 'attempt-one'), two = path.join(f.root, 'attempt-two');
  const first = templates.copySupportingFiles(template, one); assert.equal(first.directory, one); assert.equal(first.cacheHit, false); first.release();
  fs.writeFileSync(file, 'custom version two');
  const next = templates.copySupportingFiles(template, two); next.release();
  assert.equal(fs.readFileSync(path.join(one, 'class/custom.cls'), 'utf8'), 'custom version one');
  assert.equal(fs.readFileSync(path.join(two, 'class/custom.cls'), 'utf8'), 'custom version two');
  assert.notEqual(fs.statSync(path.join(two, 'class/custom.cls')).ino, fs.statSync(file).ino);
});

test('an entry replaced by an identical read-only outside symlink is rejected without modifying its target', t => {
  const f = fixture(t), source = f.add('style.sty', 'unchanged');
  const first = f.cache.acquire(f.source, [source]); first.release();
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'style.sty'), 'unchanged', { mode: 0o400 }); fs.chmodSync(outside, 0o500);
  fs.chmodSync(first.directory, 0o700); fs.rmSync(first.directory, { recursive: true }); fs.symlinkSync(outside, first.directory);
  const next = f.cache.acquire(f.source, [source]);
  assert.ok(next); assert.equal(next.cacheHit, false); assert.notEqual(next.directory, first.directory); next.release();
  assert.equal(fs.readFileSync(path.join(outside, 'style.sty'), 'utf8'), 'unchanged');
  assert.equal(fs.statSync(outside).mode & 0o222, 0);
  fs.chmodSync(outside, 0o700);
});

test('a replaced cache-root symlink cannot redirect reuse or cleanup outside the original root', t => {
  const f = fixture(t), source = f.add('style.sty', 'unchanged');
  const first = f.cache.acquire(f.source, [source]); first.release();
  const cacheRoot = path.dirname(first.directory), saved = cacheRoot + '-original'; fs.renameSync(cacheRoot, saved);
  const outside = path.join(f.root, 'outside-root'), outsideEntry = path.join(outside, path.basename(first.directory));
  fs.mkdirSync(outsideEntry, { recursive: true }); fs.writeFileSync(path.join(outsideEntry, 'style.sty'), 'unchanged', { mode: 0o400 }); fs.chmodSync(outsideEntry, 0o500);
  fs.symlinkSync(outside, cacheRoot);
  assert.equal(f.cache.acquire(f.source, [source]), undefined);
  f.cache.clear();
  assert.equal(fs.readFileSync(path.join(outsideEntry, 'style.sty'), 'utf8'), 'unchanged');
  assert.equal(fs.statSync(outsideEntry).mode & 0o222, 0);
  fs.unlinkSync(cacheRoot); fs.renameSync(saved, cacheRoot);
  for (const entry of [...f.cache.retired]) f.cache.remove(entry);
  fs.chmodSync(outsideEntry, 0o700);
});
