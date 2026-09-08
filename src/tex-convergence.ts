// Reuse only auxiliary state from a published PDF. Every attempt still runs
// TeX; a recorder and a byte-for-byte convergence check can save its next pass.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const AUXILIARY_EXTENSIONS = new Set([".aux", ".toc", ".out", ".lof", ".lot", ".lol", ".nav", ".snm", ".vrb", ".brf"]);
const TRANSIENT_EXTENSIONS = new Set([".pdf", ".log", ".fls", ".xdv", ".dvi", ".synctex"]);
const MAX_AUXILIARY_FILES = 128;
const MAX_AUXILIARY_FILE_BYTES = 1024 * 1024;
const MAX_AUXILIARY_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_FILES = 2048;
const MAX_INPUT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_RECORDER_BYTES = 2 * 1024 * 1024;

export interface TexConvergenceContext {
  directory: string;
  sourceDirectory: string;
  sourceFile: string;
  sourceHash: string;
  texFile: string;
  jobName: string;
  engine: string;
  engineArgs: string[];
  environment: NodeJS.ProcessEnv;
  templateIdentity: string;
}

interface RecordedInput { relative: boolean; file: string; hash: string }
interface AuxiliaryState {
  auxiliaries: Map<string, Buffer>;
  inputs: RecordedInput[];
  bytes: number;
}
interface CacheEntry extends AuxiliaryState { key: string }

function hash(bytes: string | Buffer): string { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function inside(directory: string, file: string): string | undefined {
  const relative = path.relative(directory, file);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? relative : undefined;
}

/** Conservative across the standard LaTeX, hyperref, rerunfilecheck and bib packages. */
export function texNeedsAnotherPass(log: string): boolean {
  // The normal package banner says "Rerun checks for auxiliary files"; it is
  // a version description, not a request to run the document again.
  const diagnostics = log.split(/\r?\n/).filter(line => !/^Package: /i.test(line)).join("\n");
  return /\brerun\b|\bre-run\b|\(re\)run\b|rerunfilecheck[^\n]*Warning|\brun\s+(?:LaTeX|XeLaTeX|pdfLaTeX|LuaLaTeX|Biber|BibTeX)\s+again\b|undefined|multiply[- ]defined|labels?\s+(?:may\s+have\s+|have\s+)?changed|No file .+\.(?:aux|toc|out|lof|lot|bbl)\b/i.test(diagnostics);
}

async function readRegularFile(file: string, limit: number): Promise<Buffer> {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("Auxiliary cache input exceeds its bounds");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Auxiliary cache input changed while reading");
    return bytes;
  } finally { await handle.close(); }
}

async function readInput(file: string): Promise<Buffer> {
  // A system font/package can be a link. Hash its resolved target on every
  // lookup; changed link destinations or in-place bytes invalidate the state.
  return readRegularFile(await fs.promises.realpath(file), MAX_INPUT_FILE_BYTES);
}

