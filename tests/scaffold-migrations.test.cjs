const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-migration-test-'));
  t.after(() => fs.rmSync(outer, { recursive: true, force: true }));
  const root = path.join(outer, 'project');
  const assets = path.join(outer, 'assets');
  fs.mkdirSync(root);
  const { BUNDLED_ASSET_PATHS } = require('../out/bundled-assets.js');
  for (const relative of BUNDLED_ASSET_PATHS) {
    const file = path.join(assets, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.endsWith('.json') ? '{"name":"test"}' : `Bundled content for ${relative}\n`);
  }
  return { root, assets, outer };
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('a home-global template directory is not project consent even when home is the workspace', async t => {
  const f = fixture(t);
  write(f.root, '.inkwell/templates/custom/template.json', '{"name":"Global user template"}');
  const before = tree(f.root);
  const originalHome = os.homedir;
  os.homedir = () => f.root;
  try {
    const { ensureProjectReady, isProjectOptedIn } = require('../out/project-readiness');
    assert.equal(isProjectOptedIn(f.root), false);
    const readiness = await ensureProjectReady({ root: f.root, trusted: true, assetRoot: f.assets });
    assert.equal(readiness.status, 'setup-required');
    assert.equal(readiness.ready, false);
    assert.deepEqual(tree(f.root), before);
  } finally { os.homedir = originalHome; }
});

function loadScaffold(root, assets) {
  const messages = [];
  const vscode = {
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: root } }] },
    window: {
      showQuickPick: async () => ({ label: 'No' }),
      showInformationMessage: (message) => messages.push(message),
      showWarningMessage: (message) => messages.push(message),
      showErrorMessage: (message) => messages.push(message),
    },
  };
  const load = Module._load;
  const modulePath = path.join(assets, 'out/scaffold.js');
  const scaffold = new Module(modulePath, module);
  scaffold.filename = modulePath;
  scaffold.paths = module.paths;
  Module._load = function (request, parent, ...rest) {
    if (request === 'vscode') return vscode;
    if (request === './templates') return { selectTemplateCommand: async () => 'default' };
    if (request === './inkwell-output') return { getInkwellOutputChannel: () => ({ appendLine() {}, show() {} }) };
    if (request.startsWith('.') && parent?.filename === modulePath) return require(path.join(__dirname, '../out', request));
    return load.call(this, request, parent, ...rest);
  };
  try { scaffold._compile(fs.readFileSync(path.join(__dirname, '../out/scaffold.js'), 'utf8'), modulePath); }
  finally { Module._load = load; }
  return { ...scaffold.exports, messages };
}

test('setup preserves a user-edited guide byte-for-byte', async (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', JSON.stringify({ scaffoldVersion: 3, template: 'rho', custom: { preserve: true } }));
  write(f.root, '.inkwell/guide.md', 'My edited guide\r\n');
  await loadScaffold(f.root, f.assets).setupWorkspace();
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'My edited guide\r\n');
});

test('setup backs up a malformed manifest and leaves its original bytes unchanged', async (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', '{ invalid user manifest');
  await loadScaffold(f.root, f.assets).setupWorkspace();
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'), 'utf8'), '{ invalid user manifest');
  assert.ok(fs.readdirSync(path.join(f.root, '.inkwell')).some((name) => name.endsWith('.bak')));
});

function tree(root) {
  const snapshot = {};
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      snapshot[relative] = { size: stat.size, mtime: stat.mtimeMs, bytes: entry.isFile() ? fs.readFileSync(full).toString('base64') : undefined };
      if (entry.isDirectory()) walk(full, relative + '/');
    }
  };
  walk(root);
  return snapshot;
}

const migration = () => require('../out/scaffold-migrations.js');
const readiness = () => require('../out/project-readiness.js');

