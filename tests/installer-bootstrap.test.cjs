const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const script = path.resolve(__dirname, '../scripts/install-inkwell-macos.sh');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(t, settings = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-bootstrap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const trace = path.join(root, 'trace.jsonl');
  const helper = path.join(root, 'fake-tools.cjs');
  fs.writeFileSync(helper, `
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [name,...args]=process.argv.slice(2),root=process.env.INKWELL_FIXTURE_ROOT;
fs.appendFileSync(path.join(root,'trace.jsonl'),JSON.stringify({name,args})+'\\n');
if(name==='uname')process.stdout.write('Darwin\\n');
else if(name==='brew'){if(args[0]==='--prefix')process.stdout.write(root+'\\n');}
else if(name==='curl'){
 const target=args[args.indexOf('--output')+1];
 fs.writeFileSync(target,target.endsWith('SHA256SUMS')?(process.env.INKWELL_BAD_SUMS?'missing':'${crypto.createHash('sha256').update('release-fixture').digest('hex')}  inkwell-0.5.0.vsix\\n'):'release-fixture');
}else if(name==='unzip'){
 const out=path.join(args[args.indexOf('-d')+1],'extension','out');fs.mkdirSync(out,{recursive:true});
 if(!process.env.INKWELL_NO_INSTALLER)fs.writeFileSync(path.join(out,'install-cli.js'),'fixture');
}else if(name==='node'){
 if(args[0]==='--version')process.stdout.write('v25.0.0\\n');
 else {process.stdout.write('Observed artifact installer\\n');process.exitCode=Number(process.env.INKWELL_INSTALL_EXIT||0);}
}
`);
  for (const name of ['uname', 'brew', 'node', 'unzip', 'curl']) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} ${quote(name)} "$@"\n`, { mode: 0o755 });
  }
  const artifact = path.join(root, "release 'quoted' $(touch sentinel).vsix");
  fs.writeFileSync(artifact, 'release-fixture');
  // A caller's unrelated requirements must never be read by the bootstrap.
  fs.writeFileSync(path.join(root, 'requirements-latex.txt'), 'MUST-NOT-INSTALL-THIS');
  const run = args => cp.spawnSync('/bin/bash', [script, ...args], { cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, INKWELL_FIXTURE_ROOT: root, ...settings } });
  return { root, artifact, run, calls: () => fs.existsSync(trace) ? fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}

for (const editor of ['auto','all','cursor','code']) test(`bootstrap passes exact VSIX and ${editor} selection as literal argv without npm`, t => {
  const f=fixture(t);const result=f.run([`--vsix=${f.artifact}`,`--editor=${editor}`]);
  assert.equal(result.status,0,result.stderr);
  const call=f.calls().find(call=>call.name==='node'&&call.args[0]!=='--version');
  assert.ok(call.args.includes(`--vsix=${f.artifact}`));
  assert.ok(call.args.includes(`--editor=${editor}`));
  assert.ok(call.args.includes('--yes'));
  assert.equal(fs.existsSync(path.join(f.root,'sentinel')),false);
  assert.equal(f.calls().some(call=>call.name==='npm'||call.args.includes('MUST-NOT-INSTALL-THIS')),false);
});
test('bootstrap propagates artifact installer failure without announcing completion', t => {
  const f=fixture(t,{INKWELL_INSTALL_EXIT:'17'});const result=f.run([`--vsix=${f.artifact}`]);
  assert.equal(result.status,17);assert.doesNotMatch(result.stdout,/complete/i);
});
test('remote release requires a checksum matching the requested artifact name', t => {
  const f=fixture(t,{INKWELL_BAD_SUMS:'1'});const result=f.run([]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/checksum/);
  assert.equal(f.calls().some(call=>call.name==='unzip'),false);
});
test('checksum mismatch and missing installer payload both fail before executing the artifact', t => {
  const f=fixture(t);const result=f.run([`--vsix=${f.artifact}`,`--sha256=${'0'.repeat(64)}`]);
  assert.notEqual(result.status,0);assert.match(result.stderr,/checksum/);
  const g=fixture(t,{INKWELL_NO_INSTALLER:'1'});const missing=g.run([`--vsix=${g.artifact}`]);
  assert.notEqual(missing.status,0);assert.match(missing.stderr,/does not contain/);
});
test('remote bootstrap validates checksum and uses the full profile', t => {
  const f=fixture(t);const result=f.run([]);
  assert.equal(result.status,0,result.stderr);
  assert.ok(f.calls().some(call=>call.name==='node'&&call.args.includes('--profile=full')));
});
test('standalone downgrade requires explicit consent before downloads or installation', t => {
  const f=fixture(t);const refused=f.run(['--allow-downgrade']);
  assert.equal(refused.status,2);assert.match(refused.stderr,/explicit --yes/);assert.deepEqual(f.calls(),[]);
  const allowed=f.run([`--vsix=${f.artifact}`,'--allow-downgrade','--yes']);
  assert.equal(allowed.status,0,allowed.stderr);
  assert.ok(f.calls().some(call=>call.name==='node'&&call.args.includes('--allow-downgrade')&&call.args.includes('--yes')));
});
for (const option of ['--profile=lean','--basictex']) test(`0.5 defers unsupported ${option} without installing anything`, t => {
  const f=fixture(t);const result=f.run([option]);
  assert.equal(result.status,2);assert.deepEqual(f.calls(),[]);
});
