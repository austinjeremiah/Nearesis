# Plugin and research sandbox image (SEC06, SEC12, packages/kernel/src/plugins/sandbox-exec.ts), part of the mandatory
# release vulnerability scan (name "sandbox", scripts/release/images.ts).
# Base: Google distroless nodejs24 on Debian 13, pinned by index digest. It carries only the node binary, libc/libstdc++,
# libgcc, openssl, zlib, tzdata and CA certificates: no shell, no package manager, no npm, no util-linux/login/perl/
# ncurses/sqlite, which removed all 14 HIGH findings of the previous node:24-trixie-slim image. The sandboxed code runs
# `node` only. SEC06 therefore proves isolation from kernel facts (capabilities, no_new_privs, seccomp, mount and
# namespace syscalls attempted from a tool image under the same runner flags), not from the absence of binaries.
# Build: ensureSandboxImage() or `docker build -t nearesis-sandbox:distroless-1 infrastructure/sandbox`. The image runs as
# an unprivileged user chosen by the runner (--user 65534:65534), read-only, with no network.
FROM gcr.io/distroless/nodejs24-debian13@sha256:d1c8c1be703f1dca243457ac656e7eee7c571a7136a6e681d17c4294e6fe7a6d
# The runner passes `node ...` as the command; the base entrypoint is already node, so clear it and put node on PATH.
ENTRYPOINT []
ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
