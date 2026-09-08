import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PREVIEW_VENDOR_VERSIONS } from '../scripts/build-preview-assets.mjs';
const require = createRequire(import.meta.url);
const { shell } = require('./preview-shell-helper.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every pinned local vendor asset matches the build provenance and required feature contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'media/vendor/versions.json'), 'utf8'));
  assert.deepEqual(manifest.packages, PREVIEW_VENDOR_VERSIONS);
  assert.equal(manifest.schemaVersion, 1);
  for (const required of ['math.js', 'mermaid.js', 'highlight.js', 'katex/katex.min.css',
    'katex/fonts/KaTeX_Main-Regular.woff2', 'highlight/github.min.css', 'highlight/github-dark.min.css',
    'pdfjs/pdf.mjs', 'pdfjs/pdf.worker.mjs', 'pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    'pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap', 'pdfjs/wasm/openjpeg.wasm',
    ...Object.keys(PREVIEW_VENDOR_VERSIONS).map(name => `licenses/${name}.txt`)]) assert.ok(manifest.files[required], required);
  for (const [relative, entry] of Object.entries(manifest.files)) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
    const file = path.join(root, 'media/vendor', relative);
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, entry.size, relative);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, relative);
  }
  assert.ok(fs.statSync(path.join(root, 'media/preview-client.js')).size > 0);
});

test('preview shell admits only local resources and nonce-authorized executable modules', () => {
  const html = shell('https://test.webview.local');
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-[^']+' 'strict-dynamic' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /(?:script|connect|font|img)-src[^;]*(?:https:;|'unsafe-inline'|'unsafe-eval')/);
  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    assert.ok(match[1].startsWith('https://test.webview.local/media/'), match[1]);
  }
  assert.doesNotMatch(html, /(?:cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com)/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1, 'only the small client entry is loaded eagerly');
  assert.equal([...html.matchAll(/<script[^>]*src="[^"]+"[^>]*nonce=|<script[^>]*nonce="[^"]+"[^>]*src=/g)].length, 1);
  assert.notEqual(html.match(/script-src 'nonce-([^']+)'/)[1], shell('https://test.webview.local').match(/script-src 'nonce-([^']+)'/)[1]);
});
