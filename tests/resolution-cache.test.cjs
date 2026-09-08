const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function fixture(t, watchMode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-resolution-'));
  const home = path.join(root, 'home'), project = path.join(root, 'project'), builtin = path.join(root, 'templates');
  for (const dir of [home, project, builtin]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(builtin, 'inkwell.latex'), 'built in');
  const counts = { readdir: 0, read: 0, open: 0, metadata: 0, watch: 0, parse: 0 }, live = new Set(), watched = [];
  let directoryHook, openHook, readHook, statHook;
  const watchedFs = { ...fs,
    readdirSync(...args) { counts.readdir++; directoryHook?.(...args); return fs.readdirSync(...args); },
    readFileSync(...args) { counts.read++; readHook?.(...args); return fs.readFileSync(...args); },
    openSync(...args) { counts.open++; openHook?.(...args); return fs.openSync(...args); },
    lstatSync(...args) { counts.metadata++; const stat = fs.lstatSync(...args); return statHook?.(args[0], stat) || stat; },
    realpathSync(...args) { counts.metadata++; return fs.realpathSync(...args); },
    watch(directory, options, callback) {
      counts.watch++;
      assert.equal(options.persistent, false);
      if (watchMode?.(directory, counts.watch)) throw new Error('watch unsupported');
      const watcher = new EventEmitter(); watcher.directory = directory; watcher.callback = callback;
      watcher.close = () => { if (live.delete(watcher)) watcher.emit('close'); };
      live.add(watcher); watched.push(watcher); return watcher;
    },
  };
  let workspace;
  const environment = { ...process.env }; delete environment.INKWELL_HEADLESS;
  const modules = new Map();
  const load = name => {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} }; modules.set(name, module);
    const code = fs.readFileSync(path.join(__dirname, '..', 'out', name + '.js'), 'utf8');
    vm.runInNewContext(code, { module, exports: module.exports, __dirname: path.join(root, 'out'), process: { env: environment }, Buffer,
      JSON: { stringify: JSON.stringify, parse(...args) { counts.parse++; return JSON.parse(...args); } },
      require(request) {
        if (request === 'fs') return watchedFs;
        if (request === 'os') return { ...os, homedir: () => home };
        if (request === 'vscode') return { Uri: { file: fsPath => ({ fsPath }) }, workspace: { getWorkspaceFolder: () => workspace && { uri: { fsPath: workspace } } } };
        if (request === './document-config' || request === './bibliography-service') return {};
        if (request === './template-assets') return { templateAssetCache: { acquire() { throw new Error('resolution must not acquire asset leases'); } } };
        if (request.startsWith('./')) return load(request.slice(2));
        return require(request);
      },
    }, { filename: name + '.js' });
    return module.exports;
  };
  const cache = load('resolution-cache'), config = load('config'), templates = load('templates');
  t.after(() => { cache.disposeResolutionCaches(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = (file, contents) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, contents); return file; };
  const template = (directory, id, name, extra = {}) => {
    const dir = path.join(directory, id);
    write(path.join(dir, 'template.latex'), name);
    write(path.join(dir, 'template.json'), JSON.stringify({ name, ...extra }));
    return dir;
  };
  return { root, home, project, builtin, counts, live, watched, cache, config, templates, environment, write, template,
    onOpen: hook => { openHook = hook; }, onReadFile: hook => { readHook = hook; }, onReadDirectory: hook => { directoryHook = hook; }, onStat: hook => { statHook = hook; }, uri: source => ({ fsPath: source }), setWorkspace: value => { workspace = value; } };
}

function list(f, source) { return f.templates.listTemplates(source ? f.uri(source) : undefined); }

