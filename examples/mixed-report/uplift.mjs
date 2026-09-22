import * as Plot from "@observablehq/plot";
import {document, readOutcomes, savePlot} from "./plot-helpers.mjs";

const data = await readOutcomes();
await savePlot(Plot.plot({
  document, width: 720, height: 330, marginLeft: 65,
  style: {fontFamily: "sans-serif", fontSize: "14px", background: "white"},
  x: {label: "Month", tickFormat: "d"},
  y: {label: "Observed minus baseline (index points)", grid: true},
  marks: [Plot.ruleY([0]), Plot.barY(data, {x: "month", y: d => d.observed - d.baseline, fill: "#267D83"})]
}), "uplift");
console.log("Observable Plot: differences by month (illustrative data).");
