const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('loading the extension defers document parsers until a document needs them', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const Module = require('node:module');
    const load = Module._load;
    const loaded = new Set();
    Module._load = function (id, ...args) {
      if (id === 'vscode') return {};
      if (['markdown-it', 'yaml', 'htmlparser2'].includes(id)) loaded.add(id);
      return load.call(this, id, ...args);
    };
    const extension = require('./out/extension.js');
    assert.equal(typeof extension.activate, 'function');
    assert.deepEqual([...loaded], [], 'document parsers must not initialize when loading the extension');
    const { createMarkdownParser } = require('./out/markdown-parser.js');
    const { yamlParser } = require('./out/yaml-parser.js');
    const { installSafeHtmlRendering } = require('./out/html-safety.js');
    const md = createMarkdownParser({ html: true });
    installSafeHtmlRendering(md);
    assert.match(md.render('**hello** <script>alert(1)</script>'), /<strong>hello<\\/strong>/);
    assert.doesNotMatch(md.render('<script>alert(1)</script>'), /<script>/);
    assert.equal(yamlParser().parseDocument('title: hello').toJS().title, 'hello');
    assert.deepEqual([...loaded].sort(), ['htmlparser2', 'markdown-it', 'yaml']);
  `], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