async function recordedState(context: TexConvergenceContext): Promise<AuxiliaryState> {
  const directoryReal = await fs.promises.realpath(context.directory);
  if (!(await readRegularFile(path.join(context.directory, `${context.jobName}.log`), MAX_INPUT_FILE_BYTES)).length) throw new Error("Missing TeX log");
  const recorder = (await readRegularFile(path.join(context.directory, `${context.jobName}.fls`), MAX_RECORDER_BYTES)).toString("utf8");
  const outputs = new Map<string, string>();
  const inputFiles = new Set<string>();
  let workingDirectory = context.sourceDirectory;
  for (const line of recorder.split(/\r?\n/)) {
    if (line.startsWith("PWD ")) workingDirectory = path.resolve(line.slice(4));
    else if (line.startsWith("OUTPUT ")) {
      const file = path.resolve(workingDirectory, line.slice(7));
      const relative = inside(context.directory, file);
      // An unfamiliar output may carry state that a later pass consumes. Do
      // not guess its semantics, and never restore outside the fresh staging.
      if (!relative) throw new Error("TeX output is outside its attempt directory");
      const extension = path.extname(relative).toLowerCase();
      if (!AUXILIARY_EXTENSIONS.has(extension) && !TRANSIENT_EXTENSIONS.has(extension)) throw new Error("Unrecognized TeX state file");
      outputs.set(file, relative);
    } else if (line.startsWith("INPUT ")) {
      inputFiles.add(path.resolve(workingDirectory, line.slice(6)));
      if (inputFiles.size > MAX_INPUT_FILES) throw new Error("Too many TeX input files");
    }
  }
  const auxiliaries = new Map<string, Buffer>();
  let bytes = 0;
  for (const [file, relative] of [...outputs].sort(([a], [b]) => a.localeCompare(b))) {
    if (!AUXILIARY_EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
    if (!inside(directoryReal, await fs.promises.realpath(file))) throw new Error("Auxiliary file escapes through a directory link");
    const data = await readRegularFile(file, MAX_AUXILIARY_FILE_BYTES);
    // Absolute references to an older isolated attempt are not transferable.
    if (data.includes(Buffer.from(context.directory))) throw new Error("Auxiliary contains an attempt-specific path");
    auxiliaries.set(relative, data);
    bytes += data.length;
    if (bytes > MAX_AUXILIARY_BYTES || auxiliaries.size > MAX_AUXILIARY_FILES) throw new Error("Too much auxiliary state");
  }
  if (!auxiliaries.has(`${context.jobName}.aux`) || !inputFiles.size) throw new Error("Incomplete TeX recorder");
  const inputs: RecordedInput[] = [];
  let inputBytes = 0;
  for (const file of [...inputFiles].sort()) {
    if (outputs.has(file) || file === context.texFile) continue;
    const data = await readInput(file);
    inputBytes += data.length;
    if (inputBytes > MAX_INPUT_BYTES) throw new Error("Too much TeX input data");
    const relative = inside(context.directory, file);
    inputs.push({ relative: !!relative, file: relative || file, hash: hash(data) });
  }
  return { auxiliaries, inputs, bytes };
}

async function inputsMatch(entry: AuxiliaryState, directory: string): Promise<boolean> {
  for (const input of entry.inputs) {
    if (hash(await readInput(input.relative ? path.join(directory, input.file) : input.file)) !== input.hash) return false;
  }
  return true;
}

function sameState(left: AuxiliaryState, right: AuxiliaryState): boolean {
  if (left.auxiliaries.size !== right.auxiliaries.size || JSON.stringify(left.inputs) !== JSON.stringify(right.inputs)) return false;
  for (const [name, data] of left.auxiliaries) if (!right.auxiliaries.get(name)?.equals(data)) return false;
  return true;
}

export interface TexConvergenceRun {
  readonly restored: boolean;
  canFinishAfterFirstPass(log: string): Promise<boolean>;
  /** Call only after this attempt's fresh PDF has validated and published. */
  rememberPublished(log: string): Promise<void>;
}

export class TexConvergenceCache {
  private readonly entries = new Map<string, CacheEntry>();
  private bytes = 0;
  private generation = 0;

  constructor(private readonly maxEntries = 16, private readonly maxBytes = 64 * 1024 * 1024) {}

  clear(): void { this.entries.clear(); this.bytes = 0; this.generation++; }

  async prepare(context: TexConvergenceContext): Promise<TexConvergenceRun> {
    const generation = this.generation;
    let key: string | undefined;
    let restored: CacheEntry | undefined;
    const restoredPaths: string[] = [];
    try {
      const engine = await fs.promises.realpath(context.engine);
      const engineStat = await fs.promises.stat(engine);
      const normalize = (value: string) => value.replaceAll(context.directory, "<inkwell-attempt>");
      key = hash(JSON.stringify({
        sourceFile: context.sourceFile, sourceHash: context.sourceHash,
        tex: normalize((await readRegularFile(context.texFile, MAX_INPUT_FILE_BYTES)).toString("utf8")),
        template: context.templateIdentity, engine,
        engineStat: [engineStat.dev, engineStat.ino, engineStat.size, engineStat.mtimeMs, engineStat.ctimeMs],
        args: context.engineArgs.map(normalize),
        environment: Object.entries(context.environment).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value === undefined ? null : normalize(value)]),
      }));
      const entry = this.entries.get(key);
      if (entry && await inputsMatch(entry, context.directory) && generation === this.generation) {
        const directoryReal = await fs.promises.realpath(context.directory);
        for (const [relative, data] of entry.auxiliaries) {
          const file = path.join(context.directory, relative);
          await fs.promises.mkdir(path.dirname(file), { recursive: true });
          const parentReal = await fs.promises.realpath(path.dirname(file));
          if (parentReal !== directoryReal && !inside(directoryReal, parentReal)) throw new Error("Auxiliary directory escapes through a link");
          // Never overwrite a copied resource or follow an existing link.
          await fs.promises.writeFile(file, data, { flag: "wx", mode: 0o600 });
          restoredPaths.push(file);
        }
        if (generation !== this.generation) throw new Error("Auxiliary cache was cleared during restoration");
        restored = entry;
        // Another published attempt may have replaced/evicted this entry
        // during file I/O. Do not resurrect it or change its byte accounting.
        if (this.entries.get(key) === entry) { this.entries.delete(key); this.entries.set(key, entry); }
      }
    } catch {
      for (const file of restoredPaths) { try { await fs.promises.unlink(file); } catch {} }
    }
    return {
      restored: !!restored,
      canFinishAfterFirstPass: async log => {
        if (!restored || generation !== this.generation || !log.trim() || texNeedsAnotherPass(log)) return false;
        try { return sameState(restored, await recordedState(context)); } catch { return false; }
      },
      rememberPublished: async log => {
        if (!key || generation !== this.generation || !log.trim() || texNeedsAnotherPass(log)) return;
        try {
          const state = await recordedState(context);
          if (generation !== this.generation || state.bytes > this.maxBytes) return;
          const old = this.entries.get(key);
          if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
          this.entries.set(key, { key, ...state }); this.bytes += state.bytes;
          while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
            const oldest = this.entries.values().next().value as CacheEntry;
            this.entries.delete(oldest.key); this.bytes -= oldest.bytes;
          }
        } catch { /* Cache optimization must never change compile success. */ }
      },
    };
  }
}

export const texConvergenceCache = new TexConvergenceCache();