for (const version of [0, 1, 2, 3, 4]) {
  test(`scaffold version ${version} migrates deterministically and preserves unknown JSON`, (t) => {
    const f = fixture(t);
    const original = { scaffoldVersion: version, template: 'rho', settings: { fontFamily: 'Pagella', untouched: ['x'] },
      documentSettings: { lineSpacing: 1.25 }, custom: { arbitrary: [1, { value: false }] }, defaults: { futureSection: { enabled: true } } };
    write(f.root, '.inkwell/manifest.json', JSON.stringify(original));
    const before = tree(f.root);
    const plan = migration().planMigration(f.root, f.assets);
    assert.deepEqual(migration().planMigration(f.root, f.assets), plan);
    assert.deepEqual(tree(f.root), before, 'planning performs zero writes');
    assert.deepEqual(plan.migrationSteps, Array.from({ length: 4 - version }, (_, index) => version + index + 1));
    const result = migration().applyMigration(plan);
    assert.equal(result.success, true, JSON.stringify(result));
    const manifest = JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json')));
    assert.equal(manifest.schemaVersion, 4);
    assert.equal(manifest.scaffoldVersion, 4);
    assert.equal(manifest.template, 'rho');
    assert.deepEqual(manifest.custom, original.custom);
    assert.deepEqual(manifest.settings, original.settings);
    assert.deepEqual(manifest.documentSettings, original.documentSettings);
    assert.deepEqual(manifest.defaults.futureSection, { enabled: true });
    assert.equal(manifest.defaults.typography.bodyFont, 'Pagella');
    assert.equal(manifest.defaults.typography.lineSpacing, 1.25);
    assert.ok(fs.readdirSync(path.join(f.root, '.inkwell/.migrations')).length);
    const settled = tree(f.root);
    const second = migration().applyMigration(migration().planMigration(f.root, f.assets));
    assert.equal(second.status, 'up-to-date');
    assert.equal(second.writes.length, 0);
    assert.deepEqual(tree(f.root), settled, 'second setup changes neither bytes nor mtimes');
  });
}

test('edited user files and local templates survive and version stays unchanged on conflicts', (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', '{"scaffoldVersion":3,"template":"custom"}');
  const files = {
    '.inkwell/guide.md': 'Edited guide\r\n',
    '.inkwell/scripts/sine_plot.py': '# user program\n',
    '.inkwell/references/refs.bib': '@book{myCitation}\r\n',
    '.inkwell/examples/demo-default.md': 'Edited example',
    '.inkwell/templates/custom/template.latex': 'User template',
  };
  for (const [relative, content] of Object.entries(files)) write(f.root, relative, content);
  const plan = migration().planMigration(f.root, f.assets);
  assert.equal(plan.conflicts.length, 3);
  const result = migration().applyMigration(plan);
  assert.equal(result.status, 'conflict');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'))).scaffoldVersion, 3);
  for (const [relative, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(f.root, relative), 'utf8'), content);
  for (const conflict of plan.conflicts) assert.ok(fs.existsSync(path.join(f.root, conflict.proposalPath)));
  const proposal = plan.conflicts[0].proposalPath;
  write(f.root, proposal, 'Edited proposal');
  const retry = migration().planMigration(f.root, f.assets);
  assert.notEqual(retry.conflicts[0].proposalPath, proposal);
  migration().applyMigration(retry);
  assert.equal(fs.readFileSync(path.join(f.root, proposal), 'utf8'), 'Edited proposal');
  const unchanged = tree(f.root);
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).writes.length, 0);
  assert.deepEqual(tree(f.root), unchanged);
});

test('hash-proven unchanged managed files upgrade while edited ones receive proposals', (t) => {
  const f = fixture(t);
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).success, true);
  write(f.assets, 'guide.md', 'New bundled guide');
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).success, true);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'New bundled guide');
  write(f.root, '.inkwell/guide.md', 'My modified guide');
  write(f.assets, 'guide.md', 'Even newer bundled guide');
  const plan = migration().planMigration(f.root, f.assets);
  assert.ok(plan.conflicts.some((conflict) => conflict.path === '.inkwell/guide.md'));
  assert.equal(migration().applyMigration(plan).status, 'conflict');
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'My modified guide');
});

test('explicit keep-user-files resolves ownership without replacing user bytes or proposals', (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', '{"scaffoldVersion":3,"template":"rho"}');
  write(f.root, '.inkwell/guide.md', 'My guide');
  const plan = migration().planMigration(f.root, f.assets);
  assert.equal(migration().applyMigration(plan).status, 'conflict');
  const result = migration().applyMigration(migration().planMigration(f.root, f.assets), { resolveConflicts: 'keep-user-files' });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'My guide');
  assert.ok(fs.existsSync(path.join(f.root, plan.conflicts[0].proposalPath)));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json')));
  assert.equal(manifest.scaffoldVersion, 4);
  assert.equal(manifest.managedFiles['.inkwell/guide.md'].ownership, 'user');
  write(f.assets, 'guide.md', 'Another extension update');
  const after = migration().applyMigration(migration().planMigration(f.root, f.assets));
  assert.equal(after.status, 'up-to-date');
  assert.equal(after.writes.length, 0);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'My guide');
});

