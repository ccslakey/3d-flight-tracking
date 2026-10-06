// Generates a low-poly airliner as public/models/airliner.glb (about A320 size, in meters).
// glTF axes: +X forward (nose), +Y up, Z across the wings. Cesium points a model's +X
// along its heading.
// Usage: tsx scripts/build-aircraft-model.ts

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Vec3 = [number, number, number];

const positions: number[] = [];
const normals: number[] = [];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

/** Flat-shaded triangle; the normal follows the winding. The material is double-sided. */
function tri(a: Vec3, b: Vec3, c: Vec3): void {
  const n = normalize(cross(sub(b, a), sub(c, a)));
  for (const v of [a, b, c]) {
    positions.push(...v);
    normals.push(...n);
  }
}

function quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
  tri(a, b, c);
  tri(a, c, d);
}

/** A tube lofted through rings along X: each station is [x, radius, centerY]. */
function loft(stations: [number, number, number][], sides: number, zOffset = 0): void {
  const ring = ([x, r, cy]: [number, number, number]): Vec3[] =>
    Array.from({ length: sides }, (_, i) => {
      const a = (i / sides) * 2 * Math.PI;
      return [x, cy + r * Math.cos(a), zOffset + r * Math.sin(a)];
    });
  const rings = stations.map(ring);
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      quad(rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i]);
    }
  }
  // Cap both ends.
  const capEnd = (r: Vec3[], center: Vec3) => r.forEach((v, i) => tri(center, r[(i + 1) % sides], v));
  const [x0, , y0] = stations[0];
  const [x1, , y1] = stations[stations.length - 1];
  capEnd(rings[0], [x0, y0, zOffset]);
  capEnd([...rings[rings.length - 1]].reverse(), [x1, y1, zOffset]);
}

/** A flat slab from a 4-point outline (top face), extruded down by `thickness` in Y. */
function slab(outline: [Vec3, Vec3, Vec3, Vec3], thickness: number, axis: 1 | 2 = 1): void {
  const off = (v: Vec3): Vec3 => {
    const o: Vec3 = [...v];
    o[axis] -= thickness;
    return o;
  };
  const top = outline;
  const bottom = outline.map(off) as [Vec3, Vec3, Vec3, Vec3];
  quad(top[0], top[1], top[2], top[3]);
  quad(bottom[3], bottom[2], bottom[1], bottom[0]);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(top[j], top[i], bottom[i], bottom[j]);
  }
}

// Fuselage: about 38 m long, 4 m wide, tail swept up.
loft(
  [
    [19.5, 0.15, 0],
    [18, 1.2, -0.1],
    [15, 1.9, 0],
    [-10, 2.0, 0],
    [-15, 1.5, 0.4],
    [-19, 0.4, 1.3],
  ],
  10,
);

// Wings: swept, slight dihedral, about 34 m span.
for (const side of [1, -1]) {
  slab(
    [
      [3, -0.6, 1.8 * side],
      [-4, -0.6, 1.8 * side],
      [-9, 0.6, 17 * side],
      [-7, 0.6, 17 * side],
    ],
    0.4,
  );
  // Horizontal stabilizer.
  slab(
    [
      [-14, 0.9, 1 * side],
      [-18, 0.9, 1 * side],
      [-19.8, 1.2, 6.2 * side],
      [-18.5, 1.2, 6.2 * side],
    ],
    0.25,
  );
  // Engine under each wing.
  loft(
    [
      [5.5, 0.9, -1.7],
      [2, 1.0, -1.7],
      [0.5, 0.7, -1.7],
    ],
    8,
    5.6 * side,
  );
}

// Vertical fin (thin in Z).
slab(
  [
    [-13, 1.6, 0.15],
    [-18.8, 1.6, 0.15],
    [-20.4, 8.2, 0.15],
    [-18.6, 8.2, 0.15],
  ],
  0.3,
  2,
);

// Pack a binary glTF: one mesh, non-indexed triangles, one double-sided material.
const posBuf = Buffer.from(new Float32Array(positions).buffer);
const nrmBuf = Buffer.from(new Float32Array(normals).buffer);
const bin = Buffer.concat([posBuf, nrmBuf]);
const vertexCount = positions.length / 3;
const min: Vec3 = [Infinity, Infinity, Infinity];
const max: Vec3 = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i++) {
  min[i % 3] = Math.min(min[i % 3], positions[i]);
  max[i % 3] = Math.max(max[i % 3], positions[i]);
}

const gltf = {
  asset: { version: "2.0", generator: "flight-tracker build-aircraft-model.ts" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
  materials: [
    {
      pbrMetallicRoughness: { baseColorFactor: [0.92, 0.93, 0.95, 1], metallicFactor: 0.1, roughnessFactor: 0.6 },
      doubleSided: true,
    },
  ],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: nrmBuf.length, target: 34962 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
  ],
};

const pad = (buf: Buffer, byte: number) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, byte)]);
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const binPadded = pad(bin, 0);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8);
const chunk = (type: number, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, data]);
};

const outDir = join("public", "models");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "airliner.glb");
writeFileSync(outPath, Buffer.concat([header, chunk(0x4e4f534a, json), chunk(0x004e4942, binPadded)]));
console.log(`Wrote ${outPath}: ${vertexCount / 3} triangles, ${(header.readUInt32LE(8) / 1024).toFixed(1)} KB`);
