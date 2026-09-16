export type RgbColor = {
  r: number;
  g: number;
  b: number;
};

export type HsvColor = {
  /** Hue in degrees, from 0 (red) through 360. */
  h: number;
  /** Saturation and value are normalized to 0–1. */
  s: number;
  v: number;
};

export type HsvTolerance = {
  hue: number;
  saturation: number;
  value: number;
};

export type ColorSample = {
  rgb: RgbColor;
  hsv: HsvColor;
};

export type ColorBlob = {
  area: number;
  centroidX: number;
  centroidY: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  averageHsv: HsvColor;
};

export type BlobCandidate = ColorBlob & {
  confidence: number;
};

export type SearchRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function rgbToHsv({ r, g, b }: RgbColor): HsvColor {
  const red = Math.min(255, Math.max(0, r)) / 255;
  const green = Math.min(255, Math.max(0, g)) / 255;
  const blue = Math.min(255, Math.max(0, b)) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;

  let hue = 0;
  if (delta !== 0) {
    if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }

  return {
    h: (hue + 360) % 360,
    s: maximum === 0 ? 0 : delta / maximum,
    v: maximum,
  };
}

export function hueDistance(first: number, second: number) {
  const direct = Math.abs(first - second) % 360;
  return Math.min(direct, 360 - direct);
}

export function isHsvMatch(color: HsvColor, sample: HsvColor, tolerance: HsvTolerance) {
  return hueDistance(color.h, sample.h) <= tolerance.hue
    && Math.abs(color.s - sample.s) <= tolerance.saturation
    && Math.abs(color.v - sample.v) <= tolerance.value;
}

/** Returns the HSV comparison mask used by blob detection (one byte per pixel). */
export function buildHsvMask(imageData: ImageData, sample: ColorSample, tolerance: HsvTolerance) {
  const pixelCount = imageData.width * imageData.height;
  const mask = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const dataIndex = index * 4;
    if (imageData.data[dataIndex + 3] < 16) continue;
    if (isHsvMatch(rgbToHsv({ r: imageData.data[dataIndex], g: imageData.data[dataIndex + 1], b: imageData.data[dataIndex + 2] }), sample.hsv, tolerance)) {
      mask[index] = 1;
    }
  }
  return mask;
}

/** A per-channel median avoids one specular highlight changing the sampled color. */
export function medianRgbFromImageData(imageData: ImageData): RgbColor {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  for (let index = 0; index < imageData.data.length; index += 4) {
    if (imageData.data[index + 3] === 0) continue;
    reds.push(imageData.data[index]);
    greens.push(imageData.data[index + 1]);
    blues.push(imageData.data[index + 2]);
  }
  if (reds.length === 0) return { r: 0, g: 0, b: 0 };
  const median = (values: number[]) => {
    values.sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  return { r: median(reds), g: median(greens), b: median(blues) };
}

export function makeColorSample(imageData: ImageData): ColorSample {
  const rgb = medianRgbFromImageData(imageData);
  return { rgb, hsv: rgbToHsv(rgb) };
}

/**
 * Finds 4-connected, HSV-matching areas in a small Canvas crop. Offset turns
 * crop-local coordinates back into the video’s native pixel coordinates.
 */
export function detectColorBlobs(
  imageData: ImageData,
  sample: ColorSample,
  tolerance: HsvTolerance,
  offset = { x: 0, y: 0 },
  minimumArea = 8,
): ColorBlob[] {
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const mask = buildHsvMask(imageData, sample, tolerance);
  const visited = new Uint8Array(pixelCount);

  const blobs: ColorBlob[] = [];
  const queue = new Int32Array(pixelCount);
  for (let start = 0; start < pixelCount; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let sumS = 0;
    let sumV = 0;
    let hueX = 0;
    let hueY = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;

    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = Math.floor(current / width);
      const dataIndex = current * 4;
      const hsv = rgbToHsv({ r: data[dataIndex], g: data[dataIndex + 1], b: data[dataIndex + 2] });
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      sumS += hsv.s;
      sumV += hsv.v;
      const radians = (hsv.h * Math.PI) / 180;
      hueX += Math.cos(radians);
      hueY += Math.sin(radians);

      const neighbours = [current - 1, current + 1, current - width, current + width];
      for (const neighbour of neighbours) {
        const neighbourX = neighbour % width;
        if (neighbour < 0 || neighbour >= pixelCount || (neighbour === current - 1 && neighbourX !== x - 1) || (neighbour === current + 1 && neighbourX !== x + 1) || !mask[neighbour] || visited[neighbour]) continue;
        visited[neighbour] = 1;
        queue[tail++] = neighbour;
      }
    }

    if (area >= minimumArea) {
      blobs.push({
        area,
        centroidX: offset.x + sumX / area,
        centroidY: offset.y + sumY / area,
        minX: offset.x + minX,
        minY: offset.y + minY,
        maxX: offset.x + maxX,
        maxY: offset.y + maxY,
        averageHsv: {
          h: ((Math.atan2(hueY, hueX) * 180) / Math.PI + 360) % 360,
          s: sumS / area,
          v: sumV / area,
        },
      });
    }
  }
  return blobs;
}

export function chooseBestBlob(
  blobs: ColorBlob[],
  sample: ColorSample,
  previous: { x: number; y: number; area?: number },
  searchRadius: number,
): BlobCandidate | null {
  if (blobs.length === 0) return null;
  let best: BlobCandidate | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const blob of blobs) {
    const distance = Math.hypot(blob.centroidX - previous.x, blob.centroidY - previous.y);
    const colorDifference = hueDistance(blob.averageHsv.h, sample.hsv.h) / 180
      + Math.abs(blob.averageHsv.s - sample.hsv.s)
      + Math.abs(blob.averageHsv.v - sample.hsv.v);
    const areaDifference = previous.area && previous.area > 0 ? Math.abs(blob.area - previous.area) / previous.area : 0;
    const score = distance / Math.max(searchRadius, 1) + colorDifference * 0.75 + Math.min(areaDifference, 2) * 0.35;
    if (score < bestScore) {
      bestScore = score;
      const confidence = Math.max(0, Math.min(1, 1 - (distance / Math.max(searchRadius, 1)) * 0.45 - colorDifference * 0.3 - Math.min(areaDifference, 1) * 0.25));
      best = { ...blob, confidence };
    }
  }
  return best;
}

export function boundedSearchRegion(center: { x: number; y: number }, radius: number, width: number, height: number): SearchRegion {
  const boundedRadius = Math.max(1, radius);
  const left = Math.max(0, Math.floor(center.x - boundedRadius));
  const top = Math.max(0, Math.floor(center.y - boundedRadius));
  const right = Math.min(width, Math.ceil(center.x + boundedRadius + 1));
  const bottom = Math.min(height, Math.ceil(center.y + boundedRadius + 1));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}
