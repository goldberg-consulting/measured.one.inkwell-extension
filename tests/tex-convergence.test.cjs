const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TexConvergenceCache, texNeedsAnotherPass } = require('../out/tex-convergence');

function fixture(t, maxEntries, maxBytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-tex-convergence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine');
  const style = path.join(root, 'style.sty');
  fs.writeFileSync(engine, 'engine'); fs.writeFileSync(style, 'style');
  const cache = new TexConvergenceCache(maxEntries, maxBytes);
  let sequence = 0;
  const context = (changes = {}) => {
    const directory = path.join(root, `attempt-${sequence++}`);
    fs.mkdirSync(directory);
    const texFile = path.join(directory, 'document.tex');
    fs.writeFileSync(texFile, '\\documentclass{article}\n\\begin{document}Hello\\end{document}');
    return { directory, sourceDirectory: root, sourceFile: path.join(root, 'document.md'),
      sourceHash: 'source', texFile, jobName: 'document', engine,
      engineArgs: ['-recorder', `-output-directory=${directory}`, texFile],
      environment: { TEXINPUTS: directory + ':' + root + ':' }, templateIdentity: 'default', ...changes };
  };
  const produce = (ctx, { aux = '\\relax\n', additional = {}, log = 'Output written on document.pdf', input = style } = {}) => {
    fs.writeFileSync(path.join(ctx.directory, 'document.aux'), aux);
    fs.writeFileSync(path.join(ctx.directory, 'document.log'), log);
    for (const [name, bytes] of Object.entries(additional)) fs.writeFileSync(path.join(ctx.directory, name), bytes);
    fs.writeFileSync(path.join(ctx.directory, 'document.fls'), [
      `PWD ${root}`, `INPUT ${ctx.texFile}`, `INPUT ${input}`,
      ...['document.aux', 'document.log', 'document.pdf', ...Object.keys(additional)].map(name => `OUTPUT ${path.join(ctx.directory, name)}`),
    ].join('\n'));
  };
  const remember = async (changes = {}) => {
    const ctx = context(); const run = await cache.prepare(ctx); produce(ctx, changes);
    await run.rememberPublished('Output written on document.pdf'); return ctx;
  };
  return { root, cache, context, produce, remember, style };
}

test('fresh attempts need two passes; published unchanged auxiliaries converge after one fresh pass', async t => {
  const f = fixture(t), first = f.context(), cold = await f.cache.prepare(first);
  assert.equal(cold.restored, false); f.produce(first);
  assert.equal(await cold.canFinishAfterFirstPass('Output written on document.pdf'), false);
  await cold.rememberPublished('Output written on document.pdf');
  const next = f.context(), warm = await f.cache.prepare(next);
  assert.equal(warm.restored, true);
  assert.equal(fs.readFileSync(path.join(next.directory, 'document.aux'), 'utf8'), '\\relax\n');
  assert.equal(fs.existsSync(path.join(next.directory, 'document.pdf')), false, 'a cached PDF is never restored');
  f.produce(next); assert.equal(await warm.canFinishAfterFirstPass('Output written on document.pdf'), true);
});

test('changed, added, or removed auxiliary bytes require the second pass', async t => {
  const f = fixture(t); await f.remember({ additional: { 'document.toc': 'old toc' } });
  for (const mutation of ['changed', 'added', 'removed']) {
    const ctx = f.context(), warm = await f.cache.prepare(ctx);
    f.produce(ctx, { aux: mutation === 'changed' ? 'new aux' : '\\relax\n',
      additional: mutation === 'removed' ? {} : { 'document.toc': 'old toc', ...(mutation === 'added' ? { 'document.lof': 'figures' } : {}) } });
    assert.equal(await warm.canFinishAfterFirstPass('Output written on document.pdf'), false, mutation);
  }
});

test('rerun and unresolved-reference diagnostics prevent early convergence', async t => {
  const f = fixture(t); await f.remember();
  const ctx = f.context(), warm = await f.cache.prepare(ctx); f.produce(ctx);
  for (const warning of [
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    'Package rerunfilecheck Warning: File document.out has changed.',
    'LaTeX Warning: There were undefined references.',
    'Package biblatex Warning: Please (re)run Biber on the file:',
    'Run LaTeX again.', 'No file document.toc.', 'Labels have changed.', 'multiply-defined labels',
  ]) {
    assert.equal(texNeedsAnotherPass(warning), true, warning);
    assert.equal(await warm.canFinishAfterFirstPass(warning), false, warning);
  }
  assert.equal(texNeedsAnotherPass('Output written on document.pdf'), false);
  assert.equal(texNeedsAnotherPass('Package: rerunfilecheck 2025-06-21 v1.11 Rerun checks for auxiliary files (HO)\nOutput written on document.pdf'), false);
});

test('source, generated TeX, template, engine, and input style changes invalidate auxiliary reuse', async t => {
  const f = fixture(t); await f.remember();
  for (const changes of [{ sourceHash: 'edited' }, { templateIdentity: 'different' }, { environment: { TEXINPUTS: 'changed' } }]) {
    assert.equal((await f.cache.prepare(f.context(changes))).restored, false);
  }
  const ctx = f.context(); fs.appendFileSync(ctx.texFile, 'changed generated body');
  assert.equal((await f.cache.prepare(ctx)).restored, false);
  const stat = fs.statSync(f.style); fs.writeFileSync(f.style, 'STYLE'); fs.utimesSync(f.style, stat.atime, stat.mtime);
  assert.equal((await f.cache.prepare(f.context())).restored, false, 'same-length style bytes with preserved mtime still invalidate');
  fs.writeFileSync(f.style, 'style');
  fs.appendFileSync(f.context().engine, 'new executable');
  assert.equal((await f.cache.prepare(f.context())).restored, false);
});

