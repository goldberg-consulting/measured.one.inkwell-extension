const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { promisify } = require('node:util');
const { resolveDocumentConfig } = require('../out/document-config');

const GOOD_PDF = Buffer.from('%PDF-1.4\nprevious successful document\n%%EOF\n');
const NEW_PDF = Buffer.from('%PDF-1.4\nnew successful document\n%%EOF\n');

function fixture(t, mode, behavior) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-compiler-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, `document.${mode === 'pandoc' ? 'md' : 'tex'}`);
  const publicPdf = path.join(dir, 'document.pdf');
  const templatePath = path.join(dir, 'template.tex');
  fs.writeFileSync(source, mode === 'pandoc' ? '# Test' : '\\documentclass{article}');
  fs.writeFileSync(templatePath, '$body$');
  fs.writeFileSync(publicPdf, GOOD_PDF);
  const calls = [];
  const execFile = () => { throw new Error('Expected promisified process call'); };
  execFile[promisify.custom] = async (command, args, options) => {
    if (command === 'which') return { stdout: `/fake/${args[0]}\n`, stderr: '' };
    const call = { command: path.basename(command), args, options };
    calls.push(call);
    return behavior(call, calls);
  };
  const template = { id: 'test', dir, pandocTemplate: templatePath, manifest: { name: 'Test', engine: 'xelatex' } };
  const stubs = {
    vscode: { window: { createOutputChannel: () => ({ appendLine() {} }) } },
    child_process: { execFile },
    './run-process': { executeRunProcess: async (command, args, options) => {
      try {
        const result = await execFile[promisify.custom](command, args, options);
        return { ...result, exitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
      } catch (error) {
        return { stdout: error.stdout || '', stderr: error.stderr || '', error: error.message,
          exitCode: typeof error.code === 'number' ? error.code : 1, signal: error.signal || null,
          timedOut: error.code === 'ETIMEDOUT', cancelled: false, maxBufferExceeded: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' };
      }
    } },
    os: { ...os, tmpdir: () => path.join(dir, 'cache') },
    './config': { getInkwellProjectRoot: () => dir, findDefaultsYaml: () => undefined,
      getDocumentConfig: (text, sourcePath) => resolveDocumentConfig({ text, sourcePath }),
      getResolvedReferences: config => ({ bibliography: [], csl: undefined, scope: config.references.scope, linkCitations: config.references.linkCitations, diagnostics: [] }),
    },
    './templates': { getTemplateForDocument: () => template, copySupportingFiles() {}, collectAllFeatures: () => [] },
    './inject': { prepareForCompilation: (text) => ({ injected: text, unresolvedVars: [] }) },
    './preamble': { generatePreambleText: () => '' },
    './shell-env': { buildTexInvocationPath: () => '/fake', texBinSearchDirs: () => [] },
    './toolchain': { tlmgrPackageForFile: () => undefined },
    './inkwell-output': { getInkwellOutputChannel: () => ({ appendLine() {} }) },
    './diagnostics': {},
  };
  const modulePath = require.resolve('../out/compiler.js');
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return Object.hasOwn(stubs, request) ? stubs[request] : originalLoad.call(this, request, ...rest);
  };
  let compiler;
  try { compiler = require(modulePath); } finally { Module._load = originalLoad; }
  const document = { uri: { fsPath: source }, version: 7, getText: () => fs.readFileSync(source, 'utf8') };
  return { ...compiler, dir, source, publicPdf, document, calls };
}

function produce(call, contents = NEW_PDF) {
  if (call.command === 'pandoc') {
    const tex = call.args[call.args.indexOf('-o') + 1];
    fs.writeFileSync(tex, '\\documentclass{article}\n\\begin{document}Test\\end{document}');
    return;
  }
  const outputDir = call.args.find((arg) => arg.startsWith('-output-directory=')).split('=').slice(1).join('=');
  fs.writeFileSync(path.join(outputDir, 'document.pdf'), contents);
  fs.writeFileSync(path.join(outputDir, 'document.log'), 'engine log from this attempt');
}

function failure(code = 1) {
  return Object.assign(new Error('mock process failed'), { code, stdout: 'partial process output', stderr: 'fatal mock failure' });
}

for (const mode of ['xelatex', 'pandoc']) {
  test(`${mode}: failed compile preserves the previous PDF byte-for-byte`, async (t) => {
    const f = fixture(t, mode, async () => { throw failure(); });
    await f.compile(f.document);
    assert.equal(fs.existsSync(f.publicPdf), true, 'last successful PDF must remain present');
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  });

  test(`${mode}: nonzero process cannot publish its partial PDF`, async (t) => {
    const f = fixture(t, mode, async (call) => {
      produce(call);
      if (call.command !== 'pandoc') throw failure();
      return { stdout: '', stderr: '' };
    });
    const result = await f.compile(f.document);
    assert.equal(result.success, false, 'PDF existence does not override a failed process');
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  });
}

