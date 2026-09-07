const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { promisify } = require('node:util');

const settings = {};
const vscode = {
  Uri: { file: fsPath => ({ fsPath }) },
  workspace: { getWorkspaceFolder: () => undefined, getConfiguration: () => ({ get: key => settings[key] }) },
  window: { createOutputChannel: () => ({ appendLine() {} }) },
};
const originalLoad = Module._load;
Module._load = function(request, ...rest) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, ...rest);
};
const config = require('../out/config');
const documentConfig = require('../out/document-config');
const runner = require('../out/runner');
const inject = require('../out/inject');
// Keep citation rendering entirely local and deterministic for behavioral tests.
Module._load = function(request, ...rest) {
  if (request === 'vscode') return vscode;
  if (request === './shell-env') return { findBinaryViaShell: () => undefined };
  return originalLoad.call(this, request, ...rest);
};
const citations = require('../out/citations');
Module._load = originalLoad;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-consumer-config-'));
  fs.mkdirSync(path.join(root, '.inkwell'), { recursive: true });
  fs.mkdirSync(path.join(root, 'chapters'));
  const source = path.join(root, 'chapters', 'document.md');
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const key of Object.keys(settings)) delete settings[key];
  });
  return { root, source, write };
}
const markdown = yaml => `---\n${yaml}\n---\n\n# Document\n\n[@declared; @discovered]\n`;
const bib = key => `@book{${key}, author={Doe, Jane}, title={${key}}, year={2020}}`;

function loadCompiler(f) {
  const calls = [];
  const templatePath = f.write('template.tex', '$for(header-includes)$\n$header-includes$\n$endfor$\n$body$');
  const execFile = () => { throw new Error('Use observed compile adapter'); };
  execFile[promisify.custom] = async (_command, args) => ({ stdout: `/fake/${args[0]}\n`, stderr: '' });
  const stubs = {
    vscode,
    child_process: { execFile },
    os: { ...os, tmpdir: () => path.join(f.root, 'cache') },
    './templates': { getTemplateForDocument: () => ({ id: 'default', dir: f.root, pandocTemplate: templatePath,
      manifest: { name: 'Default', engine: 'xelatex' } }), copySupportingFiles() {}, collectAllFeatures: () => [] },
    './shell-env': { buildTexInvocationPath: () => '/fake', texBinSearchDirs: () => [] },
    './toolchain': { tlmgrPackageForFile: () => undefined },
    './run-process': { executeRunProcess: async (command, args, options) => {
      calls.push({ command: path.basename(command), args, options });
      if (path.basename(command) === 'pandoc') fs.writeFileSync(args[args.indexOf('-o') + 1], '\\documentclass{article}\n\\begin{document}Text\\end{document}');
      else {
        const directory = args.find(arg => arg.startsWith('-output-directory=')).slice('-output-directory='.length);
        fs.writeFileSync(path.join(directory, 'document.pdf'), '%PDF-1.4\nverified successful output\n%%EOF\n');
      }
      return { stdout: '', stderr: '', exitCode: 0, rawExitCode: 0, signal: null, timedOut: false, cancelled: false, maxBufferExceeded: false };
    } },
  };
  const modulePath = require.resolve('../out/compiler');
  delete require.cache[modulePath];
  const previousLoad = Module._load;
  Module._load = function(request, ...rest) { return Object.hasOwn(stubs, request) ? stubs[request] : previousLoad.call(this, request, ...rest); };
  let compiler;
  try { compiler = require(modulePath); } finally { Module._load = previousLoad; }
  return {
    calls, compiler,
    compile: async text => {
      fs.writeFileSync(f.source, text);
      return compiler.compile({ uri: { fsPath: f.source }, version: 1, getText: () => text });
    },
  };
}

