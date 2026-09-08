const test = require('node:test');
const assert = require('node:assert/strict');
const { createDocumentSnapshot } = require('../out/document-snapshot');
test('frozen editor API snapshots retain captured source without violating property invariants', () => {
  let liveText = 'first\r\nsecond', liveVersion = 3;
  const api = Object.freeze({ uri: { fsPath: '/fixture.md' }, getText: () => liveText, get version() { return liveVersion; } });
  const snapshot = createDocumentSnapshot(api);
  liveText = 'edited'; liveVersion++;
  assert.equal(snapshot.getText(), 'first\r\nsecond');
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.uri, api.uri);
  assert.equal(snapshot.lineCount, 2);
  assert.equal(snapshot.getText({ start: { line: 1, character: 1 }, end: { line: 1, character: 4 } }), 'eco');
  assert.equal(api.getText(), 'edited');
});
