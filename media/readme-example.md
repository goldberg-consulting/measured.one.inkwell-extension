---
title: A small experiment
author: Inkwell Demo
template: default
fontsize: 11pt
---

# From data to a document

Write the explanation in Markdown. Run the analysis
to insert its results, then compile a finished PDF.

## Compare two groups

The average is $\bar{x}=\frac{1}{n}\sum_{i=1}^{n}x_i$.

```{node id="summary" output="summary" caption="Results from our experiment."}
const fs = require("node:fs");
const path = require("node:path");
const rows = "Group,Mean,Participants\n" +
  "Control,42.3,24\nTreatment,57.8,24\n";
fs.writeFileSync(
  path.join(process.env.INKWELL_OUTPUT_DIR, "summary.csv"),
  rows
);
console.log("Analysis complete: 48 participants.");
```

## What we learned

The treatment group scored **15.5 points higher**.
The table above comes directly from the analysis.

Your writing, code, and finished PDF stay together.
