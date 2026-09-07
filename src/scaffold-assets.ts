// Pure starter content shared by scaffolding and safe migrations.
export const DEFAULT_FRONTMATTER = `---
title: "Untitled"
author: ""
date: "\\\\today"
geometry: "margin=1in"
linestretch: 1.4
bibliography: .inkwell/references/refs.bib
link-citations: true
inkwell:
  code-bg: "#f5f5f5"
  code-border: true
  code-rounded: true
  code-font-size: small
  tables: booktabs
  hanging-indent: true
  code-display: output
---

`;

export const DEFAULT_REQUIREMENTS =
  "numpy\nmatplotlib\npandas\npolars\nscikit-learn\numap-learn\nseaborn\n";

export const GITIGNORE = `.inkwell/outputs/
.inkwell/runs/
.inkwell/.cache/
.inkwell/venv/
.inkwell/compiled/
.inkwell/mermaid/
*.aux
*.log
*.out
*.fls
*.fdb_latexmk
*.synctex.gz
__pycache__/
*.pyc
venv/
.venv/
`;

export const STARTER_BIB = `@book{fourier1822,
  author    = {Fourier, Joseph},
  title     = {Théorie analytique de la chaleur},
  publisher = {Firmin Didot, père et fils},
  address   = {Paris},
  year      = {1822}
}

@article{knuth1984,
  author  = {Knuth, Donald E.},
  title   = {Literate Programming},
  journal = {The Computer Journal},
  volume  = {27},
  number  = {2},
  pages   = {97--111},
  year    = {1984},
  doi     = {10.1093/comjnl/27.2.97}
}

@software{macfarlane2023,
  author  = {MacFarlane, John},
  title   = {Pandoc: A Universal Document Converter},
  year    = {2023},
  url     = {https://pandoc.org}
}

@article{harris2020,
  author  = {Harris, Charles R. and others},
  title   = {Array programming with {NumPy}},
  journal = {Nature},
  volume  = {585},
  pages   = {357--362},
  year    = {2020},
  doi     = {10.1038/s41586-020-2649-2}
}

@article{hunter2007,
  author  = {Hunter, John D.},
  title   = {Matplotlib: A {2D} graphics environment},
  journal = {Computing in Science \\& Engineering},
  volume  = {9},
  number  = {3},
  pages   = {90--95},
  year    = {2007},
  doi     = {10.1109/MCSE.2007.55}
}
`;

export const SINE_PLOT_PY = `import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 500)
fig, ax = plt.subplots(figsize=(6, 3))
for n in [1, 3, 5, 9]:
    y = sum(np.sin((2*k-1)*x) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    ax.plot(x, y, label=f"$n={n}$", linewidth=1.2)
ax.axhline(1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.axhline(-1, color="black", linestyle="--", linewidth=0.5, alpha=0.4)
ax.set_xlabel("$x$")
ax.set_ylabel("$f_n(x)$")
ax.set_title("Fourier Partial Sums of a Square Wave")
ax.legend(fontsize=8)
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "sine_plot.png"), dpi=200, bbox_inches="tight")
plt.close(fig)
print("Fourier partial sums generated.")
`;

export const SCATTER_PY = `import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

rng = np.random.default_rng(42)
x = rng.normal(0, 1, 150)
y = 0.7 * x + rng.normal(0, 0.35, 150)

fig, ax = plt.subplots(figsize=(5, 3.5))
ax.scatter(x, y, s=14, alpha=0.6, color="#4A90D9")
m, b = np.polyfit(x, y, 1)
xs = np.sort(x)
ax.plot(xs, m * xs + b, color="#E74C3C", linewidth=1.5,
        label=f"$y = {m:.2f}x {'+' if b >= 0 else ''}{b:.2f}$")
ax.set_xlabel("$x$")
ax.set_ylabel("$y$")
ax.legend()
ax.grid(alpha=0.2)
fig.tight_layout()

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
fig.savefig(os.path.join(out, "scatter.png"), dpi=200, bbox_inches="tight")
plt.close(fig)

r = np.corrcoef(x, y)[0, 1]
print(f"n = {len(x)}, r = {r:.3f}, slope = {m:.3f}")
`;

export const CONVERGENCE_TABLE_PY = `import os
import csv
import numpy as np

x_jump = np.pi / 2
true_val = 1.0

rows = []
for n in [1, 3, 5, 9, 25, 50]:
    partial = sum(np.sin((2*k-1)*x_jump) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    error = abs(partial - true_val)
    overshoot_x = np.linspace(0, np.pi, 5000)
    overshoot_y = sum(np.sin((2*k-1)*overshoot_x) / (2*k-1) for k in range(1, n+1)) * 4 / np.pi
    peak = np.max(overshoot_y)
    rows.append([n, f"{partial:.4f}", f"{error:.4f}", f"{peak:.4f}"])

out = os.environ.get("INKWELL_OUTPUT_DIR", ".")
with open(os.path.join(out, "convergence.csv"), "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["Terms (n)", "Value at x=pi/2", "Abs. Error", "Peak Overshoot"])
    w.writerows(rows)

print("Convergence table generated.")
`;

export const SCAFFOLD_SEED_FILES: Readonly<Record<string, string>> = {
  ".inkwell/scripts/sine_plot.py": SINE_PLOT_PY,
  ".inkwell/scripts/scatter.py": SCATTER_PY,
  ".inkwell/scripts/convergence_table.py": CONVERGENCE_TABLE_PY,
  ".inkwell/references/refs.bib": STARTER_BIB,
  "requirements.txt": DEFAULT_REQUIREMENTS,
};

