import assert from "node:assert/strict";
import { analysisTimeFromFrame, firstTrackedFrame } from "../lib/analysis-time";

function close(actual: number, expected: number, label: string) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: expected ${expected}, got ${actual}`);
}

const frames = [8, 9, 10, 11];
const firstFrame = firstTrackedFrame(frames);
const expectedTimes = [0, 1 / 30, 2 / 30, 3 / 30];

frames.forEach((frame, index) => {
  close(analysisTimeFromFrame(frame, firstFrame, 30), expectedTimes[index], `frame ${frame}`);
});

// Removing frame 8 rebases the analysis timeline at frame 9.
close(analysisTimeFromFrame(9, firstTrackedFrame([9, 10, 11]), 30), 0, "rebased first frame");

console.log("Analysis time verification passed.");
