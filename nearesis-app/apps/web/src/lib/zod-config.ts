import { z } from "zod";

// Zod's JIT probes `new Function` support; under our CSP (no 'unsafe-eval') that probe is itself a violation.
// Jitless mode validates identically without any eval.
z.config({ jitless: true });