test('imports and activation context lookup are passive; first actual resolution starts bounded watchers', t => {
  const f = fixture(t);
  assert.deepEqual(f.counts, { readdir: 0, read: 0, open: 0, metadata: 0, watch: 0, parse: 0 });
  const source = f.write(path.join(f.project, 'doc.md'), ''); fs.mkdirSync(path.join(f.project, '.inkwell'));
  assert.equal(f.config.findInkwellRoot(f.uri(source)), f.project);
  assert.equal(f.counts.watch, 0, 'activation context lookup does not start watchers');
  assert.equal(f.config.getInkwellProjectRoot(source), f.project);
  const watches = f.counts.watch;
  assert.ok(watches > 0);
  assert.equal(f.config.getInkwellProjectRoot(source), f.project);
  assert.equal(f.counts.watch, watches);
  assert.equal(f.counts.readdir, 0); assert.equal(f.counts.read, 0);
});

test('workspace-first artifact roots and nearest template roots remain distinct through reassignment', t => {
  const f = fixture(t), nested = path.join(f.project, 'nested'), source = f.write(path.join(nested, 'doc.md'), '');
  fs.mkdirSync(path.join(f.project, '.inkwell')); fs.mkdirSync(path.join(nested, '.inkwell'));
  f.setWorkspace(f.project);
  assert.equal(f.config.getInkwellProjectRoot(source), f.project);
  assert.equal(f.config.findInkwellRoot(f.uri(source)), nested);
  f.setWorkspace(f.home);
  assert.equal(f.config.getInkwellProjectRoot(source), nested);
  f.setWorkspace(undefined);
  assert.equal(f.config.getInkwellProjectRoot(source), nested);
  f.setWorkspace(f.project); fs.rmSync(path.join(f.project, '.inkwell'), { recursive: true });
  assert.equal(f.config.getInkwellProjectRoot(source), nested, 'marker deletion is observed before watch delivery');
});

test('missing nested roots and intermediate directories become visible before watch events', t => {
  const f = fixture(t), directory = path.join(f.project, 'new', 'deep'), source = path.join(directory, 'doc.md');
  f.config.getInkwellProjectRoot(source);
  assert.equal(f.config.findInkwellRoot(f.uri(source)), undefined);
  assert.ok(f.watched.some(watcher => watcher.directory === f.project), 'nearest existing parent covers missing directories');
  fs.mkdirSync(path.join(directory, '.inkwell'), { recursive: true });
  assert.equal(f.config.findInkwellRoot(f.uri(source)), directory);
  fs.rmSync(path.join(directory, '.inkwell'), { recursive: true });
  fs.mkdirSync(path.join(f.project, '.inkwell'));
  assert.equal(f.config.findInkwellRoot(f.uri(source)), f.project, 'all ancestor marker candidates are guarded');
  fs.rmSync(path.join(f.project, '.inkwell'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.inkwell'), 'ordinary file');
  assert.equal(f.config.findInkwellRoot(f.uri(source)), undefined);
});

test('root cache rejects marker and workspace symlink escapes immediately', t => {
  const f = fixture(t), source = f.write(path.join(f.project, 'doc.md'), '');
  fs.mkdirSync(path.join(f.project, '.inkwell'));
  assert.equal(f.config.getInkwellProjectRoot(source), f.project);
  fs.rmSync(path.join(f.project, '.inkwell'), { recursive: true });
  fs.symlinkSync(f.home, path.join(f.project, '.inkwell'), 'dir');
  assert.equal(f.config.findInkwellRoot(f.uri(source)), undefined);
  fs.unlinkSync(path.join(f.project, '.inkwell')); fs.mkdirSync(path.join(f.project, '.inkwell'));
  fs.symlinkSync(f.home, path.join(f.project, 'escape'), 'dir'); f.setWorkspace(f.project);
  assert.equal(f.config.findInkwellRoot(f.uri(path.join(f.project, 'escape', 'doc.md'))), undefined);
  assert.equal(f.config.getInkwellProjectRoot(path.join(f.project, 'escape', 'doc.md')), path.join(f.project, 'escape'));
});

test('warm template calls retain parsed immutable objects with bounded shallow inventory and manifest byte checks', t => {
  const f = fixture(t); f.template(f.builtin, 'paper', 'Paper', { variables: { color: 'blue' }, features: [{ pattern: 'x', syntax: 'x', description: 'X' }] });
  const first = list(f), original = first.get('paper'), counts = { ...f.counts };
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.manifest) && Object.isFrozen(original.manifest.variables) && Object.isFrozen(original.manifest.features[0]) && Object.isFrozen(original.supportingFiles));
  assert.throws(() => original.supportingFiles.push('/outside/file.sty'));
  assert.equal(Reflect.set(original.manifest.variables, 'color', 'red'), false);
  first.clear(); first.set('poison', {});
  const warm = list(f);
  assert.equal(warm.get('paper'), original); assert.equal(warm.has('poison'), false);
  assert.ok(f.counts.readdir > counts.readdir && f.counts.readdir - counts.readdir <= 3, 'warm guards only check the observed shallow directories');
  assert.equal(f.counts.read - counts.read, 1, 'only the parsed manifest bytes need a content digest');
  assert.equal(f.counts.open - counts.open, 1); assert.equal(f.counts.watch, counts.watch); assert.equal(f.counts.parse, counts.parse, 'warm lookup does not parse the manifest again');
});

