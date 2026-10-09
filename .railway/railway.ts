import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "flight-tracker";

export default defineRailway(() => {
  // The relay's SQLite archive, so history survives redeploys.
  const data = volume("flight-tracker-volume", { region: "sfo", sizeMB: 5000 });

  const flight_tracker = service("flight-tracker", {
    source: github("ccslakey/3d-flight-tracking", { branch: "main" }),
    build: "npm run build",
    // Run node directly: through npm, every redeploy's SIGTERM is logged as a failed command.
    start: "node --import tsx server/relay.ts",
    healthcheck: "/api/status",
    volumeMounts: { "/data": data },
    networking: { serviceDomains: { "flight-tracker-production-ac9b.up.railway.app": {} } },
    env: {
      ARCHIVE_PATH: "/data/archive.sqlite",
      RETENTION_DAYS: "30",
      VITE_CESIUM_ION_TOKEN: preserve(), // set in Railway, not committed
    },
  });

  return project("flight-tracker", {
    resources: [data, flight_tracker],
  });
});
