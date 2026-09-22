import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkPrivateDocuments, isPrivateDocumentPath } from '../scripts/private-documents.mjs';

test('private deliverables are blocked even in asset folders and with uppercase extensions', () => {
  for (const name of ['examples/client-proposal.md', 'media/Expert-Qualifications.PDF', 'private/notes.txt', 'templates/client-documents/letter.sty']) assert.equal(isPrivateDocumentPath(name), true, name);
  for (const name of ['examples/demo-measured-report.md', 'media/preview-client.js', 'tests/private-documents.test.mjs']) assert.equal(isPrivateDocumentPath(name), false, name);
});

test('commit checks reject tracked deliverables and local private content without echoing it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inkwell-private-guard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init');
  fs.writeFileSync(path.join(root, 'draft-proposal.md'), 'client document'); git('add', '.');
  assert.throws(() => checkPrivateDocuments(root), /Private deliverable paths/);
  git('rm', '--cached', 'draft-proposal.md');
  fs.writeFileSync(path.join(root, 'example.md'), 'CONFIDENTIAL_FIXTURE_CLIENT'); git('add', 'example.md');
  git('config', '--local', 'inkwell.privateContentPattern', 'CONFIDENTIAL_FIXTURE_CLIENT');
  assert.throws(() => checkPrivateDocuments(root), error => /private-document denylist/.test(error.message) && !error.message.includes('CONFIDENTIAL_FIXTURE_CLIENT'));
});