test('template sources preserve built-in, global, project and headless precedence without cross-document leakage', t => {
  const f = fixture(t), globals = path.join(f.home, '.inkwell', 'templates'), projects = path.join(f.project, '.inkwell', 'templates');
  f.template(f.builtin, 'paper', 'Builtin'); f.template(globals, 'paper', 'Global'); f.template(projects, 'paper', 'Project');
  const source = f.write(path.join(f.project, 'doc.md'), '');
  assert.equal(list(f).get('paper').manifest.name, 'Global');
  assert.equal(list(f, source).get('paper').manifest.name, 'Project');
  assert.equal(list(f).get('paper').manifest.name, 'Global');
  f.environment.INKWELL_HEADLESS = '1';
  assert.equal(list(f).get('paper').manifest.name, 'Builtin');
  assert.equal(list(f, source).get('paper').manifest.name, 'Project');
  delete f.environment.INKWELL_HEADLESS;
  assert.equal(list(f).get('paper').manifest.name, 'Global');
});

test('manifest-only overrides preserve existing templates and new IDs retain their fallback', t => {
  const f = fixture(t), globals = path.join(f.home, '.inkwell', 'templates');
  f.template(f.builtin, 'paper', 'Builtin');
  f.write(path.join(globals, 'paper', 'template.json'), '{"name":"Incomplete override"}');
  f.write(path.join(globals, 'new', 'template.json'), '{"name":"New fallback"}');
  const result = list(f);
  assert.equal(result.get('paper').manifest.name, 'Builtin');
  assert.equal(result.get('new').pandocTemplate, path.join(f.builtin, 'inkwell.latex'));
});

test('new global, project and nested template directories invalidate cached absence before events', t => {
  const f = fixture(t), source = f.write(path.join(f.project, 'deep', 'doc.md'), '');
  assert.equal(list(f, source).has('paper'), false);
  f.template(path.join(f.home, '.inkwell', 'templates'), 'paper', 'Global');
  assert.equal(list(f, source).get('paper').manifest.name, 'Global');
  f.template(path.join(f.project, '.inkwell', 'templates'), 'paper', 'Project');
  assert.equal(list(f, source).get('paper').manifest.name, 'Project');
  f.template(path.join(f.project, 'deep', '.inkwell', 'templates'), 'paper', 'Nested');
  assert.equal(list(f, source).get('paper').manifest.name, 'Nested');
  fs.rmSync(path.join(f.project, 'deep', '.inkwell'), { recursive: true });
  assert.equal(list(f, source).get('paper').manifest.name, 'Project');
});

