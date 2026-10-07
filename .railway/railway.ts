import { defineRailway, project, service } from "railway/iac";

// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "flight-tracker";

export default defineRailway(() => {
  const flight_tracker = service("flight-tracker", {
    build: "npm run build",
    start: "npm run relay",
    healthcheck: "/api/status",
    // builder from CaC: "RAILPACK"
  });
  return project("flight-tracker", {
    resources: [flight_tracker],
  });
});
