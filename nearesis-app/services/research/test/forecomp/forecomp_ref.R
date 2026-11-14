# Calls the CRAN ForeComp functions on series read from a JSON file and writes their outputs as JSON.
# Usage: Rscript forecomp_ref.R input.json output.json
# input: {"series": [{"id": "...", "d": [numbers]}]}. Uses only the installed ForeComp package; no ForeComp code is copied here.
suppressMessages({ library(ForeComp); library(jsonlite) })
args <- commandArgs(trailingOnly = TRUE)
inp <- fromJSON(args[1], simplifyVector = FALSE)
num <- function(x) if (is.null(x) || length(x) == 0) NA_real_ else as.numeric(x)
lgl <- function(x) if (is.null(x) || length(x) == 0 || is.na(x)) NA else as.logical(x)
one <- function(s) {
  d <- as.numeric(unlist(s$d)); n <- length(d)
  out <- list(id = s$id, n = n, rversion = R.version.string, forecomp = as.character(packageVersion("ForeComp")))
  # wpe: ForeComp's own prescription floor(n^(1/3)) evaluated in R floating point. wpe_pm: the same function with M supplied by the caller
  # (the mathematically intended floor(n^(1/3)) that the Python side uses), which isolates the statistic from the choice of M.
  Mdef <- floor(n^(1/3)); out$M_default <- Mdef
  w <- tryCatch(dm.test.wpe.fb(d, M = Mdef), error = function(e) list(err = conditionMessage(e)))
  out$wpe <- list(stat = num(w$stat), pval = num(w$pval), rej = lgl(w$rej), err = if (is.null(w$err)) NULL else w$err)
  Mp <- if (is.null(s$m)) Mdef else as.integer(s$m)
  w2 <- tryCatch(dm.test.wpe.fb(d, M = Mp), error = function(e) list(err = conditionMessage(e)))
  out$wpe_pm <- list(M = Mp, stat = num(w2$stat), pval = num(w2$pval), rej = lgl(w2$rej), err = if (is.null(w2$err)) NULL else w2$err)
  # independent spectral level from base R fft (neither ForeComp's matrix formula nor numpy), used only to classify degenerate inputs
  out$omega_fft <- if (n > Mp) mean(Mod(fft(d)[2:(Mp + 1)])^2) / n else NA_real_
  b <- tryCatch(dm.test.bt.fb(d, M = floor(sqrt(n))), error = function(e) list(err = conditionMessage(e)))
  out$bt <- list(stat = num(b$stat), rej = lgl(b$rej), err = if (is.null(b$err)) NULL else b$err)
  r <- tryCatch(dm.test.r.m(d, h = 1), error = function(e) list(err = conditionMessage(e)))
  out$rm <- list(stat = num(r$stat), pval = num(r$pval), rej = lgl(r$rej), err = if (is.null(r$err)) NULL else r$err)
  out
}
res <- lapply(inp$series, one)
writeLines(toJSON(res, auto_unbox = TRUE, digits = NA, na = "string", null = "null"), args[2])
