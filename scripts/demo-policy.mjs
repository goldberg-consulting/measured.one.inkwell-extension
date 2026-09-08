import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const unresolvedPatterns = [
  /(?:Citeproc:\s*)?citation\s+['"]?[^\s'"]+['"]?\s+not found/i,
  /(?:Reference|Citation)\s+[`'"][^\n]+?undefined/i,
  /There were undefined (?:references|citations)/i,
  /(?:reference|citation)\s+[^\n]*?(?:not found|undefined|unresolved)/i,
  /^Unresolved placeholder\s+\{\{/i,
];

export function checkWarnings(log, demo, allowlist = []) {
  for (const item of allowlist) {
    if (!item.demo || !item.pattern || !item.reason?.trim()) throw new Error('Every warning exception needs a demo, pattern, and reason');
  }
  return [...new Set(log.split(/\r?\n/).filter(line => unresolvedPatterns.some(pattern => pattern.test(line))))]
    .filter(line => !allowlist.some(item => item.demo === demo && new RegExp(item.pattern).test(line)));
}

export function checkDemoDiagnostics(finalLog, diagnostics, demo, allowlist = []) {
  // Compiler diagnostics can retain early TeX-pass warnings that subsequently
  // converge. Bindings originate before TeX and remain final diagnostics.
  const bindings = diagnostics.filter(item => /^Unresolved placeholder\s+\{\{/i.test(item.message || '')).map(item => item.message);
  return checkWarnings([finalLog, ...bindings].join('\n'), demo, allowlist);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [demo, ...logs] = process.argv.slice(2);
  const policy = JSON.parse(fs.readFileSync(new URL('../tests/fixtures/warning-allowlist.json', import.meta.url), 'utf8'));
  const failures = checkWarnings(logs.map(file => fs.readFileSync(file, 'utf8')).join('\n'), path.basename(demo), policy);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exitCode = 1;
  }
}
