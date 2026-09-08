const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { trackEditorProcesses } = require('../../scripts/check-extension-host.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function family(t, { parentExits = false, ignoresTerm = false } = {}) {
  const childCode = `${ignoresTerm ? 'process.on("SIGTERM", () => {});' : ''}setTimeout(() => process.exit(0), 10000);`;
  const code = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:'ignore'}); child.unref(); process.stdout.write(String(child.pid)+'\\n'); ${parentExits ? 'setTimeout(()=>process.exit(0),800)' : 'setTimeout(()=>process.exit(0),10000)'};`;
  const parent = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(parent, 'exit');
  const tracker = trackEditorProcesses(parent.pid);
  t.after(async () => { await tracker.close(); if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL'); });
  const child = Number((await once(parent.stdout, 'data'))[0].toString().trim());
  assert.ok(Number.isSafeInteger(child) && child > 1);
  return { parent, child, tracker, exited };
}

test('cleanup finds detached descendants and escalates an owned TERM-resistant process without touching a sibling', { timeout: 8000 }, async t => {
  const sibling = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
  t.after(() => { sibling.kill('SIGKILL'); });
  const { tracker, exited } = await family(t, { ignoresTerm: true });
  await pause(450);
  const result = await tracker.close(); await exited;
  assert.ok(result.observedProcesses >= 2); assert.deepEqual(result.survivors, []); assert.equal(result.error, undefined);
  assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null, 'Unrelated test sibling must stay alive.');
});

test('an observed detached child is still cleaned after its editor parent exits', { timeout: 8000 }, async t => {
  const { tracker, exited } = await family(t, { parentExits: true });
  await exited;
  const result = await tracker.close();
  assert.ok(result.observedProcesses >= 2); assert.deepEqual(result.survivors, []); assert.equal(result.error, undefined);
});
