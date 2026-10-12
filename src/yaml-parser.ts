/** Keep YAML initialization off the extension activation path. */
export function yamlParser(): typeof import("yaml") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("yaml");
}
