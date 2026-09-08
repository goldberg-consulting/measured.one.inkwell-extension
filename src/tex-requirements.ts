// Exact package-to-file coverage for requirements-latex.txt. Unknown packages are
// an error: the doctor never substitutes a smaller fallback requirements list.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { resolveContainedPath } from "./bundled-assets";

export interface TexRequirement { name: string; files: readonly string[] }
export interface TexRequirements { schemaVersion: 1; sourcePath: string; hash: string; packages: TexRequirement[] }
export const TEX_PACKAGE_FILES: Readonly<Record<string, readonly string[]>> = {
  "geometry": [
    "geometry.sty"
  ],
  "hyperref": [
    "hyperref.sty"
  ],
  "babel": [
    "babel.sty"
  ],
  "babel-english": [
    "english.ldf"
  ],
  "babel-spanish": [
    "spanish.ldf"
  ],
  "hyphen-spanish": [
    "loadhyph-es.tex"
  ],
  "iftex": [
    "iftex.sty"
  ],
  "fancyhdr": [
    "fancyhdr.sty"
  ],
  "titlesec": [
    "titlesec.sty"
  ],
  "setspace": [
    "setspace.sty"
  ],
  "etoolbox": [
    "etoolbox.sty"
  ],
  "enumitem": [
    "enumitem.sty"
  ],
  "float": [
    "float.sty"
  ],
  "xcolor": [
    "xcolor.sty"
  ],
  "xurl": [
    "xurl.sty"
  ],
  "parskip": [
    "parskip.sty"
  ],
  "framed": [
    "framed.sty"
  ],
  "fancyvrb": [
    "fancyvrb.sty"
  ],
  "fvextra": [
    "fvextra.sty"
  ],
  "booktabs": [
    "booktabs.sty"
  ],
  "caption": [
    "caption.sty",
    "subcaption.sty"
  ],
  "microtype": [
    "microtype.sty"
  ],
  "mdframed": [
    "mdframed.sty"
  ],
  "zref": [
    "zref.sty"
  ],
  "needspace": [
    "needspace.sty"
  ],
  "titling": [
    "titling.sty"
  ],
  "lettrine": [
    "lettrine.sty"
  ],
  "lineno": [
    "lineno.sty"
  ],
  "footmisc": [
    "footmisc.sty"
  ],
  "adjustbox": [
    "adjustbox.sty"
  ],
  "lastpage": [
    "lastpage.sty"
  ],
  "listings": [
    "listings.sty"
  ],
  "csquotes": [
    "csquotes.sty"
  ],
  "ragged2e": [
    "ragged2e.sty"
  ],
  "tcolorbox": [
    "tcolorbox.sty"
  ],
  "colortbl": [
    "colortbl.sty"
  ],
  "mathtools": [
    "mathtools.sty"
  ],
  "thmtools": [
    "thmtools.sty"
  ],
  "here": [
    "here.sty"
  ],
  "multirow": [
    "multirow.sty"
  ],
  "environ": [
    "environ.sty"
  ],
  "abstract": [
    "abstract.sty"
  ],
  "bookmark": [
    "bookmark.sty"
  ],
  "cleveref": [
    "cleveref.sty"
  ],
  "natbib": [
    "natbib.sty"
  ],
  "adforn": [
    "adforn.sty"
  ],
  "xifthen": [
    "xifthen.sty"
  ],
  "ccicons": [
    "ccicons.sty"
  ],
  "imakeidx": [
    "imakeidx.sty"
  ],
  "fontawesome5": [
    "fontawesome5.sty"
  ],
  "orcidlink": [
    "orcidlink.sty"
  ],
  "pdflscape": [
    "pdflscape.sty"
  ],
  "chemfig": [
    "chemfig.sty"
  ],
  "circuitikz": [
    "circuitikz.sty"
  ],
  "supertabular": [
    "supertabular.sty"
  ],
  "matlab-prettifier": [
    "matlab-prettifier.sty"
  ],
  "lipsum": [
    "lipsum.sty"
  ],
  "hardwrap": [
    "hardwrap.sty"
  ],
  "units": [
    "units.sty"
  ],
  "silence": [
    "silence.sty"
  ],
  "pbalance": [
    "pbalance.sty"
  ],
  "extsizes": [
    "extarticle.cls"
  ],
  "fixtounicode": [
    "fixtounicode.sty"
  ],
  "svn-prov": [
    "svn-prov.sty"
  ],
  "xstring": [
    "xstring.sty"
  ],
  "fix2col": [
    "fix2col.sty"
  ],
  "amsfonts": [
    "amssymb.sty",
    "amsfonts.sty"
  ],
  "amscls": [
    "amsthm.sty"
  ],
  "tools": [
    "array.sty",
    "calc.sty",
    "longtable.sty",
    "multicol.sty",
    "tabularx.sty"
  ],
  "preprint": [
    "authblk.sty",
    "balance.sty"
  ],
  "sttools": [
    "flushend.sty",
    "stfloats.sty"
  ],
  "graphics": [
    "rotating.sty",
    "graphicx.sty"
  ],
  "oberdiek": [
    "iflang.sty"
  ],
  "psnfss": [
    "helvet.sty",
    "mathpazo.sty",
    "times.sty"
  ],
  "fontspec": [
    "fontspec.sty"
  ],
  "mathpazo": [
    "mathpazo.sty"
  ],
  "palatino": [
    "pplr8r.tfm"
  ],
  "bera": [
    "beramono.sty"
  ],
  "soul": [
    "soul.sty"
  ],
  "stix2-type1": [
    "stix2.sty"
  ],
  "tex-gyre": [
    "ec-qplr.tfm"
  ],
  "cm-super": [
    "sfrm1000.pfb"
  ],
  "koma-script": [
    "scrartcl.cls",
    "scrreprt.cls",
    "scrbook.cls"
  ],
  "babel-german": [
    "ngerman.ldf"
  ],
  "stringstrings": [
    "stringstrings.sty"
  ],
  "listofitems": [
    "listofitems.sty"
  ],
  "translations": [
    "translations.sty"
  ],
  "totcount": [
    "totcount.sty"
  ],
  "ltabptch": [
    "ltabptch.sty"
  ],
  "accsupp": [
    "accsupp.sty"
  ],
  "floatrow": [
    "floatrow.sty"
  ],
  "textcase": [
    "textcase.sty"
  ],
  "epstopdf-pkg": [
    "epstopdf.sty"
  ],
  "epstopdf": [
    "epstopdf.pl"
  ],
  "fontawesome": [
    "fontawesome.sty"
  ],
  "raleway": [
    "raleway.sty"
  ],
  "ly1": [
    "ly1enc.def"
  ],
  "paracol": [
    "paracol.sty"
  ],
  "smartdiagram": [
    "smartdiagram.sty"
  ],
  "tikz-3dplot": [
    "tikz-3dplot.sty"
  ],
  "pgf": [
    "pgf.sty"
  ],
  "tufte-latex": [
    "tufte-handout.cls",
    "tufte-book.cls"
  ]
};

/** Script files use TeX's script search path, distinct from the default TeX input path. */
export function texFileProbeArguments(file: string): string[] {
  return file === "epstopdf.pl" ? ["--format=texmfscripts", file] : [file];
}

export function loadTexRequirements(extensionRoot: string): TexRequirements {
  const sourcePath = resolveContainedPath(extensionRoot, "requirements-latex.txt");
  const contents = fs.readFileSync(sourcePath, "utf8");
  const names = [...new Set(contents.split(/\r?\n/).map(line => line.replace(/#.*/, "").trim()).filter(Boolean))];
  if (!names.length) throw new Error("The installed TeX requirements manifest is empty.");
  const packages = names.map(name => {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(name)) throw new Error(`Unsafe TeX package name in ${path.basename(sourcePath)}: ${name}`);
    const files = TEX_PACKAGE_FILES[name];
    if (!files?.length) throw new Error(`No exact TeX file coverage is declared for required package ${name}. Update the installed requirement/file manifest.`);
    return { name, files: [...files] };
  });
  return { schemaVersion: 1, sourcePath, hash: crypto.createHash("sha256").update(contents).digest("hex"), packages };
}
