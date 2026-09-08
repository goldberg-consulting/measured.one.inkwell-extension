const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { executeInstallerProcess } = require('../out/installer-process');
const { RunCancellation } = require('../out/run-process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "inkwell-install-process ' $()-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, options: { cwd: root, env: { ...process.env }, timeoutMs: 5000 } };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(file) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (fs.existsSync(file)) return;
    await sleep(10);
  }
  throw new Error(`Child never became ready: ${file}`);
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function sandboxDeniesProcessInspection(result) {
  return !process.env.CI && /process-tree inspection failed:.*(?:\bEPERM\b|[Oo]peration not permitted)/.test(result.error || '');
}

test('installer preserves literal argv, environment and the actual process exit status', async t => {
  const f = fixture(t), args = ['spaces and apostrophe\'', '$(must-not-run)', '; literal', 'line\nbreak'];
  const result = await executeInstallerProcess(process.execPath, ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),value:process.env.REVIEW_VALUE}));process.exit(7)', ...args],
    { ...f.options, env: { ...f.options.env, REVIEW_VALUE: 'literal value' } });
  assert.equal(result.exitCode, 7); assert.equal(result.rawExitCode, 7);
  assert.ok(result.stdout.includes(JSON.stringify({ args, value: 'literal value' })));
  assert.equal(result.cancelled, false);
});

test('macOS installer command retains a private controlling terminal', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const result = await executeInstallerProcess(process.execPath, ['-e', 'const fs=require("node:fs");const fd=fs.openSync("/dev/tty","r+");fs.closeSync(fd);console.log("private-tty="+Boolean(process.stdin.isTTY));'], f.options);
  if (!process.env.CI && /EPERM: operation not permitted, open '\/dev\/tty'/.test(result.stdout + result.stderr)) {
    t.skip('Local sandbox denies /dev/tty; this check must also pass with normal host permissions.'); return;
  }
  assert.equal(result.exitCode, 0, result.error); assert.equal(result.rawExitCode, 0);
  assert.match(result.stdout, /private-tty=true/);
});

test('a command startup failure remains a failure with no fabricated raw exit', async t => {
  const f = fixture(t);
  const result = await executeInstallerProcess(path.join(f.root, 'missing-command'), [], f.options);
  assert.notEqual(result.exitCode, 0); assert.equal(result.rawExitCode, null); assert.match(result.error, /ENOENT/);
});

for (const trigger of ['cancel', 'timeout']) test(`${trigger} stops a TERM-resistant grandchild and leaves siblings alive`, async t => {
  const f = fixture(t), ready = path.join(f.root, 'ready.json'), product = path.join(f.root, 'should-not-exist');
  const grandchild = `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setTimeout(()=>fs.writeFileSync(${JSON.stringify(product)},'continued'),1500);setInterval(()=>{},1000);`;
  const child = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'});setInterval(()=>{},1000);`;
  const sibling = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { try { sibling.kill('SIGKILL'); } catch {} });
  const cancellation = new RunCancellation();
  const work = executeInstallerProcess(process.execPath, ['-e', parent], { ...f.options, timeoutMs: trigger === 'timeout' ? 500 : 5000 }, cancellation);
  await waitFor(ready);
  const pid = JSON.parse(fs.readFileSync(ready, 'utf8')).pid;
  if (trigger === 'cancel') cancellation.cancel();
  const result = await work;
  assert.equal(trigger === 'cancel' ? result.cancelled : result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await sleep(10);
  assert.equal(alive(pid), false, 'grandchild must be reaped after cleanup');
  assert.equal(alive(sibling.pid), true, 'an unrelated sibling must remain alive');
  await sleep(1600);
  assert.equal(fs.existsSync(product), false);
});

test('normal completion cleans up background children before returning', async t => {
  const f = fixture(t), product = path.join(f.root, 'late-write');
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(product)},'late'),800)`)}],{stdio:'ignore'});child.unref();console.log('complete');`;
  const result = await executeInstallerProcess(process.execPath, ['-e', script], f.options);
  assert.equal(result.exitCode, 0, result.error); assert.equal(result.rawExitCode, 0);
  await sleep(900); assert.equal(fs.existsSync(product), false);
});

test('output overflow cancels the process group and keeps the retained output bounded', async t => {
  const f = fixture(t);
  const result = await executeInstallerProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000);'], { ...f.options, maxBuffer: 256 });
  assert.equal(result.maxBufferExceeded, true); assert.notEqual(result.exitCode, 0);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 256);
});

