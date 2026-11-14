import { describe, expect, it } from "vitest";
import { EgressDenied, nonPublicReason, vetUrl } from "../src/index.ts";

const policy = { allowHosts: ["api.example.org"], allowInsecureHttp: false };

describe("egress guard", () => {
  it("classifies reserved ranges", () => {
    expect(nonPublicReason("169.254.169.254")).toBe("link-local-metadata");
    expect(nonPublicReason("::ffff:a9fe:a9fe")).toBe("link-local-metadata");
    expect(nonPublicReason("fd00:ec2::254")).toBe("unique-local");
    expect(nonPublicReason("8.8.8.8")).toBeNull();
    expect(nonPublicReason("2606:4700:4700::1111")).toBeNull();
  });
  it("default-denies: empty allowlist, http, credentials, unlisted host", async () => {
    const deny = async (u: string, p = policy) =>
      vetUrl(u, p, { resolve: async () => ["93.184.216.34"] }).then(
        () => "ok",
        (e) => (e as EgressDenied).reasonCode,
      );
    expect(await deny("https://api.example.org/x", { allowHosts: [], allowInsecureHttp: false })).toBe(
      "EGRESS_HOST_NOT_ALLOWED",
    );
    expect(await deny("http://api.example.org/x")).toBe("EGRESS_SCHEME");
    expect(await deny("https://u:p@api.example.org/x")).toBe("EGRESS_CREDENTIALS_IN_URL");
    expect(await deny("https://other.example.org/x")).toBe("EGRESS_HOST_NOT_ALLOWED");
    expect(await deny("https://api.example.org:8443/x")).toBe("EGRESS_HOST_NOT_ALLOWED");
    expect(await deny("https://api.example.org/x")).toBe("ok");
  });
});
