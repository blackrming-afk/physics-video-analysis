/**
 * Analysis time is intentionally distinct from the media element's native
 * currentTime. It makes the earliest retained tracking point the t = 0
 * reference without changing video playback or frame seeking.
 */
export function firstTrackedFrame(frames: readonly number[]) {
  const validFrames = frames.filter((frame) => Number.isFinite(frame));
  return validFrames.length > 0 ? Math.min(...validFrames) : 0;
}

export function analysisTimeFromFrame(frame: number, referenceFrame: number, fps: number) {
  if (!Number.isFinite(frame) || !Number.isFinite(referenceFrame) || !Number.isFinite(fps) || fps <= 0) {
    return 0;
  }

  return (frame - referenceFrame) / fps;
}