test('manifest edits and support inventory changes are guarded before asynchronous watcher delivery', t => {
  const f = fixture(t), dir = f.template(f.builtin, 'paper', 'First'), manifest = path.join(dir, 'template.json');
  const first = list(f).get('paper'); assert.equal(first.manifest.name, 'First');
  const stat = fs.statSync(manifest); fs.writeFileSync(manifest, '{"name":"Other"}'); fs.utimesSync(manifest, stat.atime, stat.mtime);
  assert.equal(list(f).get('paper').manifest.name, 'Other', 'ctime catches same-size edits with restored mtime');
  const support = f.write(path.join(dir, 'fonts', 'nested', 'font.otf'), 'font');
  assert.deepEqual([...list(f).get('paper').supportingFiles], [support]);
  const renamed = path.join(path.dirname(support), 'new.otf'); fs.renameSync(support, renamed);
  assert.deepEqual([...list(f).get('paper').supportingFiles], [renamed]);
  fs.rmSync(path.join(dir, 'fonts'), { recursive: true });
  assert.equal(list(f).get('paper').supportingFiles.length, 0);
  fs.rmSync(path.join(dir, 'template.latex')); f.write(path.join(dir, 'template.tex'), 'tex');
  assert.equal(list(f).get('paper').pandocTemplate, path.join(dir, 'template.tex'));
  f.write(path.join(dir, 'preferred.latex'), 'latex');
  assert.equal(list(f).get('paper').pandocTemplate, path.join(dir, 'preferred.latex'));
  fs.rmSync(dir, { recursive: true }); assert.equal(list(f).has('paper'), false);
});