test('keep-user-files cannot bypass malformed manifest validation', (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', '{invalid');
  const result = migration().applyMigration(migration().planMigration(f.root, f.assets), { resolveConflicts: 'keep-user-files' });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'), 'utf8'), '{invalid');
});

test('schema-invalid manifest is backed up once without replacement', (t) => {
  const f = fixture(t);
  const content = '{"schemaVersion":3,"defaults":[],"unknown":"keep"}';
  write(f.root, '.inkwell/manifest.json', content);
  const plan = migration().planMigration(f.root, f.assets);
  assert.equal(plan.blocked, true);
  assert.equal(migration().applyMigration(plan).success, false);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'), 'utf8'), content);
  const second = migration().applyMigration(migration().planMigration(f.root, f.assets));
  assert.equal(second.writes.length, 0);
});

test('missing bundled template support asset blocks setup before creating the scaffold', (t) => {
  const f = fixture(t);
  const { BUNDLED_ASSET_PATHS } = require('../out/bundled-assets.js');
  const support = BUNDLED_ASSET_PATHS.find((file) => file.endsWith('.cls'));
  fs.unlinkSync(path.join(f.assets, support));
  const plan = migration().planMigration(f.root, f.assets);
  assert.equal(plan.blocked, true);
  assert.ok(plan.diagnostics.some((diagnostic) => diagnostic.path === support));
  assert.equal(migration().applyMigration(plan).success, false);
  assert.equal(fs.existsSync(path.join(f.root, '.inkwell')), false);
});

test('generated ignores cover all runtime caches and no runtime template is copied', (t) => {
  const f = fixture(t);
  const result = migration().applyMigration(migration().planMigration(f.root, f.assets));
  assert.equal(result.success, true);
  const ignore = fs.readFileSync(path.join(f.root, '.gitignore'), 'utf8');
  for (const entry of ['.inkwell/.cache/', '.inkwell/venv/', '.inkwell/outputs/', '.inkwell/runs/', '.inkwell/history/']) assert.ok(ignore.includes(entry));
  assert.equal(fs.existsSync(path.join(f.root, '.inkwell/templates')), false);
});

for (const checkpoint of ['journal-created', 'file-written', 'manifest-written', 'before-complete']) {
  test(`migration resumes after failure at ${checkpoint} without a premature manifest version`, (t) => {
    const f = fixture(t);
    const original = '{"scaffoldVersion":3,"template":"rho","unknown":123}';
    write(f.root, '.inkwell/manifest.json', original);
    const plan = migration().planMigration(f.root, f.assets);
    const failed = migration().applyMigration(plan, { checkpoint: (name) => { if (name === checkpoint) throw new Error('Injected interruption'); } });
    assert.equal(failed.success, false);
    assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'), 'utf8'), original);
    const resumed = migration().planMigration(f.root, f.assets);
    assert.equal(resumed.resumed, true);
    const result = migration().applyMigration(resumed);
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json'))).schemaVersion, 4);
    assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).writes.length, 0);
  });
}

test('a user edit racing migration is preserved and stops version promotion', (t) => {
  const f = fixture(t);
  const plan = migration().planMigration(f.root, f.assets);
  const result = migration().applyMigration(plan, { checkpoint: (name, relative) => {
    if (name === 'before-file' && relative === '.inkwell/scripts/scatter.py') write(f.root, relative, 'My concurrent script edit');
  } });
  assert.equal(result.success, false);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/scripts/scatter.py'), 'utf8'), 'My concurrent script edit');
  assert.equal(fs.existsSync(path.join(f.root, '.inkwell/manifest.json')), false);
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).success, false);
  const resumed = migration().planMigration(f.root, f.assets);
  assert.ok(resumed.conflicts.some((conflict) => conflict.path === '.inkwell/scripts/scatter.py'));
  assert.equal(migration().applyMigration(resumed, { resolveConflicts: 'keep-user-files' }).success, true);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/scripts/scatter.py'), 'utf8'), 'My concurrent script edit');
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).status, 'up-to-date');
});

test('a concurrent migration cannot interleave its transaction with another publisher', (t) => {
  const f = fixture(t);
  const plan = migration().planMigration(f.root, f.assets);
  let concurrent;
  const first = migration().applyMigration(plan, { checkpoint(name) {
    if (name === 'journal-created') concurrent = migration().applyMigration(plan);
  } });
  assert.equal(first.success, true);
  assert.equal(concurrent.success, false);
  assert.match(concurrent.diagnostics.at(-1).message, /Another scaffold migration is running/);
  assert.equal(migration().applyMigration(migration().planMigration(f.root, f.assets)).status, 'up-to-date');
});

