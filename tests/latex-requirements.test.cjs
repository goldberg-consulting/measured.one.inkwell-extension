const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');

function packageNames(source) {
  return source
    .split(/\r?\n/)
    .map(line => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

test('TinyTeX requirements use provider package names instead of style filenames', () => {
  const names = packageNames(fs.readFileSync(path.join(repo, 'requirements-latex.txt'), 'utf8'));
  const packages = new Set(names);

  assert.equal(packages.size, names.length, 'the install manifest should not contain duplicate package names');
  for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9+.-]*$/, `${name} must be a tlmgr package-name token`);
  assert.ok(packages.has('caption'), 'caption supplies subcaption.sty');
  assert.ok(packages.has('tools'), 'tools supplies tabularx.sty');
  assert.ok(!packages.has('subcaption'), 'subcaption.sty is not itself a tlmgr package');
  assert.ok(!packages.has('tabularx'), 'tabularx.sty is not itself a tlmgr package');
});
