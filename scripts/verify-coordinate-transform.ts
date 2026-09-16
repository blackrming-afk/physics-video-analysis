import assert from "node:assert/strict";
import {
  axisAngleFromPointer,
  pixelToPhysicalCoordinate,
  snapAxisAngle,
} from "../lib/coordinate-transform";

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
}

const origin = { pixelX: 100, pixelY: 100 };
const point = { pixelX: 130, pixelY: 80 };

let result = pixelToPhysicalCoordinate(point, origin, 0.1, 0);
close(result.x, 3, "0° x");
close(result.y, 2, "0° y");

result = pixelToPhysicalCoordinate(point, origin, 0.1, 90);
close(result.x, 2, "90° x");
close(result.y, -3, "90° y");

result = pixelToPhysicalCoordinate(point, origin, 0.1, -90);
close(result.x, -2, "-90° x");
close(result.y, 3, "-90° y");

result = pixelToPhysicalCoordinate(point, origin, 0.1, 30);
close(result.x, (30 * Math.cos(Math.PI / 6) + 20 * Math.sin(Math.PI / 6)) * 0.1, "30° x");
close(result.y, (-30 * Math.sin(Math.PI / 6) + 20 * Math.cos(Math.PI / 6)) * 0.1, "30° y");

close(axisAngleFromPointer(origin, { pixelX: 200, pixelY: 100 }), 0, "pointer right");
close(axisAngleFromPointer(origin, { pixelX: 100, pixelY: 0 }), 90, "pointer up");
close(axisAngleFromPointer(origin, { pixelX: 100, pixelY: 200 }), -90, "pointer down");
close(snapAxisAngle(2.5), 0, "snap 0°");

console.log("Coordinate transform verification passed.");
