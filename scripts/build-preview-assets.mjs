import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PREVIEW_VENDOR_VERSIONS = Object.freeze({ katex: '0.18.7', mermaid: '11.17.2',
  'pdfjs-dist': '6.3.289', 'highlight.js': '11.12.0' });
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Import this from the packaged asset-manifest builder after building vendors.
 * Missing promised files then fail the existing regular-file/hash contract. */
export function readPreviewAssetPaths(root = repositoryRoot, provenance = JSON.parse(readFileSync(path.join(root, 'media/vendor/versions.json'), 'utf8'))) {
  if (provenance.schemaVersion !== 1 || JSON.stringify(provenance.packages) !== JSON.stringify(PREVIEW_VENDOR_VERSIONS)) {
    throw new Error('Preview vendor versions do not match the pinned build contract.');
  }
  if (!provenance.files || typeof provenance.files !== 'object' || Array.isArray(provenance.files)) {
    throw new Error('Invalid preview vendor asset inventory.');
  }
  const names = Object.keys(provenance.files);
  for (const required of ['math.js', 'mermaid.js', 'highlight.js', 'katex/katex.min.css', 'katex/fonts/KaTeX_Main-Regular.woff2',
    'highlight/github.min.css', 'highlight/github-dark.min.css', 'pdfjs/pdf.mjs', 'pdfjs/pdf.worker.mjs',
    'pdfjs/standard_fonts/LiberationSans-Regular.ttf', 'pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap', 'pdfjs/wasm/openjpeg.wasm',
    ...Object.keys(PREVIEW_VENDOR_VERSIONS).map(name => `licenses/${name}.txt`)]) {
    if (!names.includes(required)) throw new Error(`Required preview vendor asset is missing: ${required}`);
  }
  if (names.some(name => !name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..'))) {
    throw new Error('Invalid preview vendor asset path.');
  }
  for (const [name, expected] of Object.entries(provenance.files)) {
    if (!expected || !Number.isSafeInteger(expected.size) || expected.size <= 0 || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
      throw new Error(`Invalid preview vendor hash/size: ${name}`);
    }
  }
  return ['media/preview-client.js', 'media/vendor/versions.json', ...names.map(name => `media/vendor/${name}`)];
}

export async function buildPreviewAssets(root = repositoryRoot) {
  // Read-only archive validation and release preflight run before npm ci.
  const { build } = await import('esbuild');
  const media = path.join(root, 'media');
  await fs.mkdir(media, { recursive: true });
  const stage = await fs.mkdtemp(path.join(media, '.preview-assets-'));
  const files = {};
  const publish = async (relative, bytes) => {
    const target = path.join(stage, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
    files[relative] = { size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const copy = async (name, from, to) => {
    const source = path.join(root, 'node_modules', name, from);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`Vendor symlink is not allowed: ${source}`);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(source)).sort()) await copy(name, `${from}/${entry}`, `${to}/${entry}`);
    } else if (stat.isFile()) await publish(to, await fs.readFile(source));
    else throw new Error(`Vendor asset is not a regular file: ${source}`);
  };
  const bundle = async (source, target) => {
    const result = await build({ stdin: { contents: source, resolveDir: root }, bundle: true,
      minify: true, platform: 'browser', format: 'esm', target: 'chrome108', write: false });
    await publish(target, result.outputFiles[0].contents);
  };
  try {
    for (const [name, expected] of Object.entries(PREVIEW_VENDOR_VERSIONS)) {
      const actual = JSON.parse(await fs.readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
      if (actual !== expected) throw new Error(`Expected ${name}@${expected}; found ${actual}`);
      await copy(name, 'LICENSE', `licenses/${name}.txt`);
    }
    await bundle("export { default } from 'katex/dist/contrib/auto-render.mjs';", 'math.js');
    await copy('katex', 'dist/katex.min.css', 'katex/katex.min.css');
    await copy('katex', 'dist/fonts', 'katex/fonts');
    await bundle("export { default } from 'mermaid';", 'mermaid.js');
    const languages = ['python', 'bash', 'sql', 'r', 'typescript', 'julia', 'yaml', 'json', 'latex', 'javascript', 'xml', 'css'];
    await bundle("import hljs from 'highlight.js/lib/core';\n" + languages.map((language, index) =>
      `import language${index} from 'highlight.js/lib/languages/${language}';hljs.registerLanguage('${language}', language${index});`).join('\n') +
      '\nexport default hljs;', 'highlight.js');
    await copy('highlight.js', 'styles/github.min.css', 'highlight/github.min.css');
    await copy('highlight.js', 'styles/github-dark.min.css', 'highlight/github-dark.min.css');
    await copy('pdfjs-dist', 'legacy/build/pdf.mjs', 'pdfjs/pdf.mjs');
    await copy('pdfjs-dist', 'legacy/build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs');
    for (const tree of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await copy('pdfjs-dist', tree, `pdfjs/${tree}`);
    await publish('versions.json', Buffer.from(JSON.stringify({ schemaVersion: 1, packages: PREVIEW_VENDOR_VERSIONS, files }, null, 2) + '\n'));
    const client = await build({ entryPoints: [path.join(root, 'src/webview/entry.js')], bundle: true,
      minify: true, platform: 'browser', format: 'iife', target: 'chrome108', write: false });
    const temporary = path.join(stage, 'preview-client.tmp');
    await fs.writeFile(temporary, client.outputFiles[0].contents);
    await fs.rename(temporary, path.join(media, 'preview-client.js'));
    await fs.rm(path.join(media, 'vendor'), { recursive: true, force: true });
    await fs.rename(stage, path.join(media, 'vendor'));
    return { versions: PREVIEW_VENDOR_VERSIONS, vendorAssetCount: Object.keys(files).length };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await buildPreviewAssets()));
