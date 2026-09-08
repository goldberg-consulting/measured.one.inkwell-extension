const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
function shell(origin) {
  const uri = file => ({ fsPath: file, toString: () => file });
  const vscode = { Uri: { file: uri }, workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) }, window: {} };
  const old = Module._load;
  Module._load = function(request, parent, ...args) {
    if (request === 'vscode') return vscode;
    if (request === './inkwell-output' && parent?.filename.endsWith('/preview.js')) return { getInkwellOutputChannel: () => ({ appendLine() {} }) };
    return old.call(this, request, parent, ...args);
  };
  let Provider;
  try { delete require.cache[require.resolve('../out/preview')]; Provider = require('../out/preview').InkwellPreviewProvider; }
  finally { Module._load = old; }
  const provider = new Provider({ extensionPath: root });
  return provider.buildShell({ cspSource: origin, asWebviewUri: value => ({ toString: () => origin + '/' + path.relative(root, value.fsPath).split(path.sep).join('/') }) }, false);
}

module.exports = { shell };
