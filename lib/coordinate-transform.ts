export type PixelCoordinate = {
  pixelX: number;
  pixelY: number;
};

export type PhysicalCoordinate = {
  x: number;
  y: number;
};

export function degreesToRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number) {
  return (radians * 180) / Math.PI;
}

export function normalizeDegrees(degrees: number) {
  const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

/**
 * Converts an on-screen pointer direction into a mathematical axis angle.
 * Screen y grows downward, so the screen atan2 result is negated to preserve
 * the physical convention: positive angles rotate counter-clockwise.
 */
export function axisAngleFromPointer(origin: PixelCoordinate, pointer: PixelCoordinate) {
  const screenAngle = Math.atan2(pointer.pixelY - origin.pixelY, pointer.pixelX - origin.pixelX);
  return normalizeDegrees(-radiansToDegrees(screenAngle));
}

export function snapAxisAngle(degrees: number, thresholdDegrees = 4) {
  const normalized = normalizeDegrees(degrees);
  const cardinalAngles = [0, 90, 180, -90];
  const snapped = cardinalAngles.find((angle) => Math.abs(normalizeDegrees(normalized - angle)) <= thresholdDegrees);
  return snapped ?? normalized;
}

/** Applies the rotated physical coordinate system to immutable source pixels. */
export function pixelToPhysicalCoordinate(
  point: PixelCoordinate,
  origin: PixelCoordinate,
  metersPerPixel: number,
  axisAngleDegrees: number,
): PhysicalCoordinate {
  const theta = degreesToRadians(axisAngleDegrees);
  const dx = point.pixelX - origin.pixelX;
  const dy = origin.pixelY - point.pixelY;

  return {
    x: (dx * Math.cos(theta) + dy * Math.sin(theta)) * metersPerPixel,
    y: (-dx * Math.sin(theta) + dy * Math.cos(theta)) * metersPerPixel,
  };
}

export function axisHandlePosition(origin: PixelCoordinate, axisAngleDegrees: number, distance: number): PixelCoordinate {
  const theta = degreesToRadians(axisAngleDegrees);
  return {
    pixelX: origin.pixelX + Math.cos(theta) * distance,
    pixelY: origin.pixelY - Math.sin(theta) * distance,
  };
}
