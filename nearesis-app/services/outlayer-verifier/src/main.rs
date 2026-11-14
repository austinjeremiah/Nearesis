//! Nearesis OutLayer verifier — entrypoint.
//!
//! Contract (OutLayer WASI): read one JSON document from stdin, write one JSON
//! document to stdout, flush. Semantic outcomes (VERIFIED / MISMATCH / COMPUTED /
//! INVALID_INPUT) are always reported as JSON with exit code 0 so the result is
//! recorded; only an I/O failure exits non-zero.

mod canonical;
mod metrics;
mod schema;
mod verify;

use std::io::{Read, Write};

/// Hard cap on stdin to keep instruction count and memory bounded.
pub const MAX_INPUT_BYTES: usize = 1 << 20;

fn main() {
    let mut buf = Vec::new();
    let read = std::io::stdin()
        .take((MAX_INPUT_BYTES + 1) as u64)
        .read_to_end(&mut buf);
    let out = match read {
        Ok(_) => verify::run(&buf),
        Err(_) => verify::io_error_output(),
    };
    let mut stdout = std::io::stdout();
    if stdout.write_all(out.as_bytes()).is_err() || stdout.flush().is_err() {
        std::process::exit(2);
    }
}
