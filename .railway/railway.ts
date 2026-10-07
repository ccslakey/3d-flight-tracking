import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "flight-tracker";

export default defineRailway(() => {
  // The relay's sample log, so history survives redeploys.
  const data = volume("flight-tracker-volume", { region: "sfo", sizeMB: 5000 });

  const flight_tracker = service("flight-tracker", {
    source: github("ccslakey/3d-flight-tracking", { branch: "main" }),
    build: "npm run build",
    start: "npm run relay",
    healthcheck: "/api/status",
    volumeMounts: { "/data": data },
    networking: { serviceDomains: { "flight-tracker-production-ac9b.up.railway.app": {} } },
    env: {
      LIVE_DATA_DIR: "/data/live",
      RETENTION_HOURS: "4",
      VITE_CESIUM_ION_TOKEN: preserve(), // set in Railway, not committed
    },
  });

  return project("flight-tracker", {
    resources: [data, flight_tracker],
  });
});