for (const yaml of [
  'bibliography: "quoted #.bib"',
  'bibliography:\n  - "quoted #.bib"',
  'bibliography: ["quoted #.bib"]',
  'bibliography:\r\n  - "quoted #.bib"',
]) {
  test(`compiler and citation renderer share bibliography and CSL paths for ${JSON.stringify(yaml)}`, async t => {
    const f = fixture(t);
    const declared = f.write('chapters/quoted #.bib', bib('declared'));
    const discovered = f.write('references/extra.bib', bib('discovered'));
    const csl = f.write('chapters/style #.csl', '<style/>');
    const text = markdown(`${yaml}\ncsl: "style #.csl"\nlink-citations: false\nbibliography-scope: section`);
    const resolved = config.getResolvedReferences(config.getDocumentConfig(text, f.source), f.source);
    assert.deepEqual(resolved.bibliography, [declared, discovered]);
    assert.equal(resolved.csl, csl); assert.equal(resolved.scope, 'section'); assert.equal(resolved.linkCitations, false);
    assert.equal(Object.isFrozen(resolved), true); assert.equal(Object.isFrozen(resolved.bibliography), true);
    const citationConfig = citations.resolveCitationReferences(text, { sourceFile: f.source, projectRoot: f.root });
    assert.deepEqual(citationConfig, resolved);
    const citationResult = await citations.renderCitations('[@declared; @discovered]', { sourceFile: f.source, projectRoot: f.root, resolvedReferences: resolved });
    assert.deepEqual([...citationResult.resolvedKeys].sort(), ['declared', 'discovered']);
    const compiler = loadCompiler(f);
    const result = await compiler.compile(text);
    assert.equal(result.success, true, result.log);
    const invocation = compiler.calls.find(call => call.command === 'pandoc');
    const bibliography = invocation.args.flatMap((arg, index) => arg === '--bibliography' ? [invocation.args[index + 1]] : []);
    assert.deepEqual(bibliography, [...resolved.bibliography]);
    assert.equal(invocation.args[invocation.args.indexOf('--csl') + 1], resolved.csl);
    assert.ok(invocation.args.includes('--lua-filter'));
  });
}

test('runner and injection honor editor, project and document run precedence', async t => {
  const f = fixture(t);
  settings.defaultCodeDisplay = 'code';
  const block = '```{shell}\necho RUNTIME_OUTPUT\n```';
  assert.equal(runner.parseRunConfig(block, f.source).defaultDisplay, 'code');
  assert.match(inject.prepareForPreview(block, f.source), /echo RUNTIME_OUTPUT/);
  f.write('.inkwell/manifest.json', JSON.stringify({ schemaVersion: 4, defaults: { runs: { display: 'both', cache: false, timeoutSeconds: 2, inputs: ['input.txt'] } } }));
  f.write('input.txt', 'declared input');
  const project = runner.parseRunConfig(block, f.source);
  assert.equal(project.defaultDisplay, 'both'); assert.equal(project.cache, false); assert.equal(project.timeoutMs, 2000);
  const text = '---\ninkwell: {code-display: none}\n---\n' + block;
  assert.equal(runner.parseRunConfig(text, f.source).defaultDisplay, 'none');
  assert.doesNotMatch(inject.prepareForPreview(text, f.source), /echo RUNTIME_OUTPUT/);
  const results = await runner.runAllBlocks(block, f.source);
  assert.equal(results[0].exitCode, 0);
  assert.deepEqual(results[0].block.inputs, ['input.txt']);
  assert.equal((await runner.runAllBlocks(block, f.source))[0].cached, false);
});

test('defaults.yaml reference paths stay project-relative and document declarations win', t => {
  const f = fixture(t);
  const rootBib = f.write('refs.bib', bib('root'));
  const rootCsl = f.write('style.csl', '<style/>');
  const nestedBib = f.write('chapters/refs.bib', bib('nested'));
  const nestedCsl = f.write('chapters/style.csl', '<style/>');
  f.write('defaults.yaml', 'bibliography: [refs.bib]\ncsl: style.csl\n');
  const inherited = config.getResolvedReferences(config.getDocumentConfig('# Body', f.source), f.source);
  assert.equal(inherited.bibliography[0], rootBib); assert.equal(inherited.csl, rootCsl);
  const explicit = config.getResolvedReferences(config.getDocumentConfig(markdown('bibliography: refs.bib\ncsl: style.csl'), f.source), f.source);
  assert.equal(explicit.bibliography[0], nestedBib); assert.equal(explicit.csl, nestedCsl);
});

