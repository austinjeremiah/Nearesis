#!/bin/sh
# Installs the pinned CRAN ForeComp 1.0.0 into the active R (the conda-forge r-env from r-env.yml) and verifies the version.
# Needs network access to CRAN once. Usage: . scripts/toolchain-env.sh && sh services/research/test/forecomp/install-forecomp.sh
set -eu
Rscript -e 'remotes::install_version("ForeComp", version = "1.0.0", repos = "https://cran.r-project.org", upgrade = "never", dependencies = FALSE)'
Rscript -e 'v <- as.character(packageVersion("ForeComp")); stopifnot(v == "1.0.0"); cat("ForeComp", v, "OK\n")'
