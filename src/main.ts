import { Cartesian3, Ion, Math as CesiumMath, Terrain, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

const SFO_LAT = 37.6189;
const SFO_LON = -122.375;

const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (!ionToken) {
  throw new Error("VITE_CESIUM_ION_TOKEN is not set. Add it to .env.");
}
Ion.defaultAccessToken = ionToken;

const viewer = new Viewer("cesiumContainer", {
  terrain: Terrain.fromWorldTerrain(),
});

// Hide anything below terrain so altitude errors are visible.
viewer.scene.globe.depthTestAgainstTerrain = true;

// Look at SFO from the southeast, about 8 km out.
viewer.camera.setView({
  destination: Cartesian3.fromDegrees(SFO_LON + 0.06, SFO_LAT - 0.08, 3000),
  orientation: {
    heading: CesiumMath.toRadians(-30),
    pitch: CesiumMath.toRadians(-20),
    roll: 0,
  },
});