test('staged effective metadata applies project defaults and preserves unknown metadata and header-includes', async t => {
  const f = fixture(t);
  f.write('.inkwell/manifest.json', JSON.stringify({ schemaVersion: 4, unknownProjectKey: 'preserved', defaults: { typography: { bodySize: '12pt' }, runs: { display: 'both' } } }));
  const text = '---\ntitle: "A # title"\nheader-includes:\n  - \\newcommand{\\custom}{Kept}\nauthor:\n  - name: Jane Doe\n    affiliation: "A # institution"\ncustom-template-key: [one, two]\ntop-level-division: chapter\n---\n\nBody\n';
  const compiler = loadCompiler(f);
  const result = await compiler.compile(text);
  assert.equal(result.success, true, result.log);
  const invocation = compiler.calls.find(call => call.command === 'pandoc');
  const staged = fs.readFileSync(invocation.args[0], 'utf8');
  const metadata = documentConfig.parseDocumentFrontmatter(staged).metadata;
  assert.equal(metadata.fontsize, '12pt');
  assert.equal(metadata.title, 'A # title');
  assert.deepEqual(metadata['header-includes'], ['\\newcommand{\\custom}{Kept}']);
  assert.deepEqual(metadata.author, [{ name: 'Jane Doe', affiliation: 'A # institution' }]);
  assert.deepEqual(metadata['custom-template-key'], ['one', 'two']);
  assert.ok(invocation.args.includes('--top-level-division=chapter'));
  assert.equal(fs.readFileSync(f.source, 'utf8'), text);
});

test('unconfigured staged metadata preserves exact original bytes including CRLF and comments', t => {
  const f = fixture(t);
  const text = '---\r\ntitle: "A # title" # preserve comment\r\nauthor: Jane\r\n---\r\n\r\nBody\r\n';
  const compiler = loadCompiler(f);
  const resolved = documentConfig.resolveDocumentConfig({ text, sourcePath: f.source });
  assert.equal(compiler.compiler.serializeDocumentForPandoc(text, resolved), text);
});

test('invalid YAML and invalid run values stop processes with diagnostics', async t => {
  const f = fixture(t);
  const compiler = loadCompiler(f);
  const text = '---\ninkwell:\n  code-display: invented\n  python-env: [not, a, string]\n---\n```{shell}\necho SHOULD_NOT_RUN\n```';
  const runConfig = runner.parseRunConfig(text, f.source);
  assert.ok(runConfig.diagnostics.some(diagnostic => diagnostic.severity === 'error' && diagnostic.line > 1));
  const [run] = await runner.runAllBlocks(text, f.source);
  assert.notEqual(run.exitCode, 0); assert.doesNotMatch(run.stdout, /SHOULD_NOT_RUN/);
  const result = await compiler.compile(text);
  assert.equal(result.success, false); assert.equal(compiler.calls.length, 0);
  assert.ok(result.errors.some(error => /code-display/.test(error.message)));
  const malformed = await compiler.compile('---\nbibliography: [unclosed\n---\nBody');
  assert.equal(malformed.success, false); assert.equal(compiler.calls.length, 0);
});

test('explicit empty bibliography disables discovery for both consumers', async t => {
  const f = fixture(t);
  f.write('references/discovered.bib', bib('discovered'));
  const text = markdown('bibliography: []');
  const references = config.getResolvedReferences(config.getDocumentConfig(text, f.source), f.source);
  assert.deepEqual(references.bibliography, []);
  assert.deepEqual(citations.resolveCitationReferences(text, { sourceFile: f.source, projectRoot: f.root }).bibliography, []);
  const compiler = loadCompiler(f);
  assert.equal((await compiler.compile(text)).success, true);
  assert.equal(compiler.calls.find(call => call.command === 'pandoc').args.includes('--bibliography'), false);
});