function freezeContentMetadata(f, selected) {
  const original = new Map();
  f.onStat((file, stat) => {
    if (!selected(file, stat)) return stat;
    if (!original.has(file)) original.set(file, stat);
    const first = original.get(file);
    // Model filesystems where rapid changes share the same timestamp tick and
    // directory allocation size. Preserve real mode/inode/identity guards.
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
      Object.fromEntries(['size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].map(key => [key, first[key]])));
  });
}

test('directory entry guards detect same-clock additions, renames and mid-scan mutations', t => {
  const f = fixture(t), directory = f.template(f.builtin, 'paper', 'Paper');
  freezeContentMetadata(f, (_file, stat) => stat.isDirectory());
  fs.rmSync(path.join(directory, 'template.latex')); f.write(path.join(directory, 'template.tex'), 'tex');
  const original = list(f).get('paper');
  const preferred = f.write(path.join(directory, 'preferred.latex'), 'latex');
  assert.equal(list(f).get('paper').pandocTemplate, preferred);
  assert.notEqual(list(f).get('paper'), original, 'new candidates invalidate reconstructed template objects');
  const support = f.write(path.join(directory, 'before.sty'), 'style');
  assert.deepEqual([...list(f).get('paper').supportingFiles], [support]);
  const renamed = path.join(directory, 'after.sty'); fs.renameSync(support, renamed);
  assert.deepEqual([...list(f).get('paper').supportingFiles], [renamed]);
  for (const options of [{ enabled: false }, { maxDependencies: 0 }, { maxEntries: 0 }]) {
    const cache = new f.cache.ResolutionCache(options); t.after(() => cache.dispose());
    let attempt = 0;
    assert.throws(() => cache.get('same-clock-race', snapshot => {
      snapshot.directory(directory); snapshot.inspect(directory, false);
      f.write(path.join(directory, `new-${options.maxEntries}-${options.maxDependencies}-${attempt++}.sty`), 'style');
      return 'incomplete inventory';
    }), /resolution changed while reading/);
    assert.equal(attempt, 2);
  }
});

test('same-size same-clock manifest edits and malformed repairs invalidate only the parsed value', t => {
  const f = fixture(t), directory = f.template(f.builtin, 'paper', 'First'), manifest = path.join(directory, 'template.json');
  freezeContentMetadata(f, file => file === manifest);
  const original = list(f).get('paper'), bytes = fs.readFileSync(manifest);
  fs.writeFileSync(manifest, '{"name":"Other"}');
  assert.equal(fs.statSync(manifest).size, bytes.length);
  const changed = list(f).get('paper');
  assert.equal(changed.manifest.name, 'Other'); assert.notEqual(changed, original);
  assert.equal(list(f).get('paper'), changed, 'unchanged bytes retain immutable object identity');
  fs.writeFileSync(manifest, '{"name":'.padEnd(bytes.length, ' '));
  assert.equal(list(f).get('paper').manifest.name, 'paper', 'malformed input retains the native fallback');
  fs.writeFileSync(manifest, '{"name":"First"}');
  assert.equal(list(f).get('paper').manifest.name, 'First', 'repair is observed even when all metadata aliases');
});

test('cached template paths cannot escape through changed directory, manifest or support symlinks', t => {
  const f = fixture(t), globals = path.join(f.home, '.inkwell', 'templates'), dir = f.template(globals, 'paper', 'Safe');
  list(f);
  const outside = f.template(f.project, 'foreign', 'Foreign');
  f.write(path.join(outside, 'evil.sty'), 'outside');
  fs.symlinkSync(outside, path.join(dir, 'linked'), 'dir');
  fs.symlinkSync(path.join(outside, 'evil.sty'), path.join(dir, 'evil.sty'));
  fs.rmSync(path.join(dir, 'template.json')); fs.symlinkSync(path.join(outside, 'template.json'), path.join(dir, 'template.json'));
  const guarded = list(f).get('paper'); assert.equal(guarded.manifest.name, 'paper'); assert.equal(guarded.supportingFiles.length, 0);
  fs.rmSync(dir, { recursive: true }); fs.symlinkSync(outside, dir, 'dir');
  assert.equal(list(f).has('paper'), false);
  fs.rmSync(globals, { recursive: true }); fs.symlinkSync(f.project, globals, 'dir');
  assert.equal(list(f).has('foreign'), false, 'global root remains contained in home');
});

test('watch events only invalidate entries and never initiate scans or resurrect disposed watchers', t => {
  const f = fixture(t); f.template(f.builtin, 'paper', 'Paper');
  const original = list(f).get('paper'), watched = f.watched.find(watcher => watcher.directory === f.builtin);
  const scans = f.counts.readdir; watched.callback('rename', 'paper');
  assert.equal(f.counts.readdir, scans, 'events do not scan');
  assert.notEqual(list(f).get('paper'), original);
  f.cache.disposeResolutionCaches(); assert.equal(f.live.size, 0);
  const watches = f.counts.watch;
  for (const watcher of f.watched) watcher.callback('rename', 'late');
  list(f); list(f);
  assert.equal(f.counts.watch, watches); assert.equal(f.live.size, 0);
});

test('throwing and asynchronously failing watchers retire entries and fall back without leaked handles', t => {
  const f = fixture(t, (_directory, call) => call % 2 === 0); f.template(f.builtin, 'paper', 'Paper');
  list(f); const scans = f.counts.readdir;
  assert.equal(f.live.size, 0, 'partial watch acquisition is cleaned up');
  list(f); assert.ok(f.counts.readdir > scans); assert.equal(f.live.size, 0);
  const g = fixture(t); g.template(g.builtin, 'paper', 'Paper');
  list(g); const previousScans = g.counts.readdir;
  g.watched.find(watcher => watcher.directory === g.builtin).emit('error', new Error('unsupported'));
  assert.equal(g.live.size, 0); assert.equal(g.counts.readdir, previousScans);
  list(g); assert.ok(g.counts.readdir > previousScans);
});

test('cache entry, watcher and dependency bounds release evictions and preserve uncached values', t => {
  const f = fixture(t), calls = new Map();
  const cache = new f.cache.ResolutionCache({ maxEntries: 2, maxWatchers: 2, watch: (dir, options, callback) => {
    const watcher = new EventEmitter(); watcher.close = () => f.live.delete(watcher); f.live.add(watcher); return watcher;
  } });
  t.after(() => cache.dispose());
  const dirs = ['one', 'two', 'three'].map(name => { const dir = path.join(f.project, name); fs.mkdirSync(dir); return dir; });
  const resolve = dir => snapshot => { calls.set(dir, (calls.get(dir) || 0) + 1); snapshot.directory(dir); return dir; };
  for (const dir of dirs) { assert.equal(cache.get(dir, resolve(dir)), dir); assert.ok(f.live.size <= 2); }
  cache.get(dirs[2], resolve(dirs[2])); assert.equal(calls.get(dirs[2]), 1);
  cache.get(dirs[0], resolve(dirs[0])); assert.equal(calls.get(dirs[0]), 2);
  cache.dispose(); assert.equal(f.live.size, 0); cache.start(); cache.get(dirs[0], resolve(dirs[0])); assert.equal(f.live.size, 0);
  let count = 0;
  const bounded = new f.cache.ResolutionCache({ maxDependencies: 1 });
  t.after(() => bounded.dispose());
  const many = snapshot => { count++; snapshot.directory(dirs[0]); snapshot.directory(dirs[1]); return 'complete result'; };
  assert.equal(bounded.get('large', many), 'complete result'); assert.equal(bounded.get('large', many), 'complete result'); assert.equal(count, 2);
});


test('missing source descendants preserve workspace priority and cannot cross live or dangling ancestor links', t => {
  const f = fixture(t), nested = path.join(f.project, 'nested');
  fs.mkdirSync(path.join(f.project, '.inkwell')); fs.mkdirSync(path.join(nested, '.inkwell'), { recursive: true });
  f.setWorkspace(f.project);
  assert.equal(f.config.getInkwellProjectRoot(path.join(nested, 'not-created', 'doc.md')), f.project);
  fs.symlinkSync(f.home, path.join(f.project, 'escape'), 'dir');
  const escaped = path.join(f.project, 'escape', 'missing', 'doc.md');
  assert.equal(f.config.findInkwellRoot(f.uri(escaped)), undefined);
  assert.equal(f.config.getInkwellProjectRoot(escaped), path.dirname(escaped));
  fs.symlinkSync(path.join(f.home, 'not-created'), path.join(f.project, 'dangling'), 'dir');
  const dangling = path.join(f.project, 'dangling', 'deeper', 'doc.md');
  assert.equal(f.config.findInkwellRoot(f.uri(dangling)), undefined);
  assert.equal(f.config.getInkwellProjectRoot(dangling), path.dirname(dangling));
});

for (const mode of ['cached', 'disposed', 'over-limit', 'unsupported']) {
  test(`a template directory swapped during scanning never publishes escaping paths (${mode})`, t => {
    const f = fixture(t, mode === 'unsupported' ? () => true : undefined);
    const dir = f.template(f.builtin, 'paper', 'Safe'), outside = f.template(f.project, 'foreign', 'Foreign');
    f.write(path.join(outside, 'foreign.sty'), 'outside');
    if (mode === 'disposed') f.cache.disposeResolutionCaches();
    if (mode === 'over-limit') f.cache.resolutionCache = new f.cache.ResolutionCache({ maxDependencies: 0 });
    let swapped = false;
    f.onReadDirectory(directory => {
      if (directory !== dir || swapped) return;
      swapped = true; fs.rmSync(dir, { recursive: true }); fs.symlinkSync(outside, dir, 'dir');
    });
    const result = list(f);
    assert.equal(swapped, true); assert.equal(result.has('paper'), false);
    assert.equal([...result.values()].some(value => value.manifest.name === 'Foreign' || value.supportingFiles.some(file => file.includes('foreign'))), false);
  });
}

test('repeated concurrent filesystem changes fail explicitly instead of returning unstable uncached values', t => {
  const f = fixture(t), directory = path.join(f.project, 'changing'); fs.mkdirSync(directory);
  for (const options of [{ enabled: false }, { maxDependencies: 0 }, { maxEntries: 0 }]) {
    const cache = new f.cache.ResolutionCache(options); t.after(() => cache.dispose());
    let attempt = 0;
    assert.throws(() => cache.get('racing', snapshot => {
      snapshot.directory(directory); f.write(path.join(directory, `new-${options.maxEntries}-${options.maxDependencies}-${attempt++}`), 'change'); return 'unsafe';
    }), /resolution changed while reading/);
    assert.equal(attempt, 2);
  }
});

test('unrelated ancestor activity does not invalidate identity guards or downgrade template inventory guards', t => {
  const f = fixture(t), directory = path.join(f.project, 'observed'); fs.mkdirSync(directory);
  const cache = new f.cache.ResolutionCache({ enabled: false }); t.after(() => cache.dispose());
  assert.equal(cache.get('root-identity', snapshot => {
    snapshot.inspect(directory, false); f.write(path.join(directory, 'unrelated'), 'changed'); return 'stable root';
  }), 'stable root');
  let attempt = 0;
  assert.throws(() => cache.get('template-inventory', snapshot => {
    snapshot.directory(directory); snapshot.inspect(directory, false);
    f.write(path.join(directory, `new-support-${attempt++}.sty`), 'new'); return 'incomplete inventory';
  }), /resolution changed while reading/);
});

test('an unreadable optional global root leaves built-ins usable through uncached resolution', t => {
  const f = fixture(t), globalRoot = path.join(f.home, '.inkwell');
  f.template(path.join(globalRoot, 'templates'), 'private', 'Private');
  fs.chmodSync(globalRoot, 0o000);
  try {
    if (fs.existsSync(path.join(globalRoot, 'templates'))) { t.skip('filesystem does not enforce directory permissions'); return; }
    assert.equal(list(f).has('inkwell'), true);
    const scans = f.counts.readdir;
    assert.equal(list(f).has('private'), false); assert.ok(f.counts.readdir > scans, 'unavailable metadata is not cached');
  } finally { fs.chmodSync(globalRoot, 0o700); }
  assert.equal(list(f).get('private').manifest.name, 'Private');
});


for (const operation of ['open', 'read']) {
  test(`a transient manifest ${operation} failure recovers without metadata or watcher changes`, t => {
    const f = fixture(t), dir = f.template(f.builtin, 'paper', 'Recovered real name');
    const manifest = path.join(dir, 'template.json'), original = fs.statSync(manifest);
    let failed = false;
    const failOnce = file => {
      if (!failed && (operation === 'read' ? typeof file === 'number' : file === manifest)) {
        failed = true; throw Object.assign(new Error('temporary I/O failure'), { code: 'EIO' });
      }
    };
    if (operation === 'open') f.onOpen(failOnce); else f.onReadFile(failOnce);
    assert.equal(list(f).get('paper').manifest.name, 'paper'); assert.equal(failed, true);
    assert.equal(list(f).get('paper').manifest.name, 'Recovered real name');
    const after = fs.statSync(manifest);
    assert.equal(after.ino, original.ino); assert.equal(after.mtimeMs, original.mtimeMs); assert.equal(after.ctimeMs, original.ctimeMs);
  });
}


test('intentional workspace-root aliases retain project policy without accepting escaping descendants', t => {
  const f = fixture(t), source = f.write(path.join(f.project, 'nested', 'doc.md'), '');
  fs.mkdirSync(path.join(f.project, '.inkwell'));
  const alias = path.join(f.root, 'workspace-alias'); fs.symlinkSync(f.project, alias, 'dir');
  const aliasedSource = path.join(alias, 'nested', path.basename(source)); f.setWorkspace(alias);
  f.template(path.join(f.project, '.inkwell', 'templates'), 'paper', 'Alias project paper');
  assert.equal(f.config.getInkwellProjectRoot(aliasedSource), alias);
  assert.equal(f.config.findInkwellRoot(f.uri(aliasedSource)), alias);
  assert.equal(list(f, aliasedSource).get('paper').manifest.name, 'Alias project paper');
  assert.equal(f.config.getInkwellProjectRoot(aliasedSource), alias, 'warm aliases preserve the chosen spelling');
  fs.symlinkSync(f.home, path.join(f.project, 'outside'), 'dir');
  const escape = path.join(alias, 'outside', 'missing', 'doc.md');
  assert.equal(f.config.findInkwellRoot(f.uri(escape)), undefined);
  assert.equal(f.config.getInkwellProjectRoot(escape), path.dirname(escape));
});
