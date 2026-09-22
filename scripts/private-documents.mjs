import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

/** Client deliverables belong in separate workspaces, never in extension assets. */
export function isPrivateDocumentPath(value) {
  const parts = value.toLowerCase().replaceAll('\\', '/').split('/');
  if (parts.some(part => ['private', 'confidential', 'client-documents', 'proposals', 'qualifications'].includes(part))) return true;
  const name = parts.at(-1) || '';
  return /(?:proposal|qualifications)/.test(name) && /\.(?:md|markdown|tex|pdf|docx?|rtf|html|png|jpe?g|zip)(?:\.|$)/.test(name);
}

export function checkPrivateDocuments(root) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const forbidden = names.filter(isPrivateDocumentPath);
  if (forbidden.length) throw new Error(`Private deliverable paths are tracked: ${forbidden.join(', ')}. Keep client documents in a separate workspace.`);
  // Optional local-only denylist. Client identities must not be written into
  // the public guard, its tests, or a shared repository configuration file.
  const configured = spawnSync('git', ['config', '--local', '--get', 'inkwell.privateContentPattern'], { cwd: root, encoding: 'utf8' });
  if (configured.status === 0 && configured.stdout.trim()) {
    const found = spawnSync('git', ['grep', '--cached', '-I', '-i', '-l', '-E', '-e', configured.stdout.trim(), '--'], { cwd: root, encoding: 'utf8' });
    if (found.status === 0) throw new Error('The staged repository contains content matching the local private-document denylist. Inspect it locally before committing; matched contents are intentionally omitted.');
    if (found.status !== 1) throw new Error('Could not complete the local private-document check.');
  }
  return names.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(`Private-document check passed (${checkPrivateDocuments(process.cwd())} tracked paths).`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
