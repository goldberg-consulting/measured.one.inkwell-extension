const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const verified = new Set();

function selectPackagedCompiler(projectRoot, fallback) {
  const selected = process.env.INKWELL_PDF_ASSET_ROOT;
  if (!selected) return fallback;
  const root = fs.realpathSync(selected);
  if (!verified.has(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'out/assets-manifest.json'), 'utf8'));
    assert.equal(manifest.schemaVersion, 1);
    for (const [relative, expected] of Object.entries(manifest.files)) {
      const file = fs.realpathSync(path.resolve(root, relative));
      assert.ok(file.startsWith(root + path.sep), `Packaged asset escapes its root: ${relative}`);
      const bytes = fs.readFileSync(file);
      assert.equal(bytes.length, expected.size);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, relative);
    }
    verified.add(root);
  }
  return require(path.join(root, 'out/smoke-cli.js')).createHeadlessCompiler(projectRoot).compile;
}

function checkPdfGolden(fixture) {
  const mode = process.env.INKWELL_PDF_GOLDENS;
  if (!mode) return undefined;
  assert.ok(['1', 'check', 'record'].includes(mode), 'INKWELL_PDF_GOLDENS must be check or record.');
  const artifact = process.env.INKWELL_PDF_ARTIFACT_SHA256;
  assert.match(artifact || '', /^[a-f0-9]{64}$/, 'Set INKWELL_PDF_ARTIFACT_SHA256 to the actual verified VSIX hash.');
  if (mode === 'record') assert.equal(process.env.INKWELL_PDF_GOLDENS_ALLOW_RECORD, '1', 'Recording also requires INKWELL_PDF_GOLDENS_ALLOW_RECORD=1; normal tests never update baselines.');
  const output = path.resolve(process.env.INKWELL_PDF_GOLDENS_OUTPUT || path.join(path.dirname(fixture.logPath), 'golden-review'));
  fs.mkdirSync(output, { recursive: true });
  const sourceBase = path.basename(fixture.sourcePath || fixture.pdfPath, path.extname(fixture.sourcePath || fixture.pdfPath));
  const input = { ...fixture, flsPath: fixture.flsPath || path.join(path.dirname(fixture.logPath), sourceBase + '.fls') };
  const manifest = path.join(output, fixture.id + '.input.json');
  fs.writeFileSync(manifest, JSON.stringify([input], null, 2) + '\n');
  const args = [path.resolve(__dirname, '../../scripts/check-raster-goldens.py'), '--manifest', manifest,
    '--goldens', path.resolve(process.env.INKWELL_PDF_GOLDENS_DIR || path.join(__dirname, '../goldens')),
    '--output', path.join(output, fixture.id + '-review'), '--artifact-sha256', artifact];
  if (process.env.INKWELL_PDF_ASSET_ROOT) args.push('--extension-root', fs.realpathSync(process.env.INKWELL_PDF_ASSET_ROOT));
  if (mode === 'record') args.push('--record', '--allow-baseline-write');
  const result = cp.spawnSync(process.env.INKWELL_PDF_PYTHON || 'python3', args, { encoding: 'utf8', timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `Raster golden ${fixture.id} failed: ${result.error?.message || ''}\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(fs.readFileSync(path.join(output, fixture.id + '-review/report.json'), 'utf8'));
}

module.exports = { selectPackagedCompiler, checkPdfGolden };