test('failed or unpublished attempts never replace the last verified auxiliary state', async t => {
  const f = fixture(t); await f.remember();
  const failed = f.context(), run = await f.cache.prepare(failed);
  f.produce(failed, { aux: 'incomplete reference data' });
  assert.equal(await run.canFinishAfterFirstPass('Output written on document.pdf'), false);
  const retry = f.context(); assert.equal((await f.cache.prepare(retry)).restored, true);
  assert.equal(fs.readFileSync(path.join(retry.directory, 'document.aux'), 'utf8'), '\\relax\n');
});

test('unknown, escaping, symlinked and oversized TeX output disables caching', async t => {
  const f = fixture(t);
  for (const kind of ['unknown', 'outside', 'symlink', 'oversized', 'absolute']) {
    const ctx = f.context({ sourceHash: kind }), run = await f.cache.prepare(ctx);
    f.produce(ctx, { aux: kind === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : kind === 'absolute' ? ctx.directory : '\\relax\n',
      additional: kind === 'unknown' ? { 'document.unrecognized-state': 'data' } : {} });
    if (kind === 'outside') fs.appendFileSync(path.join(ctx.directory, 'document.fls'), `\nOUTPUT ${path.join(f.root, 'external.aux')}`);
    if (kind === 'symlink') {
      fs.unlinkSync(path.join(ctx.directory, 'document.aux'));
      fs.symlinkSync(f.style, path.join(ctx.directory, 'document.aux'));
    }
    await run.rememberPublished('Output written on document.pdf');
    assert.equal((await f.cache.prepare(f.context({ sourceHash: kind }))).restored, false, kind);
  }
});

test('cache bounds evict oldest state and purge invalidates already prepared runs', async t => {
  const f = fixture(t, 1, 100);
  await f.remember();
  const other = f.context({ sourceHash: 'other' }), run = await f.cache.prepare(other); f.produce(other);
  await run.rememberPublished('Output written on document.pdf');
  assert.equal((await f.cache.prepare(f.context())).restored, false, 'least recently used state was evicted');
  const pending = f.context({ sourceHash: 'other' }), warm = await f.cache.prepare(pending); f.produce(pending);
  assert.equal(warm.restored, true); f.cache.clear();
  assert.equal(await warm.canFinishAfterFirstPass('Output written on document.pdf'), false);
  await warm.rememberPublished('Output written on document.pdf');
  assert.equal((await f.cache.prepare(f.context({ sourceHash: 'other' }))).restored, false, 'in-flight run cannot undo a purge');
});

test('a missing fresh recorder or log requires another pass', async t => {
  const f = fixture(t); await f.remember();
  for (const extension of ['fls', 'log']) {
    const ctx = f.context(), run = await f.cache.prepare(ctx); f.produce(ctx);
    fs.unlinkSync(path.join(ctx.directory, `document.${extension}`));
    assert.equal(await run.canFinishAfterFirstPass('Output written on document.pdf'), false);
  }
});

test('nested auxiliary restoration cannot follow an escaping directory link', async t => {
  const f = fixture(t), ctx = f.context(), run = await f.cache.prepare(ctx);
  fs.mkdirSync(path.join(ctx.directory, 'chapters'));
  f.produce(ctx, { additional: { 'chapters/first.aux': 'chapter labels' } });
  await run.rememberPublished('Output written on document.pdf');
  const target = path.join(f.root, 'outside'); fs.mkdirSync(target);
  const next = f.context(); fs.symlinkSync(target, path.join(next.directory, 'chapters'));
  assert.equal((await f.cache.prepare(next)).restored, false);
  assert.equal(fs.existsSync(path.join(target, 'first.aux')), false);
  assert.equal(fs.existsSync(path.join(next.directory, 'document.aux')), false, 'partial restoration is rolled back');
});

test('purge during an awaited restore rolls back bytes and cannot resurrect an uncounted cache entry', async t => {
  const f = fixture(t); await f.remember();
  const ctx = f.context(), writeFile = fs.promises.writeFile;
  let cleared = false;
  fs.promises.writeFile = async function(file, ...args) {
    const result = await writeFile.call(this, file, ...args);
    if (file === path.join(ctx.directory, 'document.aux')) { f.cache.clear(); cleared = true; }
    return result;
  };
  let interrupted; try { interrupted = await f.cache.prepare(ctx); } finally { fs.promises.writeFile = writeFile; }
  assert.equal(cleared, true); assert.equal(interrupted.restored, false);
  assert.equal(fs.existsSync(path.join(ctx.directory, 'document.aux')), false);
  assert.equal(f.cache.entries.size, 0); assert.equal(f.cache.bytes, 0);
  const next = f.context(), cold = await f.cache.prepare(next); f.produce(next);
  assert.equal(cold.restored, false); assert.equal(await cold.canFinishAfterFirstPass('Output written on document.pdf'), false);
});
