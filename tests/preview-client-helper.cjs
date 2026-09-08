const path = require('node:path');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
function clientProgram(shell, options = {}) {
  const fontScale = Number(shell.match(/data-font-scale="([^"]+)"/)?.[1]) || 100;
  const selectedTab = shell.match(/data-initial-tab="([^"]+)"/)?.[1] || 'preview';
  const vendorRoot = shell.match(/data-vendor-root="([^"]+)"/)?.[1] || '';
  const defaults = JSON.stringify({ fontScale, selectedTab, vendorRoot });
  return buildSync({ stdin: { contents: `import { startPreview } from './src/webview/client.js';
    const initial = ${defaults};
    initial.assets = { pdf: async () => { if (typeof pdfjsLib !== 'undefined') return pdfjsLib; throw new Error('No PDF in DOM unit fixture'); } };
    startPreview(initial);`, resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', target: 'chrome108', minify: Boolean(options.minify), write: false }).outputFiles[0].text;
}
module.exports = { clientProgram };
