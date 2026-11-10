import { CUBE_SECRET_DEV_DEFAULT, cubeLoad, cubeMeta, signCubeToken } from "../src/cube.ts";
import { LIVE_CUBE_URL_DEFAULT } from "../src/live/definition.ts";
import { loadLiveRegistry } from "../src/live/registry.ts";

const reg = loadLiveRegistry();
const token = signCubeToken(process.env.CUBEJS_API_SECRET ?? CUBE_SECRET_DEV_DEFAULT, {
  tenantId: "t",
  workspaceId: "w",
  principalId: "live-smoke",
});
const meta = await cubeMeta(LIVE_CUBE_URL_DEFAULT, token);
const views = meta.cubes.filter((c) => c.type === "view");
const members = new Set(views.flatMap((v) => (v.measures as Array<{ name: string }>).map((m) => m.name)));
console.log(
  "views",
  views.map((v) => v.name).join(","),
  "members match registry:",
  [...members].sort().join() ===
    reg.metrics
      .map((m) => m.cubeMember)
      .sort()
      .join(),
);
for (const m of reg.metrics) {
  const r = await cubeLoad(LIVE_CUBE_URL_DEFAULT, token, {
    measures: [m.cubeMember],
    timeDimensions: [
      {
        dimension: `${m.cubeMember.split(".")[0]}.day`,
        granularity: "month",
        dateRange: ["2026-10-01", "2026-11-09"],
      },
    ],
  });
  console.log(m.id, JSON.stringify(r.data.slice(-2)));
}
