import * as fs from "fs";
import * as path from "path";

/** Validate both lexical and real containment, including missing descendants. */
export function containedRunPath(root: string, candidate: string, allowMissing = false, rejectSymlinks = false): string {
  const base = path.resolve(root);
  const full = path.resolve(candidate);
  if (rejectSymlinks && fs.lstatSync(base).isSymbolicLink()) throw new Error(`Generated run roots cannot be symlinks: ${base}`);
  if (!fs.statSync(base).isDirectory()) throw new Error(`Run root is not a directory: ${base}`);
  const relative = path.relative(base, full);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Run path escapes the project: ${candidate}`);
  const realRoot = fs.realpathSync(base);
  let cursor = base;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    cursor = path.join(cursor, segments[index]);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return full;
      throw error;
    }
    if (rejectSymlinks && stat.isSymbolicLink()) throw new Error(`Generated run paths cannot be symlinks: ${cursor}`);
    const real = fs.realpathSync(cursor);
    const realRelative = path.relative(realRoot, real);
    if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) throw new Error(`Run symlink escapes the project: ${cursor}`);
    const target = fs.statSync(cursor);
    if (!target.isFile() && !target.isDirectory()) throw new Error(`Run paths must be regular files or directories: ${cursor}`);
    if (index < segments.length - 1 && !target.isDirectory()) throw new Error(`Run path component is not a directory: ${cursor}`);
  }
  return full;
}

export function relativeRunPath(value: string): void {
  if (!value || value.includes("\0") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Run paths must stay inside the project: ${value}`);
  }
}
