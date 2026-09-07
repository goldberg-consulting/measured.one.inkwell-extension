const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { spawn } = require('node:child_process');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-install-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'inkwell', publisher: 'measure-one', version: '0.5.0' }));
  const selected = [{ id: 'cursor', label: 'Cursor', path: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor' }];
  const calls = [], output = [];
  const report = ready => ({ ready, mode: 'full', status: ready ? 'ok' : 'error', checks: [{ id: 'assets', status: options.assetsBroken ? 'error' : 'ok', message: 'Asset verification' }] });
  const replacements = {
    './doctor': { createDoctor: () => ({ invalidate() {}, run: async args => { calls.push(['doctor', args]); return report(args.mode === 'light' || options.finalReady !== false); } }) },
    './editor-installation': {
      detectEditors: async () => selected, selectEditors: editors => editors,
      installEditorArtifact: async (...args) => { calls.push(['install', ...args]); return { success: options.installed !== false, log: 'Observed editor result' }; },
      uninstallEditorArtifact: async (...args) => { calls.push(['uninstall', ...args]); return { success: true, log: 'Observed removal' }; },
    },
    './setup-orchestrator': { createFileSetupStore: () => ({}), createSetupOrchestrator: () => ({ run: async args => {
      calls.push(['setup', args]); return { status: options.setupStatus || 'complete', logs: [{ time: 'now', stage: 'complete', message: 'Recorded result' }] };
    } }) },
  };
  const original = Module._load;
  Module._load = function(request, parent, ...rest) {
    if (parent?.filename.endsWith(`${path.sep}install-cli.js`) && replacements[request]) return replacements[request];
    return original.call(this, request, parent, ...rest);
  };
  let api;
  try { delete require.cache[require.resolve('../out/install-cli')]; api = require('../out/install-cli'); }
  finally { Module._load = original; }
  const args = { extensionRoot: root, vsix: path.join(root, "release 'literal' $(no-shell).vsix"), selection: 'auto', profile: 'full', yes: true, expectedVersion: '0.5.0', outputRoot: path.join(root, 'verification') };
  return { root, calls, args, api, output, run: async () => {
    const stdout = process.stdout.write, stderr = process.stderr.write;
    process.stdout.write = process.stderr.write = chunk => { output.push(String(chunk)); return true; };
    try { return await api.runInstaller(args); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
  } };
}

test('the artifact installer reports complete only after a fresh full doctor verifies every selected editor', async t => {
  const f = fixture(t); assert.equal(await f.run(), 0);
  assert.equal(f.calls[0][0], 'doctor');
  assert.deepEqual(f.calls.map(call => call[0]), ['doctor', 'install', 'setup', 'doctor']);
  assert.equal(f.calls[1][1], f.args.vsix);
  assert.equal(f.calls[1][2], '0.5.0');
  assert.deepEqual(f.calls.at(-1)[1].expectedEditors, ['cursor']);
  assert.equal(f.calls.at(-1)[1].forceRefresh, true);
  assert.equal(f.calls.at(-1)[1].mode, 'full');
  assert.match(f.output.join(''), /installation complete/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.args.outputRoot, 'doctor.json'))).ready, true);
});

for (const scenario of [{ finalReady: false }, { setupStatus: 'cancelled' }, { setupStatus: 'failed' }]) {
  test(`the artifact installer cannot announce completion after ${JSON.stringify(scenario)}`, async t => {
    const f = fixture(t, scenario); assert.equal(await f.run(), 1);
    assert.doesNotMatch(f.output.join(''), /installation complete/);
  });
}

test('a partial editor installation stops setup and cannot report completion', async t => {
  const f = fixture(t, { installed: false }); await assert.rejects(f.run(), /partial or unverified/);
  assert.equal(f.calls.some(call => call[0] === 'setup'), false);
  assert.doesNotMatch(f.output.join(''), /installation complete/);
});

test('broken assets and a mismatched payload version fail before editor or system installation', async t => {
  const f = fixture(t, { assetsBroken: true }); await assert.rejects(f.run(), /Asset verification/);
  assert.deepEqual(f.calls.map(call => call[0]), ['doctor']);
  const other = fixture(t); other.args.expectedVersion = '0.5.1';
  await assert.rejects(other.run(), /identity\/version/); assert.deepEqual(other.calls, []);
});

test('cask removal invokes only version-aware editor removal, without doctor, repair, or project creation', async t => {
  const f = fixture(t); f.args.uninstall = true;
  assert.equal(await f.run(), 0); assert.deepEqual(f.calls.map(call => call[0]), ['uninstall']);
  assert.equal(f.calls[0][1], '0.5.0'); assert.equal(fs.existsSync(f.args.outputRoot), false);
});

test('SIGTERM during editor installation stops its process group before the installer exits', async t => {
  const f = fixture(t), ready = path.join(f.root, 'editor-pid'), product = path.join(f.root, 'late-editor-write');
  fs.writeFileSync(f.args.vsix, 'temporary artifact fixture');
  const fakeEditor = path.join(f.root, 'editor.cjs');
  fs.writeFileSync(fakeEditor, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>fs.writeFileSync(${JSON.stringify(product)},'continued'),700);setInterval(()=>{},1000);`);
  const driver = path.join(f.root, 'installer-driver.cjs');
  fs.writeFileSync(driver, `
const Module=require('node:module');const load=Module._load;
Module._load=function(request,parent,...rest){
 if(parent?.filename.endsWith('/install-cli.js')&&request==='./doctor')return {createDoctor:()=>({invalidate(){},run:async()=>({checks:[{id:'assets',status:'ok'},{id:'requirements-manifest',status:'ok'}]})})};
 if(parent?.filename.endsWith('/install-cli.js')&&request==='./editor-installation'){
  const real=load.call(this,request,parent,...rest);
  return {...real,detectEditors:async()=>[{id:'cursor',label:'Cursor',path:process.execPath,status:'ok'}],
    installEditorArtifact:(vsix,version,editors,options)=>real.installEditorArtifact(vsix,version,editors,{...options,
      execute:(command,args,settings,cancellation)=>options.execute(command,[${JSON.stringify(fakeEditor)},...args],settings,cancellation)})};
 }
 return load.call(this,request,parent,...rest);
};
require(${JSON.stringify(require.resolve('../out/install-cli'))}).runInstaller(${JSON.stringify(f.args)}).then(code=>{process.exitCode=code},error=>{console.error(error.message);process.exitCode=1});
`);
  const child = spawn(process.execPath, [driver], { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const closed = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  for (let attempt=0;attempt<200&&!fs.existsSync(ready);attempt++) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(fs.existsSync(ready), log);
  const pid = Number(fs.readFileSync(ready, 'utf8'));
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} });
  child.kill('SIGTERM'); const result = await closed;
  assert.equal(result.signal, null, 'signal must enter observed installer cancellation');
  assert.notEqual(result.code, 0);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.equal(fs.existsSync(product), false, 'the editor cannot continue installing after cancellation');
  assert.doesNotMatch(log, /installation complete/);
});
