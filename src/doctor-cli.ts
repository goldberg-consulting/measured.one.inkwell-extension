import * as path from "path";
import { createDoctor, DoctorDependencies, DoctorOptions, formatDoctorText } from "./doctor";
import { runSmokeBuild } from "./smoke-build";

export interface DoctorCliIO { stdout(text: string): void; stderr(text: string): void }
const usage = "Usage: inkwell-doctor [--light|--full] [--json|--text] [--extension-root PATH] [--workspace PATH] [--editor cursor|code] [--expected-version VERSION] [--require-tool NAME]";

/** The installer and extension share the exact report schema and probe service. */
export async function runDoctorCli(
  argv: string[], dependencies: DoctorDependencies = {},
  io: DoctorCliIO = { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) },
): Promise<number> {
  const options: DoctorOptions = { extensionRoot: path.resolve(__dirname, ".."), mode: "light" };
  let json = false;
  const expectedEditors: string[] = [], requiredTools: string[] = [];
  try {
    for (let index = 0; index < argv.length; index++) {
      const arg = argv[index];
      const value = (): string => {
        const result = argv[++index];
        if (!result || result.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
        return result;
      };
      if (arg === "--help" || arg === "-h") { io.stdout(usage + "\n"); return 0; }
      if (arg === "--full") options.mode = "full";
      else if (arg === "--light") options.mode = "light";
      else if (arg === "--json") json = true;
      else if (arg === "--text") json = false;
      else if (arg === "--cached-only") options.cachedOnly = true;
      else if (arg === "--force-refresh") options.forceRefresh = true;
      else if (arg === "--extension-root") options.extensionRoot = path.resolve(value());
      else if (arg === "--workspace") options.workspaceRoot = path.resolve(value());
      else if (arg === "--expected-version") options.expectedVersion = value();
      else if (arg === "--editor") {
        const editor = value();
        if (!["cursor", "code"].includes(editor)) throw new Error(`Unsupported editor: ${editor}.`);
        expectedEditors.push(editor);
      } else if (arg === "--require-tool") {
        const tool = value();
        if (!/^[a-z][a-z0-9-]*$/.test(tool)) throw new Error(`Invalid required tool name: ${tool}.`);
        requiredTools.push(tool);
      } else if (arg === "--engine") {
        const engine = value();
        if (!["xelatex", "pdflatex", "lualatex"].includes(engine)) throw new Error(`Unsupported TeX engine: ${engine}.`);
        options.selectedEngine = engine as DoctorOptions["selectedEngine"];
      } else throw new Error(`Unknown argument: ${arg}.`);
    }
    options.expectedEditors = expectedEditors;
    options.requiredTools = requiredTools;
    const result = await createDoctor({
      smokeCompile: async context => {
        const smoke = await runSmokeBuild(context.extensionRoot, context.temporaryRoot, context.env);
        return { success: smoke.success && smoke.verified, pdfPath: smoke.pdfPath,
          message: smoke.success && smoke.verified ? "The default Inkwell PDF smoke build passed." : "The default Inkwell PDF smoke build failed.", log: smoke.logs.join("\n") };
      }, ...dependencies,
    }).run(options);
    io.stdout((json ? JSON.stringify(result, null, 2) : formatDoctorText(result)) + "\n");
    return result.ready ? 0 : 1;
  } catch (error: any) {
    const message = error.message || String(error);
    if (json) io.stdout(JSON.stringify({ schemaVersion: 1, ready: false, status: "error", error: message }) + "\n");
    else io.stderr(`${message}\n${usage}\n`);
    return 2;
  }
}

if (require.main === module) void runDoctorCli(process.argv.slice(2)).then(code => { process.exitCode = code; });
