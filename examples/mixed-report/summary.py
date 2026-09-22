"""A second Python file producing a table from the same declared input."""
import csv
import os
from pathlib import Path

with Path(__file__).with_name("outcomes.csv").open() as source:
    rows = list(csv.DictReader(source))
with (Path(os.environ["INKWELL_OUTPUT_DIR"]) / "summary.csv").open("w", newline="") as target:
    writer = csv.writer(target)
    writer.writerow(["Month", "Baseline", "Observed", "Difference"])
    for row in rows:
        writer.writerow([row["month"], row["baseline"], row["observed"],
                         f'{float(row["observed"]) - float(row["baseline"]):.0f}'])
print("Six illustrative observations summarized.")
