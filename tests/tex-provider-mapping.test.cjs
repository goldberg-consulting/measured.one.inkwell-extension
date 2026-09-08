const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, ...args);
};
let tlmgrPackageForFile;
try { ({ tlmgrPackageForFile } = require('../out/toolchain')); } finally { Module._load = originalLoad; }

test('TeX style filenames resolve to their valid tlmgr provider packages', () => {
  assert.equal(tlmgrPackageForFile('subcaption.sty'), 'caption');
  assert.equal(tlmgrPackageForFile('tabularx.sty'), 'tools');
});
