import * as Plot from "@observablehq/plot";
import {document, readOutcomes, savePlot} from "./plot-helpers.mjs";

const data = await readOutcomes();
await savePlot(Plot.plot({
  document, width: 720, height: 330, marginLeft: 65,
  style: {fontFamily: "sans-serif", fontSize: "14px", background: "white"},
  x: {label: "Outcome index", grid: true}, y: {label: "Month", tickFormat: "d"},
  marks: [
    Plot.link(data, {x1: "baseline", x2: "observed", y1: "month", y2: "month", stroke: "#A3BABC", strokeWidth: 3}),
    Plot.dot(data, {x: "baseline", y: "month", fill: "#7D898B", r: 5}),
    Plot.dot(data, {x: "observed", y: "month", fill: "#267D83", r: 5})
  ]
}), "comparison");
console.log("Gray: baseline. Teal: observed. Illustrative data only.");
