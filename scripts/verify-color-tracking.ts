import assert from "node:assert/strict";
import {
  boundedSearchRegion,
  buildHsvMask,
  chooseBestBlob,
  detectColorBlobs,
  isHsvMatch,
  makeColorSample,
  rgbToHsv,
} from "../lib/color-tracking.ts";

const red = rgbToHsv({ r: 255, g: 0, b: 0 });
assert.equal(Math.round(red.h), 0);
assert.equal(red.s, 1);
assert.equal(red.v, 1);
assert.ok(isHsvMatch(rgbToHsv({ r: 250, g: 15, b: 10 }), red, { hue: 8, saturation: 0.15, value: 0.15 }));
assert.ok(!isHsvMatch(rgbToHsv({ r: 0, g: 0, b: 255 }), red, { hue: 20, saturation: 0.2, value: 0.2 }));

const width = 8;
const height = 8;
const pixels = new Uint8ClampedArray(width * height * 4);
for (let index = 0; index < width * height; index += 1) pixels.set([10, 10, 10, 255], index * 4);
for (const [x, y] of [[3, 2], [4, 2], [3, 3], [4, 3]]) pixels.set([240, 20, 20, 255], (y * width + x) * 4);
// Node does not expose the browser ImageData constructor; the pure functions
// only require its structural data/width/height shape.
const image = { data: pixels, width, height } as ImageData;
const sample = makeColorSample({ data: new Uint8ClampedArray([240, 20, 20, 255]), width: 1, height: 1 } as ImageData);
const blobs = detectColorBlobs(image, sample, { hue: 12, saturation: 0.2, value: 0.2 }, { x: 100, y: 50 }, 3);
assert.equal(blobs.length, 1);
assert.equal(blobs[0].area, 4);
assert.equal(blobs[0].centroidX, 103.5);
assert.equal(blobs[0].centroidY, 52.5);
assert.deepEqual([blobs[0].minX, blobs[0].minY, blobs[0].maxX, blobs[0].maxY], [103, 52, 104, 53]);
assert.equal(buildHsvMask(image, sample, { hue: 12, saturation: 0.2, value: 0.2 }).reduce((total, value) => total + value, 0), 4);
const choice = chooseBestBlob(blobs, sample, { x: 103, y: 52, area: 4 }, 20);
assert.ok(choice && choice.confidence > 0.8);
assert.deepEqual(boundedSearchRegion({ x: 2, y: 2 }, 10, 20, 20), { x: 0, y: 0, width: 13, height: 13 });

console.log("Color-tracking verification passed.");