test('a hard process exit after manifest publication resumes a complete scaffold', (t) => {
  const f = fixture(t);
  write(f.root, '.inkwell/manifest.json', '{"scaffoldVersion":3,"custom":"keep"}');
  const child = spawnSync(process.execPath, ['-e', `
    const {planMigration, applyMigration} = require(process.argv[1]);
    applyMigration(planMigration(process.argv[2],process.argv[3]), { checkpoint(name) { if(name==='manifest-written') process.exit(87); } });
  `, require.resolve('../out/scaffold-migrations.js'), f.root, f.assets]);
  assert.equal(child.status, 87, child.stderr.toString());
  const plan = migration().planMigration(f.root, f.assets);
  assert.equal(plan.resumed, true);
  assert.equal(migration().applyMigration(plan).success, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.root, '.inkwell/manifest.json')));
  assert.equal(manifest.custom, 'keep');
  for (const relative of Object.keys(manifest.managedFiles)) assert.ok(fs.existsSync(path.join(f.root, relative)));
});

test('an unsafe operation in an interrupted journal is rejected before any publication', (t) => {
  const f = fixture(t);
  const plan = migration().planMigration(f.root, f.assets);
  migration().applyMigration(plan, { checkpoint(name) { if (name === 'journal-created') throw new Error('stop'); } });
  const journalPath = path.join(f.root, '.inkwell/.migrations', fs.readdirSync(path.join(f.root, '.inkwell/.migrations'))[0]);
  const journal = JSON.parse(fs.readFileSync(journalPath));
  journal.plan.operations[0].path = '../escape';
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  const resumed = migration().planMigration(f.root, f.assets);
  assert.equal(resumed.blocked, true);
  assert.equal(migration().applyMigration(resumed).success, false);
  assert.equal(fs.existsSync(path.join(f.outer, 'escape')), false);
});

test('a resumed transaction checks upgraded assets before caching readiness', async (t) => {
  const f = fixture(t);
  const plan = migration().planMigration(f.root, f.assets);
  migration().applyMigration(plan, { checkpoint(name) { if (name === 'file-written') throw new Error('stop'); } });
  write(f.assets, 'guide.md', 'Guide from a newer extension');
  const result = await readiness().ensureProjectReady({ root: f.root, assetRoot: f.assets, trusted: true });
  assert.equal(result.ready, true, JSON.stringify(result.diagnostics));
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'Guide from a newer extension');
});

test('symlink escape at planning or between planning and publication never writes outside root', (t) => {
  const f = fixture(t);
  const outside = path.join(f.outer, 'outside');
  fs.mkdirSync(outside);
  const plan = migration().planMigration(f.root, f.assets);
  fs.mkdirSync(path.join(f.root, '.inkwell'));
  fs.symlinkSync(outside, path.join(f.root, '.inkwell/scripts'));
  assert.equal(migration().applyMigration(plan).success, false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(migration().planMigration(f.root, f.assets).blocked, true);
});

test('plain-folder readiness is nonmutating and remember-dont-ask remains caller-owned', async (t) => {
  const f = fixture(t);
  const first = await readiness().ensureProjectReady({ root: f.root, assetRoot: f.assets, trusted: true });
  assert.equal(first.status, 'setup-required');
  assert.equal(first.actions[0].id, 'setup-workspace');
  const suppressed = await readiness().ensureProjectReady({ root: f.root, assetRoot: f.assets, trusted: true, dontAskHere: true });
  assert.equal(suppressed.status, 'suppressed');
  assert.deepEqual(fs.readdirSync(f.root), []);
});

test('explicit setup authorizes creation and subsequent health checks are read-only and cached', async (t) => {
  const f = fixture(t);
  const options = { root: f.root, assetRoot: f.assets, trusted: true, explicitSetup: true };
  const initial = await readiness().ensureProjectReady(options);
  assert.equal(initial.ready, true, JSON.stringify(initial.diagnostics));
  const before = tree(f.root);
  const cached = await readiness().ensureProjectReady({ ...options, explicitSetup: false });
  assert.equal(cached.ready, true);
  assert.equal(cached.cached, true);
  assert.deepEqual(tree(f.root), before);
  write(f.assets, 'guide.md', 'Bundled guide upgrade');
  const upgraded = await readiness().ensureProjectReady({ ...options, explicitSetup: false });
  assert.equal(upgraded.ready, true);
  assert.equal(fs.readFileSync(path.join(f.root, '.inkwell/guide.md'), 'utf8'), 'Bundled guide upgrade');
});

test('untrusted, read-only, and untitled readiness returns diagnosis without mutation', async (t) => {
  const f = fixture(t);
  for (const options of [{ root: f.root, trusted: false }, { root: f.root, trusted: true, readOnly: true }, { trusted: true }]) {
    const result = await readiness().ensureProjectReady({ assetRoot: f.assets, explicitSetup: true, ...options });
    assert.equal(result.status, 'blocked');
    assert.equal(result.actions.length, 0);
  }
  assert.deepEqual(fs.readdirSync(f.root), []);
});