test('Pandoc callback failure is authoritative even when it leaves a TeX file', async (t) => {
  const f = fixture(t, 'pandoc', async (call) => {
    produce(call);
    if (call.command === 'pandoc') throw failure();
    return { stdout: '', stderr: '' };
  });
  const result = await f.compile(f.document);
  assert.equal(result.success, false);
  assert.equal(f.calls.filter((call) => call.command === 'xelatex').length, 0);
  assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
});

test('a later TeX pass failure cannot publish an earlier pass PDF', async (t) => {
  const f = fixture(t, 'xelatex', async (call, calls) => {
    produce(call);
    if (calls.length === 2) throw failure();
    return { stdout: '', stderr: '' };
  });
  const result = await f.compile(f.document);
  assert.equal(result.success, false);
  assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
});

for (const mode of ['xelatex', 'pandoc']) {
  test(`${mode}: an exit-zero process with no new PDF cannot reuse a sibling PDF`, async (t) => {
    const f = fixture(t, mode, async (call) => {
      if (call.command === 'pandoc') produce(call);
      return { stdout: '', stderr: '' };
    });
    const result = await f.compile(f.document);
    assert.equal(result.success, false);
    assert.equal(result.phase, 'validation');
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  });

  test(`${mode}: truncated PDF is rejected after successful process exit`, async (t) => {
    const f = fixture(t, mode, async (call) => {
      produce(call, Buffer.from('%PDF-1.4\ntruncated output without final marker'));
      return { stdout: '', stderr: '' };
    });
    const result = await f.compile(f.document);
    assert.equal(result.success, false);
    assert.equal(result.phase, 'validation');
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  });

  test(`${mode}: successful publication records provenance and retains it after failure`, async (t) => {
    let shouldFail = false;
    const f = fixture(t, mode, async (call) => {
      produce(call);
      if (shouldFail) throw failure(12);
      return { stdout: 'complete process output', stderr: '' };
    });
    const success = await f.compile(f.document);
    assert.equal(success.success, true);
    assert.equal(success.phase, 'complete');
    assert.equal(success.exitCode, 0);
    assert.deepEqual(fs.readFileSync(f.publicPdf), NEW_PDF);
    assert.equal(success.lastSuccessfulOutput.sourceVersion, 7);
    assert.match(success.lastSuccessfulOutput.sourceHash, /^[a-f0-9]{64}$/);
    assert.ok(Number.isFinite(Date.parse(success.lastSuccessfulOutput.publishedAt)));
    assert.deepEqual(f.readLastSuccessfulOutput(f.source), success.lastSuccessfulOutput);
    shouldFail = true;
    f.document.version = 8;
    const failed = await f.compile(f.document);
    assert.equal(failed.success, false);
    assert.equal(failed.sourceVersion, 8);
    assert.equal(failed.exitCode, 12);
    assert.deepEqual(failed.lastSuccessfulOutput, success.lastSuccessfulOutput);
    assert.deepEqual(fs.readFileSync(f.publicPdf), NEW_PDF);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /partial process output/);
    assert.match(fs.readFileSync(failed.logPath, 'utf8'), /fatal mock failure/);
    assert.notEqual(path.dirname(success.logPath), path.dirname(failed.logPath));
    fs.writeFileSync(f.publicPdf, GOOD_PDF);
    assert.equal(f.readLastSuccessfulOutput(f.source), undefined, 'externally replaced bytes invalidate provenance');
  });
}

for (const error of [
  Object.assign(failure(null), { signal: 'SIGTERM', killed: true }),
  Object.assign(failure('ERR_CHILD_PROCESS_STDIO_MAXBUFFER'), { killed: true }),
  Object.assign(failure('ETIMEDOUT'), { killed: true }),
]) {
  test(`process ${error.signal || error.code} never publishes a partial PDF`, async (t) => {
    const f = fixture(t, 'xelatex', async (call) => { produce(call); throw error; });
    const result = await f.compile(f.document);
    assert.equal(result.success, false);
    assert.equal(result.phase, 'tex');
    assert.equal(result.exitCode, null);
    assert.equal(result.signal, error.signal);
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  });
}

