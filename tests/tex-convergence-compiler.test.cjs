const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');
const { resolveDocumentConfig } = require('../out/document-config');

function fixture(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-convergence-compiler-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, `document.${mode === 'pandoc' ? 'md' : 'tex'}`);
  const engine = path.join(root, 'xelatex'); fs.writeFileSync(engine, 'engine');
  fs.writeFileSync(path.join(root, 'pandoc'), 'pandoc');
  fs.writeFileSync(path.join(root, 'biber'), 'biber');
  fs.writeFileSync(path.join(root, 'bibtex'), 'bibtex');
  const templatePath = path.join(root, 'template.tex'); fs.writeFileSync(templatePath, '$body$');
  const style = path.join(root, 'layout.sty'); fs.writeFileSync(style, 'style');
  fs.writeFileSync(source, mode === 'pandoc' ? '# Test' : '\\documentclass{article}');
  const controls = { auxiliary: '\\relax\n', warning: '', failure: false, missingPdf: false, invalidPdf: false, rawBibliography: false };
  const calls = [];
  const environments = [];
  const template = { id: 'test', dir: root, pandocTemplate: templatePath, manifest: { name: 'Test', engine: 'xelatex' } };
  const stubs = {
    vscode: {},
    os: { ...os, tmpdir: () => path.join(root, 'cache') },
    './config': { getInkwellProjectRoot: () => root, findDefaultsYaml: () => undefined,
      getDocumentConfig: (text, sourcePath) => resolveDocumentConfig({ text, sourcePath }),
      getResolvedReferences: config => require('../out/bibliography-service').resolveBibliographyConfiguration(config, source, root) },
    './templates': { getTemplateForDocument: () => template, copySupportingFiles() {}, collectAllFeatures: () => [] },
    './inject': { prepareForCompilation: text => ({ injected: text, unresolvedVars: [] }) },
    './preamble': { generatePreambleText: () => '' },
    './shell-env': { buildTexInvocationPath: () => root, texBinSearchDirs: () => [root] },
    './toolchain': { tlmgrPackageForFile: () => undefined },
    './inkwell-output': { getInkwellOutputChannel: () => ({ appendLine() {} }) },
    './diagnostics': {},
    './run-process': { executeRunProcess: async (binary, args, options) => {
      const name = path.basename(binary); calls.push(name);
      environments.push(options.env);
      if (name === 'pandoc') {
        fs.writeFileSync(args[args.indexOf('-o') + 1], '\\documentclass{article}\n\\begin{document}Hello\\end{document}' + (controls.rawBibliography ? '\\bibliography{refs}' : ''));
      } else if (name === 'xelatex') {
        assert.ok(args.includes('-recorder'));
        const directory = args.find(arg => arg.startsWith('-output-directory=')).slice('-output-directory='.length);
        if (!controls.missingPdf) fs.writeFileSync(path.join(directory, 'document.pdf'), controls.invalidPdf ? '%PDF-1.4\ntruncated' : `%PDF-1.4\nfresh pass ${calls.length}\n%%EOF\n`);
        fs.writeFileSync(path.join(directory, 'document.aux'), controls.auxiliary);
        fs.writeFileSync(path.join(directory, 'document.log'), controls.warning || 'Output written on document.pdf');
        fs.writeFileSync(path.join(directory, 'document.fls'), [`PWD ${root}`, `INPUT ${args.at(-1)}`, `INPUT ${style}`,
          ...['document.aux', 'document.log', 'document.pdf'].map(file => `OUTPUT ${path.join(directory, file)}`)].join('\n'));
      }
      return { stdout: '', stderr: controls.failure ? 'fresh engine failure' : '', exitCode: controls.failure && name === 'xelatex' ? 1 : 0,
        signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
    } },
  };
  const originalLoad = Module._load, compilerFile = require.resolve('../out/compiler'); delete require.cache[compilerFile];
  Module._load = function(request, ...args) { return Object.hasOwn(stubs, request) ? stubs[request] : originalLoad.call(this, request, ...args); };
  let compiler; try { compiler = require(compilerFile); } finally { Module._load = originalLoad; }
  const document = { uri: { fsPath: source }, version: 1, getText: () => fs.readFileSync(source, 'utf8') };
  return { ...compiler, root, source, style, controls, calls, environments, document };
}

