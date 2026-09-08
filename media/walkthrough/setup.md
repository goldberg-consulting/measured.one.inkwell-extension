# Setup / Repair

Inkwell checks your installed tools without changing them. If tools or packages
are missing, review the installation plan and choose Install. A system TeX
installation may request your administrator password in its task terminal.

Setup observes each installation result, verifies the tools again, upgrades your
project safely, and builds a real PDF. A green completion report appears only
after the required checks pass. Failures and skipped checks remain visible in
the diagnostics; an interrupted setup can be resumed by running Setup / Repair.

The checks themselves do not install packages or alter TeX ownership. An existing
working TeX distribution is reused, and full MacTeX is the default when TeX is
missing. Opening the editor uses cached light health and never runs a package scan.