test('pre-cancelled installation launches no process', async t => {
  const f = fixture(t), marker = path.join(f.root, 'started'), cancellation = new RunCancellation(); cancellation.cancel();
  const result = await executeInstallerProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`], f.options, cancellation);
  assert.equal(result.cancelled, true); assert.equal(result.rawExitCode, null); assert.equal(fs.existsSync(marker), false);
});

test('synchronous process inspection failure retains its explicit diagnostic', async t => {
  const f = fixture(t), ready = path.join(f.root, 'inspection-ready');
  const cancellation = new RunCancellation();
  const work = executeInstallerProcess(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], f.options, cancellation);
  await waitFor(ready);
  const childProcess = require('node:child_process'), originalExecFile = childProcess.execFile;
  childProcess.execFile = function(command, ...args) {
    if (command === '/bin/ps') { const error = new Error('spawn EPERM'); error.code = 'EPERM'; throw error; }
    return originalExecFile.call(this, command, ...args);
  };
  try {
    cancellation.cancel(); const result = await work;
    assert.equal(result.cancelled, true); assert.notEqual(result.exitCode, 0);
    assert.match(result.error, /Installer cancellation is incomplete:.*Installer process-tree inspection failed:.*EPERM/);
  } finally { childProcess.execFile = originalExecFile; }
});

test('cancellation also stops a detached descendant in a separate process group', async t => {
  const f = fixture(t), ready = path.join(f.root, 'detached.json'), product = path.join(f.root, 'detached-write');
  const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(product)},'survived'),1200);setInterval(()=>{},1000);`;
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`;
  const cancellation = new RunCancellation();
  const work = executeInstallerProcess(process.execPath, ['-e', parent], f.options, cancellation);
  await waitFor(ready); const pid = Number(fs.readFileSync(ready, 'utf8'));
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} });
  cancellation.cancel(); const result = await work;
  if (sandboxDeniesProcessInspection(result)) {
    t.skip('Local sandbox denies ps; detached-process cleanup must also pass with normal host permissions.'); return;
  }
  assert.equal(result.cancelled, true); assert.equal(result.error, undefined);
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await sleep(10);
  assert.equal(alive(pid), false);
  await sleep(1300); assert.equal(fs.existsSync(product), false);
});

test('timeout during supervisor startup still stops its private PTY child', async t => {
  const f = fixture(t), preload = path.join(f.root, 'preload.cjs'), ready = path.join(f.root, 'preload-pid');
  fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);`);
  const work = executeInstallerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { ...f.options, env: { ...f.options.env, NODE_OPTIONS: `--require=${JSON.stringify(preload)}` }, timeoutMs: 75 });
  await waitFor(ready); const pid = Number(fs.readFileSync(ready, 'utf8'));
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} });
  const result = await work;
  if (sandboxDeniesProcessInspection(result)) {
    t.skip('Local sandbox denies ps; startup cancellation must also pass with normal host permissions.'); return;
  }
  assert.equal(result.timedOut, true); assert.equal(result.rawExitCode, null);
  assert.equal(result.error, undefined);
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await sleep(10);
  assert.equal(alive(pid), false);
});

test('uncontrollable privileged descendants report incomplete cancellation instead of claimed cleanup', async t => {
  const f = fixture(t), ready = path.join(f.root, 'privileged-pid');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});child.unref();setInterval(()=>{},1000);`;
  const cancellation = new RunCancellation();
  const work = executeInstallerProcess(process.execPath, ['-e', parent], f.options, cancellation);
  await waitFor(ready); const pid = Number(fs.readFileSync(ready, 'utf8'));
  const originalKill = process.kill;
  process.kill = function(target, signal) {
    if (target === pid && signal !== 0) { const error = new Error('Simulated privileged descendant'); error.code = 'EPERM'; throw error; }
    return originalKill.call(process, target, signal);
  };
  try {
    cancellation.cancel(); const result = await work;
    if (sandboxDeniesProcessInspection(result)) {
      t.skip('Local sandbox denies ps; the simulated privilege check must also pass with normal host permissions.'); return;
    }
    assert.equal(result.cancelled, true); assert.notEqual(result.exitCode, 0);
    assert.match(result.error, /cancellation is incomplete.*privileged descendants/);
    assert.match(result.stderr, /cancellation is incomplete/);
    assert.equal(alive(pid), true, 'unverified descendants must not be described as stopped');
  } finally {
    process.kill = originalKill;
    try { originalKill.call(process, -pid, 'SIGKILL'); } catch {}
  }
});