for (const mode of ['pandoc', 'xelatex']) {
  test(`${mode}: frozen editor document properties can be captured for compilation`, async t => {
    const f = fixture(t, mode), frozen = Object.freeze({ ...f.document });
    const compiled = await f.compile(frozen);
    assert.equal(compiled.success, true); assert.equal(compiled.sourceVersion, 1);
    assert.equal(compiled.lastSuccessfulOutput.sourceVersion, 1);
  });

  test(`${mode}: template support lookups preserve inherited bibliography and style search paths`, async t => {
    const before = { BIBINPUTS: process.env.BIBINPUTS, BSTINPUTS: process.env.BSTINPUTS };
    process.env.BIBINPUTS = '/external/bibliographies:/external/more-bibliographies';
    process.env.BSTINPUTS = '/external/styles';
    let f;
    try { f = fixture(t, mode); } finally {
      for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
    assert.equal((await f.compile(f.document)).success, true);
    for (const environment of f.environments) {
      assert.match(environment.BIBINPUTS, /\/external\/bibliographies:\/external\/more-bibliographies:/);
      assert.match(environment.BSTINPUTS, /\/external\/styles:/);
    }
  });

  test(`${mode}: a converged warm compile runs fresh TeX, records measured phases, and purge resets it`, async t => {
    const f = fixture(t, mode);
    const cold = await f.compile(f.document), before = fs.readFileSync(cold.pdfPath);
    assert.equal(cold.success, true); assert.equal(cold.texPasses, 2); assert.equal(cold.cacheHits.texAuxiliary, false);
    const warm = await f.compile(f.document);
    assert.equal(warm.success, true); assert.equal(warm.texPasses, 1); assert.equal(warm.cacheHits.texAuxiliary, true);
    assert.notDeepEqual(fs.readFileSync(warm.pdfPath), before, 'warm compile publishes freshly produced bytes');
    assert.ok(warm.passReasons.includes('verified-auxiliary-convergence'));
    for (const [phase, duration] of Object.entries(warm.phaseTimingsMs)) assert.ok(Number.isFinite(duration) && duration >= 0, phase);
    assert.ok(warm.phaseTimingsMs.tex > 0); assert.ok(warm.phaseTimingsMs.publication > 0);
    assert.ok(Math.abs(warm.phaseTimingsMs.total - Object.entries(warm.phaseTimingsMs).filter(([phase]) => phase !== 'total').reduce((sum, [, duration]) => sum + duration, 0)) < .001);
    f.purgeAllCacheDirs();
    assert.equal((await f.compile(f.document)).texPasses, 2);
  });

  test(`${mode}: changed auxiliaries and rerun warnings retain the second standard pass`, async t => {
    const f = fixture(t, mode); await f.compile(f.document);
    f.controls.auxiliary = 'changed labels';
    assert.equal((await f.compile(f.document)).texPasses, 2);
    f.controls.warning = 'LaTeX Warning: Rerun to get cross-references right.';
    assert.equal((await f.compile(f.document)).texPasses, 2);
  });

  test(`${mode}: a failed fresh warm pass preserves PDF and cannot poison the verified auxiliary cache`, async t => {
    const f = fixture(t, mode), cold = await f.compile(f.document), before = fs.readFileSync(cold.pdfPath);
    f.controls.failure = true; f.controls.auxiliary = 'partial corrupt labels';
    const failed = await f.compile(f.document);
    assert.equal(failed.success, false); assert.equal(failed.texPasses, 1); assert.equal(failed.cacheHits.texAuxiliary, true);
    assert.deepEqual(fs.readFileSync(cold.pdfPath), before);
    f.controls.failure = false; f.controls.auxiliary = '\\relax\n';
    assert.equal((await f.compile(f.document)).texPasses, 1, 'retry still restores only the earlier good auxiliaries');
  });

  test(`${mode}: missing or invalid fresh PDFs cannot reuse prior published PDF bytes`, async t => {
    const f = fixture(t, mode), good = await f.compile(f.document), before = fs.readFileSync(good.pdfPath);
    f.controls.missingPdf = true;
    const missing = await f.compile(f.document);
    assert.equal(missing.success, false); assert.equal(missing.texPasses, 1); assert.equal(missing.phase, 'validation');
    assert.deepEqual(fs.readFileSync(good.pdfPath), before);
    f.controls.missingPdf = false; f.controls.invalidPdf = true;
    assert.equal((await f.compile(f.document)).success, false);
    assert.deepEqual(fs.readFileSync(good.pdfPath), before);
  });

  test(`${mode}: source and style edits invalidate warm auxiliary state`, async t => {
    const f = fixture(t, mode); await f.compile(f.document);
    fs.appendFileSync(f.source, '\nchanged'); f.document.version++;
    assert.equal((await f.compile(f.document)).texPasses, 2);
    fs.writeFileSync(f.style, 'other style');
    assert.equal((await f.compile(f.document)).texPasses, 2);
  });

  test(`${mode}: raw bibliography work always retains both standard and both follow-up passes`, async t => {
    const f = fixture(t, mode); f.controls.rawBibliography = true;
    if (mode === 'xelatex') fs.appendFileSync(f.source, '\\bibliography {refs}');
    for (let i = 0; i < 2; i++) {
      const result = await f.compile(f.document);
      assert.equal(result.success, true); assert.equal(result.texPasses, 4); assert.equal(result.cacheHits.texAuxiliary, false);
      assert.ok(result.passReasons.includes('raw-bibliography-required'));
    }
    assert.equal(f.calls.filter(name => name === 'biber').length, 2);
  });
}