export const TEMPLATE_FRONTMATTER: Record<string, string> = {
  ludus: `template: ludus
classoption:
  - red                               # theme: red, blue, green, orange
  - fullpaper                         # type: fullpaper, shortpaper
ludus-authors:
  - name: "Author One"
    superscript: "1"
  - name: "Author Two"
    superscript: "2"
ludus-affiliations:
  - superscript: "1"
    text: "Department, University, Country"
  - superscript: "2"
    text: "Department, University, Country"
corresponding-email: "author@university.edu"
shorttitle: "Short Title"
shortauthor: "Author & Author"
journalname: "Journal Name"
journalsubtitle: "Subtitle"
publicationyear: ${new Date().getFullYear()}
articledoi: "10.0000/example"
acknowledgments: |
  The authors thank the reviewers.
`,
  rho: `template: rho
rho-authors:
  - name: "Author One"
    superscript: "1,*"
  - name: "Author Two"
    superscript: "2"
rho-affiliations:
  - superscript: "1"
    text: "Department, University, Country"
  - superscript: "2"
    text: "Department, University, Country"
  - superscript: "*"
    text: "These authors contributed equally"
journalname: "Journal Name"
leadauthor: "Author et al."
footinfo: "Creative Commons CC BY 4.0"
smalltitle: "Short Title"
institution: "University Name"
theday: "${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}"
corres: "Corresponding author information."
email: "author@university.edu"
doi: "https://doi.org/10.0000/example"
received: ""
accepted: ""
`,
  rmxaa: `template: rmxaa
classoption: [9pt, twoside]
rmxaa-authors:
  - name: "Author One"
    affiliations: "1"
  - name: "Author Two"
    affiliations: "2"
rmxaa-affiliations:
  - id: "1"
    text: "Department, University, Country"
  - id: "2"
    text: "Department, University, Country"
leadauthor: "Author et al."
smalltitle: "Short Title"
corresponding-author: "Author One"
corresponding-email: "author@university.edu"
resumen: |
  Spanish abstract here.
vol: 1
pages: "1--10"
yearofpub: ${new Date().getFullYear()}
received: ""
accepted: ""
`,
  tmsce: `template: tmsce
tmsce-authors:
  - name: "Author One"
    superscript: "1"
  - name: "Author Two"
    superscript: "2"
tmsce-affiliations:
  - superscript: "1"
    text: "Department, University, Country"
  - superscript: "2"
    text: "Department, University, Country"
corresponding-email: "author@university.edu"
journalname: "Transactions on Mathematical Sciences and Computational Engineering"
doi: "10.0000/tmsce.${new Date().getFullYear()}.001"
vol: 1
issue: 1
yearofpub: ${new Date().getFullYear()}
pagerange: "1--10"
received: ""
revised: ""
accepted: ""
`,
  tufte: `template: tufte
classoption:
  - justified
  - a4paper
`,
  "tufte-book-vdqi": `template: tufte-book-vdqi
subtitle: "With a VDQI Title and Contents Page"
edition: "First edition"
publisher: "Publisher Name"
top-level-division: chapter
classoption:
  - justified
toc: true
# lof: true                # enable once the book has figures
copyright: true
copyright-holder: "Copyright Holder"
license: "Licensed for private circulation."
dedication: |
  Dedicated to readers who appreciate evidence and quiet pages.
epigraphs:
  - text: "Above all else show the data."
    author: "Edward R. Tufte"
`,
  "eth-report": `template: eth-report
papertype: "Working Paper"
headingstitle: "Short Title"
eth-authors:
  - name: "Author One"
    department: "Department"
    institution: "ETH Zürich"
    address: "CH-8093 Zurich"
    email: "author@ethz.ch"
  - name: "Author Two"
    department: "Department"
    institution: "ETH Zürich"
reportdate: "${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}"
reportnumber: ""
keywords: "keyword1, keyword2"
suggestedcitation: ""
toc: true
lot: true
lof: true

# The IVT class defaults to 12pt, its own A4 margins, and one-half
# spacing. Uncomment to override (see guide.md, ETH Report section):
# fontsize: 11pt
# linestretch: 1.08
# geometry: margin=1in
# mainfont: "Charter"
`,
  "kth-letter": `template: kth-letter
name: "Sender Name"
email: "sender@kth.se"
web: "www.kth.se"
telephone: "+46 8 790 60 00"
dnr: ""
recipient:
  - "Recipient Name"
  - "Department"
  - "Address"
  - "Country"
opening: "Dear Dr. Name,"
closing: "Kind regards,"
`,
  "hipster-cv": `template: hipster-cv
classoption:
  - lighthipster                     # darkhipster, pastel, allblack, grey, verylight, withoutsidebar
first-name: "First"
last-name: "Last"
tagline: "Job Title"
# header-contact: "+1 555 010 2030; City, Country"   # optional line under the tagline
# photo: "headshot.jpeg"             # optional round portrait in the sidebar
sidebar:
  - title: "About me"
    text: |
      Two or three sentences about who you are and what you do.
  - title: "Areas of specialization"
    text: "Skill One • Skill Two • Skill Three"
languages:
  - name: English
    note: native
  - name: French
    level: B1
    filled: 2
    empty: 2
contact:
  - icon: At
    text: you
    url: "mailto:you@example.com"
  - icon: Github
    text: github
    url: "https://github.com/you"
footer:
  name: "First Last"
  location: "City, Country"
  phone: "+1 555 010 2030"
  email: "you@example.com"
`,
};
