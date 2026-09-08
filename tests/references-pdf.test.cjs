const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const Module = require('node:module');
const { selectPackagedCompiler, checkPdfGolden } = require('./helpers/pdf-goldens.cjs');
const { CitationPandocEngine } = require('../out/citation-pandoc');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveBibliographyConfiguration } = require('../out/bibliography-service');

test('actual reference PDFs preserve first-file precedence, physical font and page-break layout', { skip: process.env.INKWELL_REFERENCES_PDF !== '1', timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-references-pdf-')); t.diagnostic(`Reference PDF evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode'); headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...args); };
  let compile; try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell')); fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), '{"schemaVersion":1,"scaffoldVersion":4,"defaults":{},"managedFiles":{}}');
  fs.writeFileSync(path.join(root, 'first.bib'), '@book{alpha,title={FirstFileWinner},author={Researcher, A},year={2026}}\n@book{beta,title={SecondReferenceMarker},author={Writer, B},year={2025}}');
  fs.writeFileSync(path.join(root, 'second.bib'), '@book{alpha,title={WrongDuplicateTitle},author={Other, A},year={2024}}');
  const evidence = [];
  for (const template of ['default', 'eth-report']) for (const pageBreak of ['never', 'always']) {
    const source = path.join(root, `${template}-${pageBreak}.md`);
    const text = `---\ntemplate: ${template}\ntitle: References verification\nauthor: Researcher\nfontsize: 11pt\nbibliography: [first.bib, second.bib]\ninkwell:\n  references:\n    heading: SourcesMarker\n    font-size: 9pt\n    hanging-indent: 2em\n    line-spacing: 1.2\n    entry-spacing: 6pt\n    page-break: ${pageBreak}\n---\n\nBodyMarker cites [@alpha; @beta].\n\n## References\n`;
    fs.writeFileSync(source, text);
    const config = resolveDocumentConfig({ text, sourcePath: source }), references = resolveBibliographyConfiguration(config, source, root);
    const preview = await new CitationPandocEngine().render(config.parsed.body, references, root);
    assert.match(preview.body, /FirstFileWinner/); assert.doesNotMatch(preview.body, /WrongDuplicateTitle/);
    const result = await compile({ uri: headless.Uri.file(source), languageId: 'markdown', version: 1, isUntitled: false, getText: () => text });
    fs.writeFileSync(path.join(root, `${template}-${pageBreak}.result.json`), JSON.stringify(result, null, 2));
    assert.equal(result.success, true, `${template}/${pageBreak}: ${result.message}; ${result.logPath}`);
    checkPdfGolden({ id: `references-${template}-${pageBreak}`, template, sourcePath: source, pdfPath: result.pdfPath, logPath: result.logPath });
    const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `import fitz,json,sys\nd=fitz.open(sys.argv[1])\nprint(json.dumps([dict(page=i,spans=[s for b in p.get_text('dict')['blocks'] if 'lines' in b for l in b['lines'] for s in l['spans']],text=p.get_text(),links=p.get_links()) for i,p in enumerate(d)],default=str))`, result.pdfPath], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr); const pages = JSON.parse(probe.stdout);
    const body = pages.find(p => p.text.includes('BodyMarker')), refs = pages.find(p => p.text.includes('FirstFileWinner'));
    assert.ok(body && refs); assert.equal(pages.some(p => p.text.includes('WrongDuplicateTitle')), false);
    assert.equal(pages.map(p => p.text).join('').split('SourcesMarker').length - 1, 1);
    if (pageBreak === 'always') assert.ok(refs.page > body.page); else assert.equal(refs.page, body.page);
    const span = refs.spans.find(span => span.text.includes('FirstFileWinner'));
    assert.ok(Math.abs(span.size - 9 * 72 / 72.27) < .1, `${template} reference font ${span.size}`);
    assert.ok(pages.some(page => page.links.length > 0), 'citation PDF links exist');
    evidence.push({ template, pageBreak, bodyPage: body.page, referencesPage: refs.page, referenceFontSize: span.size, pdfPath: result.pdfPath });
  }
  fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
});
