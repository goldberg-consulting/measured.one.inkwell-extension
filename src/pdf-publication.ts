// Filesystem-only publication boundary: a failed validation/copy/rename never
// removes the currently published document.
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

export function validatePdf(file: string): void {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 16) throw new Error("The PDF output is missing or empty.");
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, header.length, 0);
    const tail = Buffer.alloc(Math.min(1024, stat.size));
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    if (!/^%PDF-\d\.\d/.test(header.toString("ascii")) || !/%%EOF\s*$/.test(tail.toString("ascii"))) {
      throw new Error("The PDF output is incomplete or has an invalid PDF signature.");
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function publishPdf(stagedPdf: string, publicPdf: string): void {
  validatePdf(stagedPdf);
  const temporary = path.join(path.dirname(publicPdf), `.${path.basename(publicPdf)}.${crypto.randomUUID()}.tmp`);
  try {
    fs.copyFileSync(stagedPdf, temporary, fs.constants.COPYFILE_EXCL);
    validatePdf(temporary);
    fs.renameSync(temporary, publicPdf);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Rename already removed it, or copy never created it. */ }
  }
}