test('publication uses a same-directory rename and retains the old bytes if rename fails', async (t) => {
  const f = fixture(t, 'xelatex', async (call) => {
    produce(call);
    return { stdout: '', stderr: '' };
  });
  const rename = fs.renameSync;
  let attempted = false;
  fs.renameSync = function (source, destination) {
    if (destination === f.publicPdf) {
      attempted = true;
      assert.equal(path.dirname(source), path.dirname(destination));
      assert.deepEqual(fs.readFileSync(destination), GOOD_PDF, 'public bytes stay untouched until atomic promotion');
      assert.deepEqual(fs.readFileSync(source), NEW_PDF);
      throw new Error('mock rename denied');
    }
    return rename.apply(this, arguments);
  };
  let result;
  try { result = await f.compile(f.document); } finally { fs.renameSync = rename; }
  assert.equal(attempted, true);
  assert.equal(result.success, false);
  assert.equal(result.phase, 'publication');
  assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  assert.equal(fs.readdirSync(f.dir).some((name) => name.endsWith('.tmp')), false);
});

test('failure to persist metadata cannot report failure after publishing a valid PDF', async (t) => {
  const f = fixture(t, 'xelatex', async (call) => {
    produce(call);
    return { stdout: '', stderr: '' };
  });
  const rename = fs.renameSync;
  fs.renameSync = function (source, destination) {
    if (destination.endsWith('.json')) throw new Error('mock metadata write denied');
    return rename.apply(this, arguments);
  };
  let result;
  try { result = await f.compile(f.document); } finally { fs.renameSync = rename; }
  assert.equal(result.success, true);
  assert.deepEqual(fs.readFileSync(f.publicPdf), NEW_PDF);
  assert.equal(result.lastSuccessfulOutput.sourceVersion, 7);
  assert.match(result.log, /Could not persist output metadata/);
});

test('compilation captures the source revision before asynchronous work', async (t) => {
  const f = fixture(t, 'xelatex', async (call) => {
    f.document.version = 9;
    fs.writeFileSync(f.source, 'edited while compiling');
    produce(call);
    return { stdout: '', stderr: '' };
  });
  const result = await f.compile(f.document);
  assert.equal(result.success, true);
  assert.equal(result.sourceVersion, 7);
  assert.equal(result.lastSuccessfulOutput.sourceVersion, 7);
  const stagedSource = f.calls[0].args.at(-1);
  assert.equal(fs.readFileSync(stagedSource, 'utf8'), '\\documentclass{article}');
});

test('a newer compile request cannot receive an older source revision result', async (t) => {
  const f = fixture(t, 'xelatex', async call => { produce(call); return { stdout: '', stderr: '' }; });
  const first = f.compile(f.document);
  f.document.version = 8;
  fs.writeFileSync(f.source, 'new source');
  const second = f.compile(f.document);
  const [oldResult, newResult] = await Promise.all([first, second]);
  assert.equal(oldResult.sourceVersion, 7);
  assert.equal(newResult.sourceVersion, 8);
  assert.equal(newResult.success, true);
  assert.equal(f.calls.length, 4);
  assert.equal(f.readLastSuccessfulOutput(f.source).sourceVersion, 8);
});

test('preflight exceptions return a structured failure and release the compile lock', async (t) => {
  const f = fixture(t, 'pandoc', async () => ({ stdout: '', stderr: '' }));
  fs.unlinkSync(path.join(f.dir, 'template.tex'));
  const result = await f.compile(f.document);
  assert.equal(result.success, false);
  assert.equal(result.phase, 'preflight');
  assert.equal(result.exitCode, null);
  assert.ok(fs.existsSync(result.logPath));
  assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
  const retry = await f.compile(f.document);
  assert.notEqual(retry.logPath, result.logPath, 'settled attempt was removed from the compile lock');
});

for (const mode of ['xelatex', 'pandoc']) {
  test(`${mode}: bibliography failure cannot publish a previous TeX-pass PDF`, async (t) => {
    const f = fixture(t, mode, async (call) => {
      if (call.command === 'biber' || call.command === 'bibtex') throw failure(3);
      produce(call);
      if (call.command === 'pandoc') fs.appendFileSync(call.args[call.args.indexOf('-o') + 1], '\\bibliography{refs}');
      return { stdout: '', stderr: '' };
    });
    if (mode === 'xelatex') fs.appendFileSync(f.source, '\\bibliography{refs}');
    const result = await f.compile(f.document);
    assert.equal(result.success, false);
    assert.equal(result.phase, 'bibliography');
    assert.equal(result.exitCode, 3);
    assert.deepEqual(fs.readFileSync(f.publicPdf), GOOD_PDF);
    assert.equal(f.calls.at(-1).command, 'biber', 'do not run subsequent passes after bibliography failure');
  });
}
