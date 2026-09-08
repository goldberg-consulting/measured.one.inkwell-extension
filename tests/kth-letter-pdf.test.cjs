const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const { selectPackagedCompiler, checkPdfGolden } = require('./helpers/pdf-goldens.cjs');
const { resolveDocumentConfig } = require('../out/document-config');
const { resolveTypography, namedSizeInPoints, TEX_POINT_TO_CSS_POINT } = require('../out/style-model');
const { resolveTableStyle } = require('../out/table-model');

// This completes template coverage without adding a document to the timed demo corpus.
test('actual KTH letter PDF preserves class-owned typography, letterhead, citations, and last good output', {
  skip: process.env.INKWELL_TYPOGRAPHY_PDF !== '1', timeout: 180000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-kth-letter-pdf-'));
  t.diagnostic(`KTH letter PDF evidence: ${root}`);
  process.env.INKWELL_HEADLESS = '1';
  const headless = require('../out/headless-vscode');
  headless.configureHeadlessWorkspace(root);
  const originalLoad = Module._load;
  Module._load = function (name, ...rest) { return name === 'vscode' ? headless : originalLoad.call(this, name, ...rest); };
  let compile;
  try { ({ compile } = require('../out/compiler')); } finally { Module._load = originalLoad; }
  compile = selectPackagedCompiler(root, compile);
  fs.mkdirSync(path.join(root, '.inkwell'));
  fs.writeFileSync(path.join(root, '.inkwell/manifest.json'), JSON.stringify({
    schemaVersion: 1, scaffoldVersion: 4, template: 'kth-letter', defaults: {}, managedFiles: {},
  }, null, 2));
  const text = fs.readFileSync(path.join(__dirname, 'fixtures/style/kth-letter.md'), 'utf8');
  const file = path.join(root, 'kth-letter.md');
  fs.writeFileSync(file, text);
  const snapshot = (source, version) => ({ uri: headless.Uri.file(file), languageId: 'markdown', version, isUntitled: false, getText: () => source });
  const config = resolveDocumentConfig({ text, sourcePath: file });
  const effective = resolveTypography(config);
  const { style } = resolveTableStyle(config);
  assert.equal(config.diagnostics.filter(item => item.severity === 'error').length, 0);
  assert.equal(config.engine, 'pdflatex');
  assert.equal(config.columns, 1);
  assert.equal(effective.classSizePt, 11);
  assert.equal(effective.bodySizePt, 10.95);
  assert.equal(effective.bodyFont, 'Times');
  assert.equal(effective.lineSpacing, 1);
  assert.equal(effective.tableSizePt, effective.bodySizePt);
  assert.equal(effective.referenceSizePt, effective.bodySizePt);
  assert.equal(style.preset, 'booktabs');
  assert.equal(style.stripe, false);
  assert.equal(style.captionPosition, 'above');
  // KTH owns its section commands: H1 is \large, H2 is \normalsize.
  // Draft explicitly reports this layout approximation; its generic H1 is not the PDF contract.
  assert.match(effective.approximation || '', /class-owned/);
  for (const key of ['typography.headingFont', 'typography.headingWeight', 'typography.headingScale', 'typography.headingColor', 'typography.tableSize', 'typography.referenceSize']) {
    assert.ok(config.diagnostics.some(item => item.key === key && item.code === 'template-capability' && item.severity === 'warning'), `${key} must report its unsupported override`);
    assert.equal(config.typography[key.slice('typography.'.length)], undefined, `${key} must not override the letter class`);
  }
  const result = await compile(snapshot(text, 1));
  fs.writeFileSync(path.join(root, 'compile-result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.success, true, `${result.message}; ${result.logPath}`);
  checkPdfGolden({ id: 'kth-letter-capabilities', template: 'kth-letter', sourcePath: file, pdfPath: result.pdfPath, logPath: result.logPath });
  const probe = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', ['-c', `
import fitz,json,sys
doc=fitz.open(sys.argv[1])
pages=[]
for page in doc:
    spans=[s for b in page.get_text('dict')['blocks'] if 'lines' in b for line in b['lines'] for s in line['spans']]
    pages.append(dict(width=page.rect.width,height=page.rect.height,text=page.get_text(),spans=spans,
        xobjects=[dict(name=x[1],bbox=list(x[3])) for x in page.get_xobjects()],
        drawings=[dict(rect=list(d['rect']),fill=d.get('fill'),type=d['type']) for d in page.get_drawings()]))
print(json.dumps(pages))
`, result.pdfPath], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(probe.status, 0, probe.error?.message || probe.stderr);
  const pages = JSON.parse(probe.stdout);
  fs.writeFileSync(path.join(root, 'pdf-inspection.json'), JSON.stringify(pages, null, 2));
  assert.equal(pages.length, 1, 'the bounded letter remains on one page');
  const page = pages[0];
  assert.ok(Math.abs(page.width - 595.276) < 0.5 && Math.abs(page.height - 841.89) < 0.5, 'native A4 letter geometry survives');
  const match = marker => {
    const found = page.spans.filter(span => span.text.includes(marker));
    assert.ok(found.length, `missing PDF marker ${marker}`);
    return found;
  };
  const expected = {
    KthBodyMarker: effective.bodySizePt,
    KthHeadingMarker: namedSizeInPoints('large', effective.classSizePt),
    KthSubheadingMarker: effective.bodySizePt,
    KthTableMarker: effective.tableSizePt,
    KthCaptionMarker: effective.captionSizePt,
    KthReferenceMarker: effective.referenceSizePt,
    KthRecipientMarker: effective.bodySizePt,
    Royal: 7,
    Technology: 7,
  };
  const measured = {};
  for (const [marker, points] of Object.entries(expected)) {
    measured[marker] = match(marker);
    for (const span of measured[marker]) {
      assert.ok(Math.abs(span.size - points * TEX_POINT_TO_CSS_POINT) < 0.08,
        `${marker}: PDF ${span.size}bp; class ${points}TeXpt (${points * TEX_POINT_TO_CSS_POINT}bp), font ${span.font}`);
    }
  }
  for (const marker of ['KthBodyMarker', 'KthHeadingMarker', 'KthTableMarker', 'KthReferenceMarker']) {
    assert.ok(measured[marker].every(span => /Times|NimbusRom/i.test(span.font)), `${marker} retains class-owned Times family`);
  }
  assert.ok(measured.KthHeadingMarker.every(span => /Bold|NimbusRom.*Medi/i.test(span.font) && span.color === 0), 'native bold black heading ignores unsupported font/weight/color requests');
  const baseline = match('KthBaselineTwo')[0].origin[1] - match('KthBaselineOne')[0].origin[1];
  assert.ok(Math.abs(baseline - effective.bodyBaselinePt * TEX_POINT_TO_CSS_POINT) < 0.08, 'native body baseline survives ignored line spacing');
  assert.ok(match('KthRecipientMarker')[0].bbox[3] < match('KthOpeningMarker')[0].bbox[1], 'recipient remains in the native letterhead above the opening');
  assert.ok(match('KthCaptionMarker')[0].bbox[3] < match('KthTableMarker')[0].bbox[1], 'native table caption remains above its body');
  assert.match(page.text, /Royal Institute of Technology/, 'native institutional footer text remains intact');
  assert.ok(match('Royal')[0].bbox[1] > match('KthClosingMarker')[0].bbox[3], 'native institutional footer remains below the letter');
  assert.ok(page.xobjects.length > 0, 'the native vector logo remains embedded');
  assert.ok(page.drawings.some(d => d.fill && d.rect[1] < 150 && d.rect[3] > d.rect[1] + 1), 'the logo draws visible ink in the letterhead');
  assert.match(page.text, /KthBodyMarker cites \[1\]/, 'citation resolves to its numeric inline CSL reference');
  assert.match(page.text, /Fixture[\s\S]*2026/, 'the cited inline CSL reference appears');
  assert.doesNotMatch(page.text, /@kth-reference|\?\?\?/, 'no unresolved citation markers reach the PDF');
  assert.doesNotMatch(page.text, /^\*$/m, 'starred bibliography headings do not print a stray star');
  const published = fs.readFileSync(result.pdfPath);
  const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const evidence = { template: 'kth-letter', pdfPath: result.pdfPath, pdfSha256: sha256(published), expectedTeXPoints: expected,
    draftApproximation: effective.approximation, draftHeadingSizesTeXPoints: effective.headingSizesPt,
    measuredBaseline: baseline, expectedBaselineTeXPoints: effective.bodyBaselinePt, measured, failedCompilePreservedPdf: false };
  fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  const broken = text + '\n```{=latex}\n\\KthIntentionalCompileFailure\n```\n';
  try {
    fs.writeFileSync(file, broken);
    const failed = await compile(snapshot(broken, 2));
    fs.writeFileSync(path.join(root, 'failed-compile-result.json'), JSON.stringify(failed, null, 2));
    assert.equal(failed.success, false, 'an invalid TeX command must fail compilation');
    assert.equal(sha256(fs.readFileSync(result.pdfPath)), evidence.pdfSha256, 'failed compilation preserves the last successful PDF byte for byte');
    evidence.failedCompilePreservedPdf = true;
    fs.writeFileSync(path.join(root, 'measurements.json'), JSON.stringify(evidence, null, 2));
  } finally {
    fs.writeFileSync(file, text);
  }
});