test('validated block overrides beat inherited display, cache, inputs and timeout', async t => {
  const f = fixture(t);
  f.write('.inkwell/manifest.json', JSON.stringify({ schemaVersion: 4, defaults: { runs: { display: 'none', cache: false, inputs: ['missing.csv'], timeoutSeconds: 2 } } }));
  const text = '```{shell id=override display=both cache=true inputs="" timeout=0.2}\necho BLOCK_WINS\n```';
  const [first] = await runner.runAllBlocks(text, f.source);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.block.display, 'both'); assert.equal(first.block.noCache, false); assert.equal(first.block.timeoutMs, 200);
  assert.equal(first.block.inputs, undefined);
  assert.equal((await runner.runAllBlocks(text, f.source))[0].cached, true);
  const preview = inject.prepareForPreview(text, f.source);
  assert.match(preview, /echo BLOCK_WINS/); assert.match(preview, /```text\nBLOCK_WINS/);
  const [invalid] = await runner.runAllBlocks('```{shell display=imaginary}\necho BAD\n```', f.source);
  assert.notEqual(invalid.exitCode, 0); assert.match(invalid.stderr, /display/);
});

test('explicit document display defaults apply to external scripts too', t => {
  const f = fixture(t);
  f.write('.inkwell/scripts/external.sh', 'echo EXTERNAL_SOURCE\n');
  const text = '---\ninkwell:\n  code-display: code\n---\n```{shell file=".inkwell/scripts/external.sh"}\n```';
  assert.match(inject.prepareForPreview(text, f.source), /echo EXTERNAL_SOURCE/);
});

test('inherited metadata does not prepend Markdown frontmatter to RST input', async t => {
  const f = fixture(t);
  f.source = path.join(f.root, 'chapters', 'document.rst');
  f.write('.inkwell/manifest.json', JSON.stringify({ schemaVersion: 4, defaults: { typography: { bodySize: '12pt' } } }));
  const text = 'Title\n=====\n\nUnchanged RST body.\n';
  const compiler = loadCompiler(f);
  assert.equal((await compiler.compile(text)).success, true);
  const invocation = compiler.calls.find(call => call.command === 'pandoc');
  assert.equal(fs.readFileSync(invocation.args[0], 'utf8'), text);
  assert.equal(JSON.parse(fs.readFileSync(invocation.args[invocation.args.indexOf('--metadata-file') + 1], 'utf8')).fontsize, '12pt');
});

test('staged Pandoc defaults cannot override resolved document typography or explicit empty bibliography', async t => {
  const f = fixture(t);
  f.write('defaults.yaml', 'variables:\n  fontsize: 12pt\n  custom-label: KeepMe\nmetadata:\n  fontsize: 11pt\nbibliography: [old.bib]\nwrap: preserve\nresource-path: ["${.}/resources"]\n');
  f.write('old.bib', bib('old'));
  const text = '---\nfontsize: 10pt\nbibliography: []\n---\nBody';
  const compiler = loadCompiler(f);
  const result = await compiler.compile(text);
  assert.equal(result.success, true, result.log);
  const invocation = compiler.calls.find(call => call.command === 'pandoc');
  const defaultsFile = invocation.args[invocation.args.indexOf('--defaults') + 1];
  assert.notEqual(defaultsFile, path.join(f.root, 'defaults.yaml'));
  const effectiveDefaults = require('yaml').parse(fs.readFileSync(defaultsFile, 'utf8'));
  assert.deepEqual(effectiveDefaults.variables, { 'custom-label': 'KeepMe' });
  assert.equal(effectiveDefaults.bibliography, undefined);
  assert.equal(effectiveDefaults.metadata?.fontsize, undefined);
  assert.equal(effectiveDefaults.wrap, 'preserve');
  assert.deepEqual(effectiveDefaults['resource-path'], [path.join(f.root, 'resources')]);
  assert.equal(documentConfig.parseDocumentFrontmatter(fs.readFileSync(invocation.args[0], 'utf8')).metadata.fontsize, '10pt');
  assert.equal(invocation.args.includes('--bibliography'), false);
});

const childProcess = require('node:child_process');
let pandocAvailable = false;
try { childProcess.execFileSync('pandoc', ['--version'], { stdio: 'pipe' }); pandocAvailable = true; } catch {}
test('real Pandoc renders the resolved font variable and does not revive defaults bibliography', { skip: !pandocAvailable }, async t => {
  const f = fixture(t);
  f.write('defaults.yaml', 'variables:\n  fontsize: 12pt\n  custom-label: KeepMe\nbibliography: [old.bib]\nwrap: preserve\n');
  f.write('old.bib', bib('old'));
  const text = '---\nfontsize: 10pt\nbibliography: []\n---\nBody';
  const compiler = loadCompiler(f);
  assert.equal((await compiler.compile(text)).success, true);
  const invocation = compiler.calls.find(call => call.command === 'pandoc');
  const template = f.write('probe.latex', '$fontsize$|$custom-label$|$for(bibliography)$$bibliography$$endfor$');
  const rendered = childProcess.execFileSync('pandoc', [invocation.args[0], '--to=latex', '--standalone', '--template', template,
    '--defaults', invocation.args[invocation.args.indexOf('--defaults') + 1]], { encoding: 'utf8', cwd: path.dirname(f.source) });
  assert.equal(rendered.trim(), '10pt|KeepMe|');
});

test('run-exported presentation bindings resolve before compiler settings validation', async t => {
  const f = fixture(t);
  const text = '---\nfontsize: "{{size}}"\nlinestretch: "{{spacing}}"\n---\n```{shell id=settings}\necho "::inkwell size=12pt"\necho "::inkwell spacing=1.5"\n```\n\nBody';
  const [run] = await runner.runAllBlocks(text, f.source);
  assert.equal(run.exitCode, 0, run.stderr);
  const compiler = loadCompiler(f);
  const result = await compiler.compile(text);
  assert.equal(result.success, true, result.log);
  const invocation = compiler.calls.find(call => call.command === 'pandoc');
  const staged = documentConfig.parseDocumentFrontmatter(fs.readFileSync(invocation.args[0], 'utf8')).metadata;
  assert.equal(staged.fontsize, '12pt');
  assert.equal(staged.linestretch, 1.5);
  assert.equal(fs.readFileSync(f.source, 'utf8'), text);
});

test('unresolved presentation bindings stop compilation and preserve the published PDF', async t => {
  const f = fixture(t);
  const compiler = loadCompiler(f);
  const first = await compiler.compile('A previously successful document.');
  assert.equal(first.success, true, first.log);
  const published = fs.readFileSync(first.pdfPath);
  const callsBefore = compiler.calls.length;
  const result = await compiler.compile('---\nfontsize: "{{missing_size}}"\n---\nBody');
  assert.equal(result.success, false);
  assert.equal(compiler.calls.length, callsBefore);
  assert.ok(result.errors.some(error => error.severity === 'error' && error.line === 2 && /missing_size/.test(error.message)));
  assert.deepEqual(fs.readFileSync(first.pdfPath), published);
});

test('invalid resolved presentation bindings fail normal settings validation', async t => {
  const f = fixture(t);
  const text = '---\nfontsize: "{{size}}"\n---\n```{shell id=settings}\necho "::inkwell size=unusable"\n```';
  const [run] = await runner.runAllBlocks(text, f.source);
  assert.equal(run.exitCode, 0, run.stderr);
  const compiler = loadCompiler(f);
  const result = await compiler.compile(text);
  assert.equal(result.success, false);
  assert.equal(compiler.calls.length, 0);
  assert.ok(result.errors.some(error => error.severity === 'error' && error.line === 2 && /fontsize|bodySize/.test(error.message)));
});
