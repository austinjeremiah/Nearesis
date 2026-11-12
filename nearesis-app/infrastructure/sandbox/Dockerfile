# Plugin and research sandbox image (SEC06, SEC12, packages/kernel/src/plugins/sandbox-exec.ts).
# Base: node 24 trixie-slim pinned by index digest. The Debian 12 base (bookworm) carries zlib CVE-2023-45853 (CRITICAL,
# will_not_fix), so it is not used. The trixie base's zlib1g carries two HIGH findings with a fix (deb13u1): upgraded below.
# npm and corepack (bundled brace-expansion and undici HIGH findings) are removed: sandboxed code runs `node` only, never a
# package manager. A shell and coreutils stay on purpose: SEC06 probes mount, chroot, unshare, su and nsenter from inside
# the container, and a distroless image would make those probes pass vacuously.
# Build: scripts/release/sandbox-image.sh (tags nearesis-sandbox:trixie-1). The image runs as an unprivileged user chosen
# by the runner (--user 65534:65534), read-only, with no network.
FROM node:24-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
RUN apt-get update \
 && apt-get install -y --no-install-recommends --only-upgrade zlib1g \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
