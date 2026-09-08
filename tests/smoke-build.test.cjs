const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { runSmokeBuild } = require('../out/smoke-build');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fixture(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-smoke-process-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out', 'smoke-cli.js'), source);
  return { root, output: path.join(root, 'pdf') };
}

test('headless smoke success requires clean JSON and does not stream protocol output', async t => {
  const expected = { success: true, verified: true, pdfPath: '/fixture/verified.pdf', logs: ['compile passed'] };
  const f = fixture(t, `console.log(JSON.stringify(${JSON.stringify(expected)}));process.stderr.write('diagnostic only');`);
  const driver = `require(${JSON.stringify(require.resolve('../out/smoke-build'))}).runSmokeBuild(${JSON.stringify(f.root)},${JSON.stringify(f.output)}).then(result=>console.log(JSON.stringify(result)));`;
  const result = await promisify(execFile)(process.execPath, ['-e', driver], { timeout: 5000, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result.stdout), expected);
  assert.equal(result.stderr, '');
});

for (const source of ['process.stdout.write("not JSON")', 'process.stdout.write(JSON.stringify({success:true,verified:true}));process.exitCode=7']) {
  test(`smoke rejects an invalid process result: ${source}`, async t => {
    const f = fixture(t, source), result = await runSmokeBuild(f.root, f.output);
    assert.equal(result.success, false); assert.equal(result.verified, false);
  });
}

test('cancelling smoke stops the compiler child in its separate process group', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t, ''), ready = path.join(f.root, 'compiler-pid'), product = path.join(f.root, 'late-compiler-write');
  const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(product)},'continued'),1400);setInterval(()=>{},1000);`;
  fs.writeFileSync(path.join(f.root, 'out', 'smoke-cli.js'), `require(${JSON.stringify(require.resolve('../out/run-process'))}).executeRunProcess(process.execPath,['-e',${JSON.stringify(child)}],{cwd:__dirname,env:process.env}).then(()=>{});`);
  const controller = new AbortController(), work = runSmokeBuild(f.root, f.output, process.env, controller.signal);
  for (let attempt = 0; attempt < 200 && !fs.existsSync(ready); attempt++) await sleep(10);
  assert.ok(fs.existsSync(ready), 'compiler child must start before cancellation');
  const pid = Number(fs.readFileSync(ready, 'utf8'));
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} });
  controller.abort(); const result = await work;
  assert.equal(result.success, false); assert.equal(result.verified, false);
  if (!process.env.CI && /process-tree inspection failed:.*(?:\bEPERM\b|[Oo]peration not permitted)/.test(result.logs.join('\n'))) {
    t.skip('Local sandbox denies ps; the compiler descendant check must also pass with normal host permissions.'); return;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') break; throw error; }
    await sleep(10);
  }
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', 'compiler descendant must be gone when cleanup completes');
  await sleep(1500); assert.equal(fs.existsSync(product), false);
});
