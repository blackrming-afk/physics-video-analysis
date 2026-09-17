"use client";

import {
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileVideo,
  FolderOpen,
  MapPin,
  MoveRight,
  Pause,
  Play,
  Ruler,
  RotateCcw,
  Timer,
  TestTube2,
  Trash2,
} from "lucide-react";
import {
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fitData, type FitModel, type FitResult } from "@/lib/curve-fitting";
import { analysisTimeFromFrame, firstTrackedFrame } from "@/lib/analysis-time";
import { FloatingFitResultPanel } from "@/components/FloatingFitResultPanel";
import { StepNavigation, type WorkflowStep } from "@/components/StepNavigation";
import {
  boundedSearchRegion,
  buildHsvMask,
  chooseBestBlob,
  detectColorBlobs,
  makeColorSample,
  type BlobCandidate,
  type ColorBlob,
  type ColorSample,
  type HsvTolerance,
  type SearchRegion,
} from "@/lib/color-tracking";
import {
  axisAngleFromPointer,
  axisHandlePosition,
  degreesToRadians,
  pixelToPhysicalCoordinate,
  snapAxisAngle,
} from "@/lib/coordinate-transform";
import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

const DEFAULT_FPS = 30;
const TRACKING_PRESETS: Record<AutoTrackingPreset, HsvTolerance> = {
  strict: { hue: 10, saturation: 0.14, value: 0.14 },
  standard: { hue: 18, saturation: 0.25, value: 0.25 },
  loose: { hue: 32, saturation: 0.4, value: 0.4 },
};

type InteractionMode = "track" | "scale" | "origin";

type PixelPoint = {
  pixelX: number;
  pixelY: number;
};

type TrackingPoint = PixelPoint & {
  frame: number;
  time: number;
  trackingMethod?: "manual" | "auto";
  trackingConfidence?: number;
};

type TrackingMethod = "manual" | "auto";
type AutoTrackingPreset = "strict" | "standard" | "loose";
type TrackingFailure = { frame: number; message: string };
type AutoTrackingDiagnostics = {
  frame: number;
  candidateCount: number;
  candidates: ColorBlob[];
  selected: BlobCandidate | null;
  displacement?: number;
  expandedSearch: boolean;
  searchRegion?: SearchRegion;
  failureReason?: string;
};
type DebugMaskOverlay = { dataUrl: string; region: SearchRegion };

type ScaleCalibration = {
  pointA: PixelPoint;
  pointB: PixelPoint;
  pixelDistance: number;
  realLengthM: number;
  metersPerPixel: number;
};

type AnalysisMode = "raw" | "smooth";

type AnalysisPoint = TrackingPoint & {
  time: number;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  speed?: number;
  ax?: number;
  ay?: number;
  acceleration?: number;
};

type ChartMetric = "xy" | "x" | "y" | "vx" | "vy" | "speed" | "ax" | "ay";

type ChartPoint = {
  frame: number;
  time: number;
  inFitRange: boolean;
  x?: number;
  y?: number;
  value?: number;
};

type XyChartPoint = ChartPoint & {
  x: number;
  y: number;
};

type TimeChartPoint = ChartPoint & {
  value: number;
};

type ContentBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type VideoDimensions = {
  width: number;
  height: number;
};

function upsertTrackingPoint(points: TrackingPoint[], nextPoint: TrackingPoint) {
  return [...points.filter((point) => point.frame !== nextPoint.frame), nextPoint]
    .sort((left, right) => left.frame - right.frame);
}

function frameFromTime(time: number, fps: number) {
  if (!Number.isFinite(time) || !Number.isFinite(fps) || fps <= 0) return 0;
  return Math.max(0, Math.round(time * fps));
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "00:00.000";

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000).toString().padStart(3, "0");
  return `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}.${milliseconds}`;
}

function formatPixelDistance(distance: number) {
  return distance >= 100 ? distance.toFixed(0) : distance.toFixed(1);
}

function formatNumber(value: number | undefined, digits = 3) {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatSignificant(value: number | undefined) {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toPrecision(4);
}

function difference(
  before: number,
  after: number,
  beforeTime: number,
  afterTime: number,
) {
  const timeDifference = afterTime - beforeTime;
  const result = timeDifference === 0 ? undefined : (after - before) / timeDifference;
  return result !== undefined && Number.isFinite(result) ? result : undefined;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const objectUrlRef = useRef<string | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const originDragPointerRef = useRef<number | null>(null);
  const axisDragPointerRef = useRef<number | null>(null);
  const crosshairDragPointerRef = useRef<number | null>(null);
  const seekTokenRef = useRef(0);
  const pendingSeekRef = useRef<{ token: number; targetTime: number } | null>(null);
  const autoTrackingRunRef = useRef(0);
  const trackingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fitPanelContainerRef = useRef<HTMLDivElement>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [fps, setFps] = useState(DEFAULT_FPS);
  const [fpsInput, setFpsInput] = useState(String(DEFAULT_FPS));
  const [currentTime, setCurrentTime] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubTime, setScrubTime] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [workflowStep, setWorkflowStep] = useState<WorkflowStep>("video");
  const [mode, setMode] = useState<InteractionMode>("track");
  const [trackingPoints, setTrackingPoints] = useState<TrackingPoint[]>([]);
  const [editingFrame, setEditingFrame] = useState<number | null>(null);
  const [contentBounds, setContentBounds] = useState<ContentBounds | null>(null);
  const [videoDimensions, setVideoDimensions] = useState<VideoDimensions | null>(null);
  const [scaleDraftA, setScaleDraftA] = useState<PixelPoint | null>(null);
  const [scaleDraftB, setScaleDraftB] = useState<PixelPoint | null>(null);
  const [scaleLengthInput, setScaleLengthInput] = useState("");
  const [scaleCalibration, setScaleCalibration] = useState<ScaleCalibration | null>(null);
  const [origin, setOrigin] = useState<PixelPoint | null>(null);
  const [axisAngleDegrees, setAxisAngleDegrees] = useState(0);
  const [isDraggingOrigin, setIsDraggingOrigin] = useState(false);
  const [isDraggingAxis, setIsDraggingAxis] = useState(false);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("raw");
  const [chartMetric, setChartMetric] = useState<ChartMetric>("x");
  const [equalAxisScale, setEqualAxisScale] = useState(false);
  const [fitModel, setFitModel] = useState<FitModel>("none");
  const [fitStartFrame, setFitStartFrame] = useState("");
  const [fitEndFrame, setFitEndFrame] = useState("");
  const [fitPanelPosition, setFitPanelPosition] = useState({ x: 12, y: 12 });
  const [isFitPanelVisible, setIsFitPanelVisible] = useState(true);
  const [isFitPanelCollapsed, setIsFitPanelCollapsed] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(false);
  const [trackingMethod, setTrackingMethod] = useState<TrackingMethod>("manual");
  const [isSelectingColor, setIsSelectingColor] = useState(false);
  const [colorSample, setColorSample] = useState<(ColorSample & PixelPoint) | null>(null);
  const [autoPreset, setAutoPreset] = useState<AutoTrackingPreset>("standard");
  const [hsvTolerance, setHsvTolerance] = useState<HsvTolerance>(TRACKING_PRESETS.standard);
  const [searchRadius, setSearchRadius] = useState(80);
  const [trackingReticleRadius, setTrackingReticleRadius] = useState(18);
  const [crosshairCenter, setCrosshairCenter] = useState<PixelPoint | null>(null);
  const [isDraggingCrosshair, setIsDraggingCrosshair] = useState(false);
  const [advanceAfterManualRecord, setAdvanceAfterManualRecord] = useState(true);
  const [showTrackingTrail, setShowTrackingTrail] = useState(true);
  const [showTrajectoryLines, setShowTrajectoryLines] = useState(false);
  const [showSearchArea, setShowSearchArea] = useState(true);
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [showBinaryMask, setShowBinaryMask] = useState(false);
  const [showCandidateBlobs, setShowCandidateBlobs] = useState(false);
  const [autoTrackingDiagnostics, setAutoTrackingDiagnostics] = useState<AutoTrackingDiagnostics | null>(null);
  const [debugMaskOverlay, setDebugMaskOverlay] = useState<DebugMaskOverlay | null>(null);
  const [autoTrackingStatus, setAutoTrackingStatus] = useState<"idle" | "running" | "stopped" | "failed" | "completed">("idle");
  const [autoSearchPoint, setAutoSearchPoint] = useState<(PixelPoint & { radius: number }) | null>(null);
  const [trackingFailures, setTrackingFailures] = useState<TrackingFailure[]>([]);
  const [error, setError] = useState("");

  const typedFps = Number(fpsInput);
  const activeFps = Number.isFinite(typedFps) && typedFps > 0 ? typedFps : fps;
  const currentFrame = frameFromTime(currentTime, activeFps);
  // The label always reflects a rendered video frame. The slider may retain its
  // pending position while a seek is still completing.
  const timelineTime = isScrubbing && !isSeeking ? scrubTime : currentTime;
  const timelineSliderTime = isScrubbing || isSeeking ? scrubTime : currentTime;
  const canControl = Boolean(videoUrl);
  const videoWidth = videoDimensions?.width || 0;
  const videoHeight = videoDimensions?.height || 0;
  const axisAngleRadians = degreesToRadians(axisAngleDegrees);
  const axisCosine = Math.cos(axisAngleRadians);
  const axisSine = Math.sin(axisAngleRadians);
  const axisHandleDistance = Math.min(160, Math.max(80, Math.min(videoWidth || 80, videoHeight || 80) * 0.18));
  const axisHandle = origin ? axisHandlePosition(origin, axisAngleDegrees, axisHandleDistance) : null;
  const crosshairVisualExtent = trackingReticleRadius + Math.max(5, trackingReticleRadius * 0.38);
  const crosshairPreviewPoint: PixelPoint | null = (workflowStep === "reticle" || workflowStep === "tracking") && videoWidth > 0 && videoHeight > 0
    ? crosshairCenter ?? { pixelX: Math.round(videoWidth / 2), pixelY: Math.round(videoHeight / 2) }
    : null;
  const sortedPoints = [...trackingPoints].sort((a, b) => a.frame - b.frame);
  const firstAnalysisFrame = firstTrackedFrame(sortedPoints.map((point) => point.frame));
  const maximumTrajectoryFrameGap = Math.max(3, Math.round(activeFps * 0.2));
  const hasPhysicalCoordinates = Boolean(scaleCalibration && origin);
  const missingSetup = [!scaleCalibration && "比例尺", !origin && "原點"].filter(Boolean).join("、");
  const draftPixelDistance = scaleDraftA && scaleDraftB
    ? Math.hypot(scaleDraftB.pixelX - scaleDraftA.pixelX, scaleDraftB.pixelY - scaleDraftA.pixelY)
    : 0;
  const scaleLine = scaleDraftA ? { pointA: scaleDraftA, pointB: scaleDraftB } : scaleCalibration;

  const updateContentBounds = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      setContentBounds(null);
      return;
    }

    const elementWidth = video.clientWidth;
    const elementHeight = video.clientHeight;
    if (!elementWidth || !elementHeight) return;

    const sourceAspect = video.videoWidth / video.videoHeight;
    const elementAspect = elementWidth / elementHeight;
    const width = elementAspect > sourceAspect ? elementHeight * sourceAspect : elementWidth;
    const height = elementAspect > sourceAspect ? elementHeight : elementWidth / sourceAspect;
    const nextBounds = { left: (elementWidth - width) / 2, top: (elementHeight - height) / 2, width, height };

    setContentBounds((previous) => (
      previous && Math.abs(previous.left - nextBounds.left) < 0.1 && Math.abs(previous.top - nextBounds.top) < 0.1 && Math.abs(previous.width - nextBounds.width) < 0.1 && Math.abs(previous.height - nextBounds.height) < 0.1
        ? previous
        : nextBounds
    ));
  }, []);

  useEffect(() => () => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const observer = new ResizeObserver(updateContentBounds);
    observer.observe(video);
    window.addEventListener("orientationchange", updateContentBounds);
    updateContentBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", updateContentBounds);
    };
  }, [updateContentBounds, videoUrl]);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // iOS may report video/quicktime, another video MIME type, or no MIME type
    // at all for files selected from Photos, Files, or iCloud Drive. Accept the
    // file here and let the browser's video element determine codec support.
    const selectedFileName = file.name.toLowerCase();
    const supportedByExtension = selectedFileName.endsWith(".mp4") || selectedFileName.endsWith(".mov");
    const supportedByMime = file.type.startsWith("video/") || file.type === "video/mp4" || file.type === "video/quicktime";
    if (!supportedByExtension && !supportedByMime) {
      setError("請選擇影片檔。");
      event.target.value = "";
      return;
    }

    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    autoTrackingRunRef.current += 1;
    seekTokenRef.current += 1;
    pendingSeekRef.current = null;
    objectUrlRef.current = URL.createObjectURL(file);
    setVideoUrl(objectUrlRef.current);
    setIsDemoMode(false);
    setFileName(file.name);
    setCurrentTime(0);
    setScrubTime(0);
    setIsScrubbing(false);
    setIsSeeking(false);
    setDuration(0);
    setIsPlaying(false);
    setMode("track");
    setTrackingMethod("manual");
    setIsSelectingColor(false);
    setColorSample(null);
    setCrosshairCenter(null);
    setAutoTrackingStatus("idle");
    setAutoSearchPoint(null);
    setTrackingFailures([]);
    setAutoTrackingDiagnostics(null);
    setDebugMaskOverlay(null);
    setTrackingPoints([]);
    setEditingFrame(null);
    setScaleDraftA(null);
    setScaleDraftB(null);
    setScaleLengthInput("");
    setScaleCalibration(null);
    setOrigin(null);
    setAxisAngleDegrees(0);
    setContentBounds(null);
    setVideoDimensions(null);
    setError("");
  };

  const loadDemoData = () => {
    autoTrackingRunRef.current += 1;
    seekTokenRef.current += 1;
    pendingSeekRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }

    const demoFps = 30;
    const pixelsPerMeter = 1000;
    const demoOrigin = { pixelX: 1000, pixelY: 40000 };
    const measurementNoise = (index: number, phase: number) => {
      const raw = Math.sin((index + 1) * 12.9898 + phase * 78.233) * 43758.5453;
      return (raw - Math.floor(raw) - 0.5) * 0.006;
    };
    const demoPoints: TrackingPoint[] = Array.from({ length: 30 }, (_, index) => {
      const time = index * 0.1;
      const x = 2 * time + 0.5 + measurementNoise(index, 1);
      const y = 1.2 + 3 * time - 4.9 * time ** 2 + measurementNoise(index, 2);
      return {
        frame: index * 3,
        time,
        pixelX: Math.round(demoOrigin.pixelX + x * pixelsPerMeter),
        pixelY: Math.round(demoOrigin.pixelY - y * pixelsPerMeter),
      };
    });

    setVideoUrl(null);
    setFileName("Demo：模擬拋體資料（非實驗影片）");
    setFps(demoFps);
    setFpsInput(String(demoFps));
    setCurrentTime(0);
    setScrubTime(0);
    setIsScrubbing(false);
    setIsSeeking(false);
    setDuration(0);
    setIsPlaying(false);
    setMode("track");
    setTrackingMethod("manual");
    setIsSelectingColor(false);
    setColorSample(null);
    setCrosshairCenter(null);
    setAutoTrackingStatus("idle");
    setAutoSearchPoint(null);
    setTrackingFailures([]);
    setAutoTrackingDiagnostics(null);
    setDebugMaskOverlay(null);
    setTrackingPoints(demoPoints);
    setEditingFrame(null);
    setScaleDraftA(null);
    setScaleDraftB(null);
    setScaleLengthInput("");
    setScaleCalibration({
      pointA: demoOrigin,
      pointB: { pixelX: demoOrigin.pixelX + pixelsPerMeter, pixelY: demoOrigin.pixelY },
      pixelDistance: pixelsPerMeter,
      realLengthM: 1,
      metersPerPixel: 1 / pixelsPerMeter,
    });
    setOrigin(demoOrigin);
    setAxisAngleDegrees(0);
    setContentBounds(null);
    setVideoDimensions(null);
    setAnalysisMode("raw");
    setChartMetric("y");
    setFitModel("quadratic");
    setFitStartFrame("");
    setFitEndFrame("");
    setIsDemoMode(true);
    setError("");
  };

  const clearDemoData = () => {
    if (!isDemoMode) return;
    autoTrackingRunRef.current += 1;
    seekTokenRef.current += 1;
    pendingSeekRef.current = null;
    setIsSeeking(false);
    setIsDemoMode(false);
    setFileName("");
    setTrackingPoints([]);
    setEditingFrame(null);
    setScaleCalibration(null);
    setOrigin(null);
    setAxisAngleDegrees(0);
    setFitModel("none");
    setFitStartFrame("");
    setFitEndFrame("");
    setColorSample(null);
    setCrosshairCenter(null);
    setAutoTrackingStatus("idle");
    setAutoSearchPoint(null);
    setAutoTrackingDiagnostics(null);
    setDebugMaskOverlay(null);
  };

  const commitFps = () => {
    const nextFps = Number(fpsInput);
    if (Number.isFinite(nextFps) && nextFps > 0) {
      setFps(nextFps);
      setFpsInput(String(nextFps));
    } else {
      setFpsInput(String(fps));
    }
  };

  const togglePlayback = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      try {
        await video.play();
      } catch {
        setError("影片無法播放，請確認檔案格式是否支援。");
      }
    } else {
      video.pause();
    }
  };

  const syncTimeFromVideo = (video: HTMLVideoElement, token = seekTokenRef.current, waitForRenderedFrame = true) => {
    const applySync = () => {
      if (token !== seekTokenRef.current || video.seeking) return;
      const actualTime = video.currentTime;
      const pendingSeek = pendingSeekRef.current;
      // Ignore a late seeked event from an earlier slider position. The final
      // slider target remains authoritative during rapid scrubbing.
      if (pendingSeek && (pendingSeek.token !== token || Math.abs(actualTime - pendingSeek.targetTime) > 0.001)) return;
      setCurrentTime(actualTime);
      setScrubTime(actualTime);
      pendingSeekRef.current = null;
      setIsSeeking(false);
    };
    const frameVideo = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
    if (waitForRenderedFrame && typeof frameVideo.requestVideoFrameCallback === "function") {
      frameVideo.requestVideoFrameCallback(() => applySync());
    } else {
      requestAnimationFrame(applySync);
    }
  };

  const seekToTime = (requestedTime: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(requestedTime)) return;
    const maximumTime = Number.isFinite(video.duration) ? video.duration : 0;
    const targetTime = Math.min(Math.max(requestedTime, 0), maximumTime);
    const wasAlreadyAtTarget = !video.seeking && Math.abs(video.currentTime - targetTime) < 0.0001;
    const token = seekTokenRef.current + 1;
    seekTokenRef.current = token;
    pendingSeekRef.current = { token, targetTime };
    setIsSeeking(true);
    setScrubTime(targetTime);
    // The video element is the source of truth. UI time is updated only after seek completion.
    video.currentTime = targetTime === 0 ? 0 : targetTime;
    requestAnimationFrame(() => {
      if (token === seekTokenRef.current && !video.seeking && Math.abs(video.currentTime - targetTime) < 0.0001) {
        syncTimeFromVideo(video, token, !wasAlreadyAtTarget);
      }
    });
  };

  const seekToFrame = (frame: number) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    // A duration exactly on a frame boundary does not add another displayable frame.
    const maximumFrame = Math.max(0, Math.ceil(video.duration * activeFps) - 1);
    const targetFrame = Math.min(Math.max(0, Math.round(frame)), maximumFrame);
    seekToTime(targetFrame / activeFps);
  };

  const seekOneFrame = (direction: -1 | 1) => {
    const video = videoRef.current;
    if (!video) return;
    // The media element—not React state—is the stepping source of truth.
    video.pause();
    const currentFrameFromVideo = frameFromTime(video.currentTime, activeFps);
    seekToFrame(currentFrameFromVideo + direction);
  };

  const beginTimelineScrub = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    setIsScrubbing(true);
    setScrubTime(video.currentTime);
  };

  const seekTimeline = (nextTime: number) => seekToTime(nextTime);

  const endTimelineScrub = () => setIsScrubbing(false);

  const reset = () => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    seekToTime(0);
  };

  const setActiveMode = (nextMode: InteractionMode) => {
    if (nextMode === "scale") {
      setScaleDraftA(null);
      setScaleDraftB(null);
      setScaleLengthInput("");
    }
    if (nextMode !== "track") setIsSelectingColor(false);
    setMode(nextMode);
  };

  const setTrackingWorkflow = (nextMethod: TrackingMethod) => {
    autoTrackingRunRef.current += 1;
    setAutoTrackingStatus("idle");
    setAutoSearchPoint(null);
    setIsSelectingColor(false);
    setTrackingMethod(nextMethod);
    setEditingFrame(null);
    setMode("track");
  };

  const getPixelPointFromClient = (clientX: number, clientY: number): PixelPoint | null => {
    const video = videoRef.current;
    const displayBounds = overlayRef.current?.getBoundingClientRect();
    if (!video || !displayBounds || !video.videoWidth || !video.videoHeight) return null;
    const normalizedX = Math.min(Math.max((clientX - displayBounds.left) / displayBounds.width, 0), 1);
    const normalizedY = Math.min(Math.max((clientY - displayBounds.top) / displayBounds.height, 0), 1);
    return {
      pixelX: Math.min(video.videoWidth - 1, Math.max(0, Math.round(normalizedX * video.videoWidth))),
      pixelY: Math.min(video.videoHeight - 1, Math.max(0, Math.round(normalizedY * video.videoHeight))),
    };
  };

  const getPixelPoint = (event: ReactPointerEvent<HTMLDivElement>) => getPixelPointFromClient(event.clientX, event.clientY);

  const clampCrosshairCenter = (point: PixelPoint, visualExtent = crosshairVisualExtent): PixelPoint => {
    const horizontalMargin = Math.min(visualExtent, Math.max(0, (videoWidth - 1) / 2));
    const verticalMargin = Math.min(visualExtent, Math.max(0, (videoHeight - 1) / 2));
    return {
      pixelX: Math.round(Math.min(Math.max(point.pixelX, horizontalMargin), Math.max(horizontalMargin, videoWidth - 1 - horizontalMargin))),
      pixelY: Math.round(Math.min(Math.max(point.pixelY, verticalMargin), Math.max(verticalMargin, videoHeight - 1 - verticalMargin))),
    };
  };

  const updateCrosshairCenterFromPointer = (clientX: number, clientY: number) => {
    const point = getPixelPointFromClient(clientX, clientY);
    if (point) setCrosshairCenter(clampCrosshairCenter(point));
  };

  const beginCrosshairDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isPlaying || (workflowStep !== "reticle" && workflowStep !== "tracking")) return;
    event.preventDefault();
    event.stopPropagation();
    if (workflowStep === "tracking" && autoTrackingStatus === "running") {
      autoTrackingRunRef.current += 1;
      videoRef.current?.pause();
      setAutoTrackingStatus("stopped");
      setAutoSearchPoint(null);
      setError("已停止自動追蹤；可從新的準星位置繼續追蹤。");
    }
    crosshairDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateCrosshairCenterFromPointer(event.clientX, event.clientY);
    setIsDraggingCrosshair(true);
  };

  const moveCrosshairDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (crosshairDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateCrosshairCenterFromPointer(event.clientX, event.clientY);
  };

  const endCrosshairDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (crosshairDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateCrosshairCenterFromPointer(event.clientX, event.clientY);
    crosshairDragPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingCrosshair(false);
  };

  const beginOriginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isPlaying || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    originDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDraggingOrigin(true);
  };

  const moveOriginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (originDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const point = getPixelPointFromClient(event.clientX, event.clientY);
    if (point) setOrigin(point);
  };

  const endOriginDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (originDragPointerRef.current !== event.pointerId) return;
    const point = getPixelPointFromClient(event.clientX, event.clientY);
    if (point) setOrigin(point);
    originDragPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingOrigin(false);
  };

  const updateAxisAngleFromPointer = (clientX: number, clientY: number) => {
    if (!origin) return;
    const pointer = getPixelPointFromClient(clientX, clientY);
    if (!pointer) return;
    setAxisAngleDegrees(snapAxisAngle(axisAngleFromPointer(origin, pointer)));
  };

  const beginAxisDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (isPlaying || !origin) return;
    event.preventDefault();
    event.stopPropagation();
    axisDragPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateAxisAngleFromPointer(event.clientX, event.clientY);
    setIsDraggingAxis(true);
  };

  const moveAxisDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (axisDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateAxisAngleFromPointer(event.clientX, event.clientY);
  };

  const endAxisDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (axisDragPointerRef.current !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateAxisAngleFromPointer(event.clientX, event.clientY);
    axisDragPointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setIsDraggingAxis(false);
  };

  const advanceAfterManualTrackingRecord = () => {
    if (!advanceAfterManualRecord) return;

    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;

    video.pause();
    const lastTrackableFrame = Math.max(0, Math.ceil(video.duration * activeFps) - 1);
    if (currentFrame >= lastTrackableFrame) {
      setError("已到影片最後一格");
      return;
    }

    setError("");
    seekToFrame(currentFrame + 1);
  };

  const recordManualTrackingPoint = (point: PixelPoint) => {
    if (trackingMethod !== "manual" || editingFrame !== null) return;

    const trackingPoint: TrackingPoint = {
      ...point,
      frame: currentFrame,
      time: currentFrame / activeFps,
      trackingMethod: "manual",
      trackingConfidence: 1,
    };
    setTrackingPoints((previous) => upsertTrackingPoint(previous, trackingPoint));
    setTrackingFailures((previous) => previous.filter((failure) => failure.frame !== currentFrame));
    if (autoTrackingStatus === "failed") setAutoTrackingStatus("stopped");
    advanceAfterManualTrackingRecord();
  };

  const beginEditingTrackingPoint = (point: TrackingPoint) => {
    autoTrackingRunRef.current += 1;
    videoRef.current?.pause();
    setAutoTrackingStatus("stopped");
    setAutoSearchPoint(null);
    setIsSelectingColor(false);
    setTrackingMethod("manual");
    setMode("track");
    setEditingFrame(point.frame);
    setCrosshairCenter(clampCrosshairCenter(point));
    setError("");
    seekToFrame(point.frame);
  };

  const updateEditingTrackingPoint = () => {
    if (editingFrame === null || !crosshairPreviewPoint) return;

    const existingPoint = trackingPoints.find((point) => point.frame === editingFrame);
    if (!existingPoint) {
      setEditingFrame(null);
      return;
    }

    const updatedPoint: TrackingPoint = {
      ...existingPoint,
      ...crosshairPreviewPoint,
      trackingMethod: "manual",
      trackingConfidence: 1,
    };
    setTrackingPoints((points) => upsertTrackingPoint(points, updatedPoint));
    setTrackingFailures((failures) => failures.filter((failure) => failure.frame !== editingFrame));
    setEditingFrame(null);
    setError("");
  };

  const deleteTrackingPoint = (frame: number) => {
    if (!window.confirm(`確定刪除 Frame ${frame} 的追蹤點嗎？`)) return;
    setTrackingPoints((points) => points.filter((point) => point.frame !== frame));
    setTrackingFailures((failures) => failures.filter((failure) => failure.frame !== frame));
    if (editingFrame === frame) setEditingFrame(null);
  };

  const clearTrackingPoints = () => {
    if (!window.confirm("確定清除全部追蹤點嗎？此動作無法復原。")) return;
    setTrackingPoints([]);
    setTrackingFailures([]);
    setEditingFrame(null);
  };

  const handleOverlayPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (isPlaying) return;
    event.preventDefault();
    event.stopPropagation();
    const point = getPixelPoint(event);
    if (!point) return;

    if (mode === "scale") {
      if (workflowStep !== "calibration") return;
      if (!scaleDraftA || scaleDraftB) {
        setScaleDraftA(point);
        setScaleDraftB(null);
        setScaleLengthInput("");
      } else {
        setScaleDraftB(point);
      }
      return;
    }

    if (mode === "origin") {
      if (workflowStep !== "calibration") return;
      setOrigin(point);
      setMode("track");
      return;
    }

    if (trackingMethod === "auto") {
      if (workflowStep !== "reticle" && workflowStep !== "tracking") return;
      if (!isSelectingColor) return;
      const video = videoRef.current;
      if (!video) return;
      const canvas = trackingCanvasRef.current ?? document.createElement("canvas");
      trackingCanvasRef.current = canvas;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        setError("此瀏覽器無法讀取影片畫格，無法選取顏色樣本。");
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sampleRadius = 3;
      const left = Math.max(0, point.pixelX - sampleRadius);
      const top = Math.max(0, point.pixelY - sampleRadius);
      const right = Math.min(canvas.width, point.pixelX + sampleRadius + 1);
      const bottom = Math.min(canvas.height, point.pixelY + sampleRadius + 1);
      const sample = makeColorSample(context.getImageData(left, top, right - left, bottom - top));
      setColorSample({ ...sample, ...point });
      setCrosshairCenter(clampCrosshairCenter(point));
      setIsSelectingColor(false);
      setAutoTrackingStatus("idle");
      setAutoSearchPoint({ ...point, radius: searchRadius });
      setError("");
      return;
    }

    if (workflowStep !== "tracking") return;
    // Tapping the video aligns the crosshair only. Recording remains an explicit
    // action so a touch gesture or scroll cannot accidentally add a data point.
    setCrosshairCenter(clampCrosshairCenter(point));
  };

  const stopAutoTracking = () => {
    autoTrackingRunRef.current += 1;
    videoRef.current?.pause();
    setAutoTrackingStatus("stopped");
    setAutoSearchPoint(null);
  };

  const updateDebugMaskOverlay = (imageData: ImageData, region: SearchRegion) => {
    if (!isDebugMode || !showBinaryMask || !colorSample) return;
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    const mask = buildHsvMask(imageData, colorSample, hsvTolerance);
    const output = context.createImageData(imageData.width, imageData.height);
    for (let index = 0; index < mask.length; index += 1) {
      if (!mask[index]) continue;
      const dataIndex = index * 4;
      output.data[dataIndex] = 16;
      output.data[dataIndex + 1] = 185;
      output.data[dataIndex + 2] = 129;
      output.data[dataIndex + 3] = 150;
    }
    context.putImageData(output, 0, 0);
    setDebugMaskOverlay({ dataUrl: canvas.toDataURL(), region });
  };

  const startAutoTracking = async (restart = false) => {
    const video = videoRef.current;
    if (!videoUrl || !video || !colorSample || isDemoMode) {
      setError(!colorSample ? "請先選取追蹤物體的顏色樣本。" : "請先載入影片後再使用自動追蹤。");
      return;
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      setError("影片尚未準備完成，請稍候再開始自動追蹤。");
      return;
    }

    video.pause();
    const runId = autoTrackingRunRef.current + 1;
    autoTrackingRunRef.current = runId;
    const fpsForRun = activeFps;
    const startFrame = Math.max(0, Math.floor(video.currentTime * fpsForRun + 0.000001));
    const finalFrame = Math.floor(Math.max(0, video.duration * fpsForRun - 0.000001));
    const canvas = trackingCanvasRef.current ?? document.createElement("canvas");
    trackingCanvasRef.current = canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      setError("此瀏覽器無法讀取影片畫格，無法開始自動追蹤。");
      return;
    }

    if (restart) {
      setTrackingPoints((previous) => previous.filter((point) => point.frame < startFrame || point.trackingMethod !== "auto"));
      setTrackingFailures((previous) => previous.filter((failure) => failure.frame < startFrame));
    }

    let previous = { x: crosshairCenter?.pixelX ?? colorSample.pixelX, y: crosshairCenter?.pixelY ?? colorSample.pixelY, area: undefined as number | undefined };
    const seed: TrackingPoint = {
      pixelX: Math.round(previous.x),
      pixelY: Math.round(previous.y),
      frame: startFrame,
      time: startFrame / fpsForRun,
      trackingMethod: "auto",
      trackingConfidence: 1,
    };
    setTrackingPoints((points) => {
      const existing = points.find((point) => point.frame === startFrame);
      if (existing?.trackingMethod === "manual") return points;
      return upsertTrackingPoint(points, seed);
    });
    setTrackingFailures((previousFailures) => previousFailures.filter((failure) => failure.frame !== startFrame));
    setAutoTrackingStatus("running");
    setAutoSearchPoint({ pixelX: previous.x, pixelY: previous.y, radius: searchRadius });
    setAutoTrackingDiagnostics({ frame: startFrame, candidateCount: 0, candidates: [], selected: null, expandedSearch: false });
    setDebugMaskOverlay(null);
    setError("");

    const seekToFrame = (frame: number) => new Promise<boolean>((resolve) => {
      const targetTime = Math.min(frame / fpsForRun, Math.max(0, video.duration - 0.000001));
      let settled = false;
      const finish = (success: boolean) => {
        if (settled) return;
        settled = true;
        video.removeEventListener("seeked", onSeeked);
        window.clearTimeout(timeout);
        resolve(success);
      };
      const onSeeked = () => finish(true);
      const timeout = window.setTimeout(() => finish(false), 2500);
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = targetTime;
    });

    for (let frame = startFrame + 1; frame <= finalFrame; frame += 1) {
      if (autoTrackingRunRef.current !== runId) return;
      const didSeek = await seekToFrame(frame);
      if (autoTrackingRunRef.current !== runId) return;
      if (!didSeek) {
        setAutoTrackingDiagnostics({ frame, candidateCount: 0, candidates: [], selected: null, expandedSearch: false, failureReason: "影片畫格讀取逾時" });
        setAutoTrackingStatus("failed");
        setError(`第 ${frame} frame 無法讀取，請手動指定物體位置後繼續。`);
        return;
      }

      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      let activeRegion = boundedSearchRegion(previous, searchRadius, canvas.width, canvas.height);
      setAutoSearchPoint({ pixelX: previous.x, pixelY: previous.y, radius: searchRadius });
      let activeImageData = context.getImageData(activeRegion.x, activeRegion.y, activeRegion.width, activeRegion.height);
      let blobs = detectColorBlobs(
        activeImageData,
        colorSample,
        hsvTolerance,
        { x: activeRegion.x, y: activeRegion.y },
      );
      let candidate = chooseBestBlob(blobs, colorSample, previous, searchRadius);
      let expandedSearch = false;

      if (!candidate) {
        expandedSearch = true;
        activeRegion = boundedSearchRegion(previous, searchRadius * 2, canvas.width, canvas.height);
        activeImageData = context.getImageData(activeRegion.x, activeRegion.y, activeRegion.width, activeRegion.height);
        blobs = detectColorBlobs(
          activeImageData,
          colorSample,
          hsvTolerance,
          { x: activeRegion.x, y: activeRegion.y },
        );
        candidate = chooseBestBlob(blobs, colorSample, previous, searchRadius * 2);
      }

      const displacement = candidate ? Math.hypot(candidate.centroidX - previous.x, candidate.centroidY - previous.y) : undefined;
      setAutoTrackingDiagnostics({
        frame,
        candidateCount: blobs.length,
        candidates: blobs,
        selected: candidate,
        displacement,
        expandedSearch,
        searchRegion: activeRegion,
        failureReason: !candidate ? "搜尋區域內沒有符合 HSV 範圍且面積足夠的 blob" : candidate.confidence < 0.2 ? "候選 blob 的信心值低於 0.20" : undefined,
      });
      updateDebugMaskOverlay(activeImageData, activeRegion);

      if (!candidate || candidate.confidence < 0.2) {
        const message = `第 ${frame} frame 無法可靠追蹤，請手動指定物體位置後繼續。`;
        setTrackingFailures((previousFailures) => [...previousFailures.filter((failure) => failure.frame !== frame), { frame, message }]);
        setAutoTrackingStatus("failed");
        setAutoSearchPoint({ pixelX: previous.x, pixelY: previous.y, radius: activeRegion.width / 2 });
        setError(message);
        video.pause();
        return;
      }

      previous = { x: candidate.centroidX, y: candidate.centroidY, area: candidate.area };
      const trackedPoint: TrackingPoint = {
        pixelX: Math.round(candidate.centroidX),
        pixelY: Math.round(candidate.centroidY),
        frame,
        time: frame / fpsForRun,
        trackingMethod: "auto",
        trackingConfidence: candidate.confidence,
      };
      setTrackingPoints((points) => {
        const existing = points.find((point) => point.frame === frame);
        if (existing?.trackingMethod === "manual") return points;
        return upsertTrackingPoint(points, trackedPoint);
      });
      setTrackingFailures((previousFailures) => previousFailures.filter((failure) => failure.frame !== frame));
      if (frame % 8 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    if (autoTrackingRunRef.current === runId) {
      setAutoTrackingStatus("completed");
      setAutoSearchPoint(null);
    }
  };

  const applyScaleCalibration = () => {
    const realLengthM = Number(scaleLengthInput);
    if (!scaleDraftA || !scaleDraftB || !Number.isFinite(realLengthM) || realLengthM <= 0 || draftPixelDistance <= 0) {
      setError("請輸入大於 0 的實際長度，再套用比例尺。");
      return;
    }

    setScaleCalibration({
      pointA: scaleDraftA,
      pointB: scaleDraftB,
      pixelDistance: draftPixelDistance,
      realLengthM,
      metersPerPixel: realLengthM / draftPixelDistance,
    });
    setScaleDraftA(null);
    setScaleDraftB(null);
    setMode("track");
    setError("");
  };

  const physicalCoordinate = (point: PixelPoint) => {
    if (!scaleCalibration || !origin) return null;
    return pixelToPhysicalCoordinate(point, origin, scaleCalibration.metersPerPixel, axisAngleDegrees);
  };

  const rawAnalysisPoints: AnalysisPoint[] = hasPhysicalCoordinates && scaleCalibration && origin
    ? sortedPoints.map((point) => ({
      ...point,
      time: analysisTimeFromFrame(point.frame, firstAnalysisFrame, activeFps),
      ...physicalCoordinate(point)!,
    }))
    : [];

  const positionPoints = rawAnalysisPoints.map((point, index, points) => {
    if (analysisMode === "raw" || index === 0 || index === points.length - 1) return point;
    return {
      ...point,
      x: (points[index - 1].x + point.x + points[index + 1].x) / 3,
      y: (points[index - 1].y + point.y + points[index + 1].y) / 3,
    };
  });

  const velocityPoints = positionPoints.map((point, index, points) => {
    if (points.length < 2) return point;
    const before = index === 0 ? points[0] : points[index - 1];
    const after = index === points.length - 1 ? points[index] : points[index + 1];
    const vx = difference(before.x, after.x, before.time, after.time);
    const vy = difference(before.y, after.y, before.time, after.time);
    return {
      ...point,
      vx,
      vy,
      speed: vx === undefined || vy === undefined ? undefined : Math.hypot(vx, vy),
    };
  });

  const analysisPoints = velocityPoints.map((point, index, points) => {
    if (points.length < 3) return point;
    const before = index === 0 ? points[0] : points[index - 1];
    const after = index === points.length - 1 ? points[index] : points[index + 1];
    const ax = before.vx === undefined || after.vx === undefined ? undefined : difference(before.vx, after.vx, before.time, after.time);
    const ay = before.vy === undefined || after.vy === undefined ? undefined : difference(before.vy, after.vy, before.time, after.time);
    return {
      ...point,
      ax,
      ay,
      acceleration: ax === undefined || ay === undefined ? undefined : Math.hypot(ax, ay),
    };
  });

  const chartOptions: Array<{ id: ChartMetric; label: string; axisLabel: string; color: string }> = [
    { id: "xy", label: "x-y", axisLabel: "位置 (m)", color: "#22d3ee" },
    { id: "x", label: "x vs t", axisLabel: "x (m)", color: "#22d3ee" },
    { id: "y", label: "y vs t", axisLabel: "y (m)", color: "#a78bfa" },
    { id: "vx", label: "vx vs t", axisLabel: "Vx (m/s)", color: "#38bdf8" },
    { id: "vy", label: "vy vs t", axisLabel: "Vy (m/s)", color: "#c084fc" },
    { id: "speed", label: "speed vs t", axisLabel: "Speed (m/s)", color: "#34d399" },
    { id: "ax", label: "ax vs t", axisLabel: "Ax (m/s²)", color: "#fbbf24" },
    { id: "ay", label: "ay vs t", axisLabel: "Ay (m/s²)", color: "#fb7185" },
  ];
  const selectedChart = chartOptions.find((option) => option.id === chartMetric) ?? chartOptions[0];
  const parsedFitStart = fitStartFrame.trim() === "" ? undefined : Number(fitStartFrame);
  const parsedFitEnd = fitEndFrame.trim() === "" ? undefined : Number(fitEndFrame);
  const fitRangeIsValid = (parsedFitStart === undefined || Number.isFinite(parsedFitStart))
    && (parsedFitEnd === undefined || Number.isFinite(parsedFitEnd))
    && !(parsedFitStart !== undefined && parsedFitEnd !== undefined && parsedFitStart > parsedFitEnd);
  const xyData = analysisPoints
    .map((point) => ({ frame: point.frame, time: point.time, x: point.x, y: point.y }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const isFrameInFitRange = (frame: number) => fitRangeIsValid
    && (parsedFitStart === undefined || frame >= parsedFitStart)
    && (parsedFitEnd === undefined || frame <= parsedFitEnd);
  const xyChartPoints: XyChartPoint[] = xyData.map((point) => ({ ...point, inFitRange: isFrameInFitRange(point.frame) }));
  const chartData: TimeChartPoint[] = chartMetric === "xy"
    ? xyChartPoints.map((point) => ({ frame: point.frame, time: point.x, value: point.y, inFitRange: point.inFitRange }))
    : analysisPoints
      .map((point) => ({ frame: point.frame, time: point.time, value: point[chartMetric], inFitRange: isFrameInFitRange(point.frame) }))
      .filter((point): point is TimeChartPoint => typeof point.value === "number" && Number.isFinite(point.value));
  const activeChartData: ChartPoint[] = chartMetric === "xy" ? xyChartPoints : chartData;
  const xyDomain = equalAxisScale && xyData.length > 0
    ? (() => {
      const values = xyData.flatMap((point) => [point.x, point.y]);
      const minimum = Math.min(...values);
      const maximum = Math.max(...values);
      const padding = Math.max((maximum - minimum) * 0.08, 0.1);
      return [minimum - padding, maximum + padding] as [number, number];
    })()
    : ["auto", "auto"] as ["auto", "auto"];
  const accelerationAverage = (chartMetric === "ax" || chartMetric === "ay") && chartData.length > 0
    ? chartData.reduce((sum, point) => sum + point.value, 0) / chartData.length
    : undefined;
  const fittingData = chartData.filter((point) => point.inFitRange);
  const fitInput = fittingData.map((point) => ({ t: point.time, value: point.value }));
  const fitResult: FitResult | null = fitModel === "none" || !fitRangeIsValid
    ? null
    : fitData(fitModel, fitInput);
  const fitError = fitModel === "none"
    ? null
    : !fitRangeIsValid
      ? "請輸入有效範圍，且起始 frame 不可大於結束 frame。"
      : fitResult && !fitResult.ok ? fitResult.error : null;
  const fitFrameRange = fittingData.length > 0 ? `Frame ${fittingData[0].frame}–${fittingData[fittingData.length - 1].frame}` : "—";
  const fitCurvePoints = (() => {
    // Array.from's mapper receives only the item and index. Use an explicit
    // sample count instead of a non-existent third `points` argument.
    if (!fittingData || fittingData.length < 2 || !fitResult || !fitResult.ok) return [];

    const startTime = fittingData[0]?.time;
    const endTime = fittingData[fittingData.length - 1]?.time;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return [];

    const sampleCount = Math.max(32, Math.min(160, fittingData.length * 16));
    return Array.from({ length: sampleCount }, (_, index) => {
      const time = sampleCount <= 1
        ? startTime
        : startTime + ((endTime - startTime) * index) / (sampleCount - 1);
      return { time, fit: fitResult.evaluate(time) };
    });
  })();
  const fitModelLabel: Record<FitModel, string> = { none: "不擬合", linear: "線性", quadratic: "二次", exponential: "指數", logarithmic: "對數", power: "冪次", inverse: "反比", sine: "正弦", cosine: "餘弦" };
  const fitVariable = chartMetric === "xy" ? "y" : chartMetric;
  const fitEquation = fitResult && fitResult.ok
    ? fitResult.equation.replace(/^y/, fitVariable).replaceAll("x", chartMetric === "xy" ? "x" : "t")
    : "—";
  const fitIndependentVariable = chartMetric === "xy" ? "x" : "t";
  const fitIndependentUnit = chartMetric === "xy" ? "m" : "s";
  const fitInputRange = fitInput.length > 0
    ? {
      minimum: Math.min(...fitInput.map((point) => point.t)),
      maximum: Math.max(...fitInput.map((point) => point.t)),
    }
    : null;

  const exportCsv = () => {
    if (!hasPhysicalCoordinates || analysisPoints.length === 0) return;
    const headers = ["frame", "time", "x", "y", "vx", "vy", "speed", "ax", "ay", "acceleration", "pixelX", "pixelY", "trackingMethod", "trackingConfidence"];
    const lines = analysisPoints.map((point) => [
      point.frame,
      point.time,
      point.x,
      point.y,
      point.vx ?? "",
      point.vy ?? "",
      point.speed ?? "",
      point.ax ?? "",
      point.ay ?? "",
      point.acceleration ?? "",
      point.pixelX,
      point.pixelY,
      point.trackingMethod ?? "manual",
      point.trackingConfidence ?? "",
    ].join(","));
    const blob = new Blob([`\uFEFF${headers.join(",")}\n${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "physics-video-analysis.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  const modeInstructions: Record<InteractionMode, string> = {
    track: trackingMethod === "auto"
      ? isSelectingColor ? "自動追蹤：點選物體取得 7×7 顏色樣本" : "自動追蹤：先選取追蹤物體，再開始追蹤"
      : "手動追蹤：點選物體位置",
    scale: !scaleDraftA ? "比例尺：先點選 A" : !scaleDraftB ? "比例尺：再點選 B" : "比例尺：輸入實際長度後套用",
    origin: "原點模式：點選 O 的位置",
  };
  const workflowCompletion = {
    video: Boolean(videoUrl || isDemoMode),
    reticle: Boolean(colorSample || trackingPoints.length > 0),
    tracking: trackingPoints.length > 0,
    calibration: Boolean(scaleCalibration && origin),
    analysis: analysisPoints.length > 0 && hasPhysicalCoordinates,
  };
  const workflowOrder: WorkflowStep[] = ["video", "reticle", "tracking", "calibration", "analysis"];
  const workflowIndex = workflowOrder.indexOf(workflowStep);
  const goToWorkflowStep = (step: WorkflowStep) => {
    if (step === "reticle" || step === "tracking") setActiveMode("track");
    setWorkflowStep(step);
  };

  return (
    <main className="min-h-screen bg-[#07111e] text-slate-100 selection:bg-cyan-300 selection:text-slate-950">
      <div className="mx-auto flex min-h-screen max-w-[1560px] flex-col px-5 py-6 sm:px-8 lg:px-12 lg:py-10">
        <header className="flex flex-col gap-6 border-b border-slate-700/80 pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-300"><span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_16px_3px_rgba(103,232,249,0.45)]" />Local video workspace</div>
            <div className="flex flex-wrap items-center gap-3"><h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">Physics Video Analysis</h1>{isDemoMode && <span className="inline-flex items-center gap-1.5 rounded-full border border-fuchsia-300/50 bg-fuchsia-300/15 px-3 py-1 text-xs font-bold text-fuchsia-100"><TestTube2 size={14} />DEMO / 測試模式</span>}</div>
          </div>
          <p className="max-w-md text-sm leading-6 text-slate-400 sm:text-right">影片、校正與追蹤資料只留在此瀏覽器工作階段，不會上傳到伺服器。</p>
        </header>

        <StepNavigation activeStep={workflowStep} completed={workflowCompletion} onSelect={goToWorkflowStep} />

        <section className="grid flex-1 gap-6 py-7 lg:grid-cols-[minmax(0,1fr)_380px] lg:py-9">
          {workflowStep !== "analysis" && <>
          <div className="flex min-w-0 flex-col gap-5">
            <div className="relative overflow-hidden rounded-2xl border border-slate-700 bg-[#0c1b2c] shadow-2xl shadow-black/25">
              {videoUrl ? (
                <div className="relative aspect-video w-full bg-black">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    className="h-full w-full object-contain"
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={(event) => {
                      setDuration(event.currentTarget.duration);
                      setCurrentTime(event.currentTarget.currentTime);
                      setVideoDimensions({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight });
                      setCrosshairCenter({ pixelX: Math.round(event.currentTarget.videoWidth / 2), pixelY: Math.round(event.currentTarget.videoHeight / 2) });
                      requestAnimationFrame(updateContentBounds);
                    }}
                    onTimeUpdate={(event) => {
                      const actualTime = event.currentTarget.currentTime;
                      setCurrentTime(actualTime);
                      if (!isScrubbing && !event.currentTarget.seeking) setScrubTime(actualTime);
                    }}
                    onSeeking={() => setIsSeeking(true)}
                    onSeeked={(event) => syncTimeFromVideo(event.currentTarget)}
                    onCanPlay={() => setError((currentError) => currentError === "此影片格式或編碼目前無法由瀏覽器解碼，建議使用 MP4（H.264）。" ? "" : currentError)}
                    onError={() => {
                      setIsPlaying(false);
                      setIsSeeking(false);
                      setError("此影片格式或編碼目前無法由瀏覽器解碼，建議使用 MP4（H.264）。");
                    }}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                  />
                  {contentBounds && videoWidth > 0 && videoHeight > 0 && (
                    <div
                      ref={overlayRef}
                      aria-label={isPlaying ? "影片播放中，暫停後才能操作" : modeInstructions[mode]}
                      className={`absolute z-10 touch-none ${isPlaying ? "pointer-events-none" : "cursor-crosshair"}`}
                      style={{ left: contentBounds.left, top: contentBounds.top, width: contentBounds.width, height: contentBounds.height }}
                      onPointerDown={handleOverlayPointerDown}
                    >
                      {workflowStep === "tracking" && isDebugMode && showBinaryMask && debugMaskOverlay && <span aria-hidden="true" className="pointer-events-none absolute" style={{ left: `${(debugMaskOverlay.region.x / videoWidth) * 100}%`, top: `${(debugMaskOverlay.region.y / videoHeight) * 100}%`, width: `${(debugMaskOverlay.region.width / videoWidth) * 100}%`, height: `${(debugMaskOverlay.region.height / videoHeight) * 100}%`, backgroundImage: `url(${debugMaskOverlay.dataUrl})`, backgroundSize: "100% 100%", imageRendering: "pixelated" }} />}
                      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${videoWidth} ${videoHeight}`} preserveAspectRatio="none" aria-hidden="true">
                        <defs><marker id="axis-arrow" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#fbbf24" /></marker></defs>
                        {origin && workflowStep === "calibration" && <>
                          <line x1={origin.pixelX - axisCosine * Math.hypot(videoWidth, videoHeight) * 2} y1={origin.pixelY + axisSine * Math.hypot(videoWidth, videoHeight) * 2} x2={origin.pixelX + axisCosine * Math.hypot(videoWidth, videoHeight) * 2} y2={origin.pixelY - axisSine * Math.hypot(videoWidth, videoHeight) * 2} stroke="#fbbf24" strokeWidth="3" strokeDasharray="10 7" markerEnd="url(#axis-arrow)" />
                          <line x1={origin.pixelX + axisSine * Math.hypot(videoWidth, videoHeight) * 2} y1={origin.pixelY + axisCosine * Math.hypot(videoWidth, videoHeight) * 2} x2={origin.pixelX - axisSine * Math.hypot(videoWidth, videoHeight) * 2} y2={origin.pixelY - axisCosine * Math.hypot(videoWidth, videoHeight) * 2} stroke="#fbbf24" strokeWidth="3" strokeDasharray="10 7" markerEnd="url(#axis-arrow)" />
                          <circle cx={origin.pixelX} cy={origin.pixelY} r="13" fill="#0f172a" stroke="#fbbf24" strokeWidth="3" />
                          <text x={origin.pixelX + 18} y={origin.pixelY - 14} fill="#fef3c7" fontSize="30" fontWeight="700">O</text>
                          <text x={origin.pixelX + axisCosine * 54} y={origin.pixelY - axisSine * 54} fill="#fef3c7" fontSize="26" fontWeight="700">x</text>
                          <text x={origin.pixelX - axisSine * 54} y={origin.pixelY - axisCosine * 54} fill="#fef3c7" fontSize="26" fontWeight="700">y</text>
                          {axisHandle && <><circle cx={axisHandle.pixelX} cy={axisHandle.pixelY} r="15" fill="#0f172a" stroke="#fbbf24" strokeWidth="4" /><path d={`M ${axisHandle.pixelX - 6} ${axisHandle.pixelY} A 7 7 0 1 1 ${axisHandle.pixelX + 4} ${axisHandle.pixelY - 5}`} fill="none" stroke="#fef3c7" strokeWidth="2.5" /></>}
                        </>}
                        {scaleLine && workflowStep === "calibration" && <>
                          {scaleLine.pointB && <line x1={scaleLine.pointA.pixelX} y1={scaleLine.pointA.pixelY} x2={scaleLine.pointB.pixelX} y2={scaleLine.pointB.pixelY} stroke="#e879f9" strokeWidth="5" />}
                          <circle cx={scaleLine.pointA.pixelX} cy={scaleLine.pointA.pixelY} r="11" fill="#fdf4ff" stroke="#e879f9" strokeWidth="4" />
                          <text x={scaleLine.pointA.pixelX + 14} y={scaleLine.pointA.pixelY - 14} fill="#fdf4ff" fontSize="27" fontWeight="700">A</text>
                          {scaleLine.pointB && <><circle cx={scaleLine.pointB.pixelX} cy={scaleLine.pointB.pixelY} r="11" fill="#fdf4ff" stroke="#e879f9" strokeWidth="4" /><text x={scaleLine.pointB.pixelX + 14} y={scaleLine.pointB.pixelY - 14} fill="#fdf4ff" fontSize="27" fontWeight="700">B</text></>}
                        </>}
                        {workflowStep === "tracking" && isDebugMode && showCandidateBlobs && autoTrackingDiagnostics?.candidates.map((blob, index) => <rect key={`${blob.minX}-${blob.minY}-${index}`} x={blob.minX} y={blob.minY} width={blob.maxX - blob.minX + 1} height={blob.maxY - blob.minY + 1} fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeDasharray="5 4" />)}
                        {workflowStep === "tracking" && isDebugMode && autoTrackingDiagnostics?.selected && <rect x={autoTrackingDiagnostics.selected.minX} y={autoTrackingDiagnostics.selected.minY} width={autoTrackingDiagnostics.selected.maxX - autoTrackingDiagnostics.selected.minX + 1} height={autoTrackingDiagnostics.selected.maxY - autoTrackingDiagnostics.selected.minY + 1} fill="none" stroke="#fef08a" strokeWidth="5" />}
                        {workflowStep === "tracking" && showSearchArea && autoSearchPoint && <rect x={autoSearchPoint.pixelX - autoSearchPoint.radius} y={autoSearchPoint.pixelY - autoSearchPoint.radius} width={autoSearchPoint.radius * 2} height={autoSearchPoint.radius * 2} fill="none" stroke="#34d399" strokeWidth="3" strokeDasharray="9 6" />}
                        {crosshairPreviewPoint && (() => { const arm = trackingReticleRadius + Math.max(5, trackingReticleRadius * 0.38); return <g aria-label={`準星預覽，大小 ${trackingReticleRadius} 像素`}><circle cx={crosshairPreviewPoint.pixelX} cy={crosshairPreviewPoint.pixelY} r={trackingReticleRadius} fill="rgba(7,17,30,0.28)" stroke="#fbbf24" strokeWidth="3.5" /><line x1={crosshairPreviewPoint.pixelX - arm} y1={crosshairPreviewPoint.pixelY} x2={crosshairPreviewPoint.pixelX + arm} y2={crosshairPreviewPoint.pixelY} stroke="#fbbf24" strokeWidth="3" /><line x1={crosshairPreviewPoint.pixelX} y1={crosshairPreviewPoint.pixelY - arm} x2={crosshairPreviewPoint.pixelX} y2={crosshairPreviewPoint.pixelY + arm} stroke="#fbbf24" strokeWidth="3" /><circle cx={crosshairPreviewPoint.pixelX} cy={crosshairPreviewPoint.pixelY} r="3.5" fill="#fbbf24" /></g>; })()}
                        {workflowStep === "tracking" && colorSample && <><circle cx={colorSample.pixelX} cy={colorSample.pixelY} r="15" fill="none" stroke={`rgb(${colorSample.rgb.r}, ${colorSample.rgb.g}, ${colorSample.rgb.b})`} strokeWidth="5" /><text x={colorSample.pixelX + 19} y={colorSample.pixelY + 7} fill="#ffffff" fontSize="22" fontWeight="700">S</text></>}
                        {(workflowStep === "tracking" || workflowStep === "calibration") && showTrackingTrail && <g aria-label={`已顯示 ${sortedPoints.length} 個追蹤點`}>
                          {showTrajectoryLines && sortedPoints.slice(1).map((point, index) => {
                            const previous = sortedPoints[index];
                            if (point.frame - previous.frame > maximumTrajectoryFrameGap) return null;
                            return <line key={`${previous.frame}-${point.frame}`} x1={previous.pixelX} y1={previous.pixelY} x2={point.pixelX} y2={point.pixelY} stroke="#67e8f9" strokeWidth="2.5" strokeLinecap="round" opacity="0.8" />;
                          })}
                          {sortedPoints.map((point, index) => {
                            const isLatest = index === sortedPoints.length - 1;
                            const isLowConfidence = point.trackingMethod === "auto" && (point.trackingConfidence ?? 1) < 0.55;
                            const fill = isLowConfidence ? "#fbbf24" : point.trackingMethod === "auto" ? "#34d399" : "#22d3ee";
                            return <g key={point.frame} aria-label={point.trackingMethod === "auto" ? `自動追蹤點，信心 ${(point.trackingConfidence ?? 0).toFixed(2)}` : "手動追蹤點"}><circle cx={point.pixelX} cy={point.pixelY} r={isLatest ? 8 : 6} fill={fill} stroke="#f8fafc" strokeWidth={isLatest ? 2.5 : 1.5} vectorEffect="non-scaling-stroke" /><circle cx={point.pixelX} cy={point.pixelY} r={isLatest ? 2.5 : 1.5} fill="#0f172a" /></g>;
                          })}
                        </g>}
                      </svg>
                      {crosshairPreviewPoint && <button type="button" aria-label="拖曳以移動準星中心" title="拖曳準星中心" onPointerDown={beginCrosshairDrag} onPointerMove={moveCrosshairDrag} onPointerUp={endCrosshairDrag} onPointerCancel={endCrosshairDrag} className={`absolute z-20 h-12 w-12 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full border-2 border-transparent transition ${isDraggingCrosshair ? "cursor-grabbing border-cyan-100/80 bg-cyan-300/15" : "cursor-grab hover:border-cyan-100/65 hover:bg-cyan-300/10"}`} style={{ left: `${(crosshairPreviewPoint.pixelX / videoWidth) * 100}%`, top: `${(crosshairPreviewPoint.pixelY / videoHeight) * 100}%` }}><span className="sr-only">準星中心 X {crosshairPreviewPoint.pixelX}，Y {crosshairPreviewPoint.pixelY}</span></button>}
                      {workflowStep === "calibration" && origin && mode === "track" && !isSelectingColor && autoTrackingStatus !== "running" && <button type="button" aria-label="拖曳以移動座標原點" title="拖曳 O 移動座標原點" onPointerDown={beginOriginDrag} onPointerMove={moveOriginDrag} onPointerUp={endOriginDrag} onPointerCancel={endOriginDrag} className={`absolute z-20 flex h-9 w-9 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full border-2 border-amber-100 bg-slate-950/85 text-sm font-black text-amber-100 shadow-[0_0_0_3px_rgba(15,23,42,0.55)] transition ${isDraggingOrigin ? "cursor-grabbing scale-110" : "cursor-grab hover:bg-amber-300 hover:text-slate-950"}`} style={{ left: `${(origin.pixelX / videoWidth) * 100}%`, top: `${(origin.pixelY / videoHeight) * 100}%` }}>O</button>}
                      {workflowStep === "calibration" && axisHandle && mode === "track" && !isSelectingColor && autoTrackingStatus !== "running" && <button type="button" aria-label="拖曳以旋轉座標軸" title="拖曳旋轉座標軸" onPointerDown={beginAxisDrag} onPointerMove={moveAxisDrag} onPointerUp={endAxisDrag} onPointerCancel={endAxisDrag} className={`absolute z-20 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full border-2 border-amber-100 bg-slate-950/85 text-amber-100 shadow-[0_0_0_3px_rgba(15,23,42,0.55)] transition ${isDraggingAxis ? "cursor-grabbing scale-110 bg-amber-300 text-slate-950" : "cursor-grab hover:scale-110 hover:bg-amber-300 hover:text-slate-950"}`} style={{ left: `${(axisHandle.pixelX / videoWidth) * 100}%`, top: `${(axisHandle.pixelY / videoHeight) * 100}%` }}><RotateCcw size={19} strokeWidth={2.5} /><span className="sr-only">目前角度 {axisAngleDegrees} 度</span></button>}
                      {workflowStep === "calibration" && isDraggingAxis && axisHandle && <div className="pointer-events-none absolute z-30 -translate-x-1/2 translate-y-4 rounded-md border border-amber-100/50 bg-slate-950/90 px-2 py-1 font-mono text-xs font-bold text-amber-100 shadow-lg" style={{ left: `${(axisHandle.pixelX / videoWidth) * 100}%`, top: `${(axisHandle.pixelY / videoHeight) * 100}%` }}>θ = {axisAngleDegrees.toFixed(1)}°</div>}
                    </div>
                  )}
                  {!isPlaying && contentBounds && <div className={`pointer-events-none absolute bottom-4 left-4 z-20 inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium backdrop-blur-sm ${mode === "scale" ? "border-fuchsia-300/30 bg-fuchsia-950/70 text-fuchsia-100" : mode === "origin" ? "border-amber-300/30 bg-amber-950/70 text-amber-100" : trackingMethod === "auto" ? "border-emerald-300/30 bg-emerald-950/70 text-emerald-100" : "border-cyan-300/20 bg-slate-950/70 text-cyan-100"}`}><Crosshair size={14} />{modeInstructions[mode]}</div>}
                </div>
              ) : isDemoMode ? (
                <div className="flex aspect-video flex-col items-center justify-center gap-5 bg-[radial-gradient(circle_at_50%_42%,#3b1a5d_0%,#171127_45%,#09121f_100%)] p-6 text-center">
                  <span className="inline-flex items-center gap-2 rounded-full border border-fuchsia-300/50 bg-fuchsia-300/15 px-3 py-1.5 text-xs font-bold tracking-wide text-fuchsia-100"><TestTube2 size={15} />DEMO / 測試模式 · 模擬資料</span>
                  <div><h2 className="text-2xl font-semibold text-white">模擬拋體資料</h2><p className="mt-2 text-sm text-slate-300">此畫面沒有載入影片；下方分析使用 30 筆合成量測資料。</p></div>
                  <div className="grid gap-2 rounded-xl border border-fuchsia-300/20 bg-slate-950/40 px-5 py-4 font-mono text-sm text-fuchsia-100 sm:grid-cols-2"><span>x(t) = 2.0t + 0.5</span><span>y(t) = 1.2 + 3.0t − 4.9t²</span></div>
                  <p className="max-w-lg text-xs leading-5 text-slate-400">資料帶有極小且可重現的量測誤差，僅供開發與教學測試，不能視為實驗測量。</p>
                </div>
              ) : (
                <label className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_50%_40%,#133252_0%,#0c1b2c_43%,#081521_100%)] p-6 text-center transition hover:bg-[#10243a]">
                  <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/30 bg-cyan-300/10 text-cyan-200"><FileVideo size={30} strokeWidth={1.6} /></span>
                  <span><span className="block text-lg font-medium text-slate-100">選擇一支影片</span><span className="mt-1.5 block text-sm text-slate-400">支援 MP4、MOV 與瀏覽器可播放的影片</span></span>
                  <span className="rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950">載入本機影片</span>
                  <input className="sr-only" type="file" accept="video/*,.mp4,.mov" onChange={handleFileChange} />
                </label>
              )}
            </div>

            {videoUrl && <div className="grid min-w-0 gap-2 rounded-xl border border-slate-700 bg-slate-950/35 px-3.5 py-3 text-xs sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center sm:gap-4">
              <div className="min-w-0"><span className="mr-2 font-semibold text-slate-400">檔名</span><span title={fileName} className="inline-block max-w-[calc(100%-3rem)] truncate align-bottom font-medium text-slate-200">{fileName || "未命名影片"}</span></div>
              <span className="font-mono text-slate-300">{videoDimensions ? `${videoDimensions.width} × ${videoDimensions.height}` : "—"}</span>
              <span className="font-mono text-slate-300">{formatTime(duration)}</span>
              <span className="font-mono text-cyan-100">{activeFps} fps</span>
            </div>}

            {(workflowStep === "video" || workflowStep === "reticle" || workflowStep === "tracking") && <div className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-4 shadow-lg shadow-black/10 sm:p-5">
              <div className="flex flex-wrap items-center gap-2.5">
                <button type="button" onClick={togglePlayback} disabled={!canControl} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-cyan-300 px-4 text-sm font-bold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40">{isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}{isPlaying ? "暫停" : "播放"}</button>
                <button type="button" onClick={() => seekOneFrame(-1)} disabled={!canControl} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 text-sm font-semibold text-slate-100 transition hover:border-slate-400 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={19} />上一格</button>
                <button type="button" onClick={() => seekOneFrame(1)} disabled={!canControl} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-600 bg-slate-800 px-4 text-sm font-semibold text-slate-100 transition hover:border-slate-400 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">下一格<ChevronRight size={19} /></button>
                <button type="button" onClick={reset} disabled={!canControl} aria-label="回到影片開頭" className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-3 text-slate-300 transition hover:border-slate-500 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw size={18} /></button>
              </div>
              <div className="mt-5 rounded-xl border border-slate-700 bg-slate-950/30 px-3.5 py-3">
                <div className="mb-2 flex items-center justify-between gap-3 text-xs"><label htmlFor="video-timeline" className="font-semibold text-slate-200">影片時間軸</label><span className="font-mono text-cyan-100">{formatTime(timelineTime)} <span className="text-slate-500">/</span> {formatTime(duration)} · Frame {frameFromTime(timelineTime, activeFps)}{isSeeking && <span className="ml-2 font-sans text-amber-200">定位中…</span>}</span></div>
                <input id="video-timeline" type="range" min="0" max={Number.isFinite(duration) ? duration : 0} step={1 / activeFps} value={Math.min(timelineSliderTime, Number.isFinite(duration) ? duration : 0)} disabled={!canControl || !Number.isFinite(duration) || duration <= 0 || autoTrackingStatus === "running"} onPointerDown={beginTimelineScrub} onPointerUp={endTimelineScrub} onPointerCancel={endTimelineScrub} onBlur={endTimelineScrub} onChange={(event) => seekTimeline(Number(event.target.value))} className="block w-full cursor-pointer accent-cyan-300 disabled:cursor-not-allowed disabled:opacity-40" />
                <p className="mt-1.5 text-xs text-slate-500">拖曳圓點可直接跳到任意時間；定位會依目前 {activeFps} fps 對齊影格。</p>
              </div>
              {workflowStep === "reticle" && <div className="mt-3 rounded-xl border border-cyan-300/20 bg-cyan-300/5 px-3.5 py-3">
                <div className="flex items-center justify-between gap-3"><label htmlFor="reticle-radius" className="text-sm font-semibold text-cyan-100">追蹤準星大小</label><output htmlFor="reticle-radius" className="font-mono text-sm font-bold text-cyan-100">{trackingReticleRadius} px</output></div>
                <input id="reticle-radius" type="range" min="10" max="200" step="1" value={trackingReticleRadius} disabled={!canControl} onChange={(event) => { const nextRadius = Number(event.target.value); const nextExtent = nextRadius + Math.max(5, nextRadius * 0.38); setTrackingReticleRadius(nextRadius); setCrosshairCenter((center) => center ? clampCrosshairCenter(center, nextExtent) : center); }} className="mt-3 block h-6 w-full cursor-pointer accent-cyan-300 disabled:cursor-not-allowed disabled:opacity-40" />
                <p className="mt-1.5 text-xs text-slate-500">拖曳滑桿可即時貼合物體大小；直接拖曳影片中的準星中心可調整目標位置。</p>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="rounded-md border border-dashed border-cyan-300/30 bg-slate-950/35 px-2.5 py-1.5 font-mono text-xs text-cyan-100" aria-live="polite">crosshairSize = {trackingReticleRadius}</p><button type="button" disabled={!canControl || !videoWidth || !videoHeight} onClick={() => setCrosshairCenter({ pixelX: Math.round(videoWidth / 2), pixelY: Math.round(videoHeight / 2) })} className="inline-flex min-h-8 items-center rounded-lg border border-cyan-300/40 px-2.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40">置中</button></div>
                <p className="mt-2 font-mono text-xs text-slate-300">X: {crosshairPreviewPoint?.pixelX ?? "—"} px　Y: {crosshairPreviewPoint?.pixelY ?? "—"} px</p>
              </div>}
              {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
            </div>}
          </div>

          <aside className="flex min-w-0 flex-col gap-5">
            {workflowStep === "video" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><FolderOpen size={18} className="text-cyan-300" />影片來源</div>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-600 px-4 py-3 text-sm font-semibold text-cyan-200 transition hover:border-cyan-300/80 hover:bg-cyan-300/5"><FolderOpen size={17} />選擇本機影片<input className="sr-only" type="file" accept="video/*,.mp4,.mov" onChange={handleFileChange} /></label>
              <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={loadDemoData} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-fuchsia-300/45 px-3 text-xs font-semibold text-fuchsia-100 transition hover:bg-fuchsia-300/10"><TestTube2 size={15} />載入 Demo 資料</button>{isDemoMode && <button type="button" onClick={clearDemoData} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-rose-300/45 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-300/10"><Trash2 size={15} />清除 Demo</button>}</div>
              <p className={`mt-3 break-all text-xs leading-5 ${isDemoMode ? "font-semibold text-fuchsia-200" : "text-slate-400"}`}>{fileName || "尚未載入影片"}</p>
            </section>}

            {(workflowStep === "reticle" || workflowStep === "tracking") && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-100"><MoveRight size={18} className="text-cyan-300" />操作模式</div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" disabled={!canControl} onClick={() => setTrackingWorkflow("manual")} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${trackingMethod === "manual" && mode === "track" ? "border-cyan-300 bg-cyan-300/15 text-cyan-100" : "border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-500"}`}><Crosshair size={17} />手動追蹤</button>
                <button type="button" disabled={!canControl || isDemoMode} onClick={() => setTrackingWorkflow("auto")} className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${trackingMethod === "auto" && mode === "track" ? "border-emerald-300 bg-emerald-300/15 text-emerald-100" : "border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-500"}`}><Crosshair size={17} />自動追蹤</button>
              </div>
              {workflowStep === "tracking" && <div className="mt-2 grid grid-cols-2 gap-2">
                {([ ["scale", "比例尺", Ruler], ["origin", "原點", MapPin] ] as const).map(([value, label, Icon]) => <button key={value} type="button" disabled={!canControl} onClick={() => setActiveMode(value)} className={`flex min-h-12 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${mode === value ? value === "scale" ? "border-fuchsia-300 bg-fuchsia-300/15 text-fuchsia-100" : "border-amber-300 bg-amber-300/15 text-amber-100" : "border-slate-700 bg-slate-900/50 text-slate-300 hover:border-slate-500"}`}><Icon size={16} />{label}</button>)}
              </div>}
              <p className="mt-3 text-xs leading-5 text-slate-400">手動與自動追蹤只能擇一；比例尺與原點設定不會新增追蹤點。</p>
            </section>}

            {(workflowStep === "reticle" || workflowStep === "tracking") && <section className="rounded-2xl border border-emerald-300/25 bg-[#0c1b2c] p-5">
              <div className="mb-2 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Crosshair size={18} className="text-emerald-300" />顏色自動追蹤</div><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${autoTrackingStatus === "running" ? "bg-emerald-300/15 text-emerald-100" : autoTrackingStatus === "failed" ? "bg-rose-300/15 text-rose-100" : "bg-slate-800 text-slate-300"}`}>{autoTrackingStatus === "running" ? "追蹤中" : autoTrackingStatus === "completed" ? "完成" : autoTrackingStatus === "failed" ? "需手動修正" : "待命"}</span></div>
              <p className="text-xs leading-5 text-slate-400">使用 HSV 色彩範圍與連通元件找出物體中心。僅在影片暫停時可選取樣本；Demo 模式不啟用影片自動追蹤。</p>

              <div className="mt-4 grid grid-cols-3 gap-2">{([ ["strict", "較嚴格"], ["standard", "標準"], ["loose", "較寬鬆"] ] as const).map(([preset, label]) => <button key={preset} type="button" disabled={!canControl || isDemoMode} onClick={() => { setAutoPreset(preset); setHsvTolerance(TRACKING_PRESETS[preset]); }} className={`rounded-lg px-2 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${autoPreset === preset ? "bg-emerald-300 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>{label}</button>)}</div>

              <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950/35 p-3">
                {colorSample ? <div className="flex items-center gap-3"><span aria-hidden="true" className="h-9 w-9 rounded-lg border border-white/30 shadow-inner" style={{ backgroundColor: `rgb(${colorSample.rgb.r}, ${colorSample.rgb.g}, ${colorSample.rgb.b})` }} /><div className="min-w-0"><p className="text-xs font-semibold text-emerald-100">已選取顏色樣本 S</p><p className="mt-0.5 truncate font-mono text-xs text-slate-400">RGB({colorSample.rgb.r}, {colorSample.rgb.g}, {colorSample.rgb.b}) · H {colorSample.hsv.h.toFixed(0)}°</p></div></div> : <p className="text-xs leading-5 text-amber-100">尚未選取樣本。請先切換至自動追蹤，再在暫停的影片上點選物體。</p>}
                <button type="button" disabled={!canControl || isDemoMode || isPlaying || autoTrackingStatus === "running"} onClick={() => { setTrackingMethod("auto"); setMode("track"); setIsSelectingColor(true); setError(""); }} className={`mt-3 inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${isSelectingColor ? "border-emerald-300 bg-emerald-300/15 text-emerald-100" : "border-emerald-300/45 text-emerald-100 hover:bg-emerald-300/10"}`}><Crosshair size={15} />{isSelectingColor ? "請在影片上點選物體" : "選取追蹤物體"}</button>
              </div>

              {workflowStep === "tracking" && <><div className="mt-3 grid grid-cols-2 gap-2"><button type="button" disabled={!canControl || isDemoMode || !colorSample || autoTrackingStatus === "running"} onClick={() => startAutoTracking(false)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg bg-emerald-300 px-3 text-xs font-bold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40"><Play size={15} fill="currentColor" />{autoTrackingStatus === "failed" ? "從目前格繼續" : "開始自動追蹤"}</button><button type="button" disabled={autoTrackingStatus !== "running"} onClick={stopAutoTracking} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-rose-300/45 px-3 text-xs font-semibold text-rose-100 transition hover:bg-rose-300/10 disabled:cursor-not-allowed disabled:opacity-40"><Pause size={15} />停止</button></div>
              <button type="button" disabled={!canControl || isDemoMode || !colorSample || autoTrackingStatus === "running"} onClick={() => startAutoTracking(true)} className="mt-2 inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-slate-600 px-3 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"><RotateCcw size={15} />從目前格重新追蹤</button></>}

              <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3"><label className="text-xs font-semibold text-slate-300">搜尋半徑<input type="number" min="10" max="1000" step="1" value={searchRadius} onChange={(event) => setSearchRadius(Math.min(1000, Math.max(10, Number(event.target.value) || 10)))} disabled={!canControl || isDemoMode} className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-white outline-none focus:border-emerald-300 disabled:opacity-40" /></label><button type="button" disabled={!canControl || isDemoMode} onClick={() => setShowSearchArea((visible) => !visible)} className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-600 px-3 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40">{showSearchArea ? <EyeOff size={15} /> : <Eye size={15} />}{showSearchArea ? "隱藏區域" : "顯示區域"}</button></div>
              <p className="mt-1 text-xs text-slate-500">px · 追蹤失敗時會自動擴大為兩倍範圍再搜尋一次。</p>

              <details className="mt-4 rounded-lg border border-slate-700 px-3 py-2"><summary className="cursor-pointer text-xs font-semibold text-slate-300">進階 HSV 容許範圍</summary><div className="mt-3 grid grid-cols-3 gap-2"><label className="text-xs text-slate-400">Hue °<input type="number" min="0" max="180" value={hsvTolerance.hue} disabled={!canControl || isDemoMode} onChange={(event) => { setAutoPreset("standard"); setHsvTolerance((value) => ({ ...value, hue: Math.max(0, Math.min(180, Number(event.target.value) || 0)) })); }} className="mt-1 block w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40" /></label><label className="text-xs text-slate-400">Saturation<input type="number" min="0" max="1" step="0.01" value={hsvTolerance.saturation} disabled={!canControl || isDemoMode} onChange={(event) => { setAutoPreset("standard"); setHsvTolerance((value) => ({ ...value, saturation: Math.max(0, Math.min(1, Number(event.target.value) || 0)) })); }} className="mt-1 block w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40" /></label><label className="text-xs text-slate-400">Value<input type="number" min="0" max="1" step="0.01" value={hsvTolerance.value} disabled={!canControl || isDemoMode} onChange={(event) => { setAutoPreset("standard"); setHsvTolerance((value) => ({ ...value, value: Math.max(0, Math.min(1, Number(event.target.value) || 0)) })); }} className="mt-1 block w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 font-mono text-sm text-white disabled:opacity-40" /></label></div></details>
              {workflowStep === "tracking" && <details className={`mt-4 rounded-xl border p-3 ${isDebugMode ? "border-violet-300/45 bg-violet-300/5" : "border-slate-700 bg-slate-950/20"}`}>
                <summary className="cursor-pointer text-xs font-bold text-slate-100">進階：Debug / 診斷模式</summary>
                <div className="flex items-center justify-between gap-3"><div><p className="text-xs font-bold text-slate-100">Debug / 診斷模式</p><p className="mt-0.5 text-[11px] leading-4 text-slate-500">顯示候選、信心與搜尋細節，不會改變追蹤結果。</p></div><button type="button" onClick={() => setIsDebugMode((enabled) => !enabled)} className={`rounded-lg px-3 py-2 text-xs font-bold transition ${isDebugMode ? "bg-violet-300 text-slate-950" : "border border-slate-600 text-slate-300 hover:bg-slate-800"}`}>{isDebugMode ? "已開啟" : "開啟"}</button></div>
                {isDebugMode && <>
                  <div className="mt-3 grid grid-cols-2 gap-2"><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-2 text-xs font-semibold text-slate-200"><input type="checkbox" checked={showBinaryMask} onChange={(event) => setShowBinaryMask(event.target.checked)} className="accent-violet-300" />顯示 binary mask</label><label className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-2 text-xs font-semibold text-slate-200"><input type="checkbox" checked={showCandidateBlobs} onChange={(event) => setShowCandidateBlobs(event.target.checked)} className="accent-violet-300" />顯示候選外框</label></div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-violet-300/20 bg-slate-950/35 p-3 text-[11px] leading-4"><div><dt className="text-slate-500">目前 frame</dt><dd className="font-mono font-semibold text-white">{autoTrackingDiagnostics?.frame ?? currentFrame}</dd></div><div><dt className="text-slate-500">目標 HSV</dt><dd className="font-mono font-semibold text-white">{colorSample ? `${colorSample.hsv.h.toFixed(1)}°, ${colorSample.hsv.s.toFixed(3)}, ${colorSample.hsv.v.toFixed(3)}` : "—"}</dd></div><div><dt className="text-slate-500">HSV tolerance</dt><dd className="font-mono text-slate-200">H ±{hsvTolerance.hue}° · S/V ±{hsvTolerance.saturation.toFixed(2)}/{hsvTolerance.value.toFixed(2)}</dd></div><div><dt className="text-slate-500">搜尋半徑</dt><dd className="font-mono text-slate-200">{searchRadius} px</dd></div><div><dt className="text-slate-500">候選 blob</dt><dd className="font-mono text-slate-200">{autoTrackingDiagnostics?.candidateCount ?? "—"}</dd></div><div><dt className="text-slate-500">曾擴大搜尋</dt><dd className="font-mono text-slate-200">{autoTrackingDiagnostics ? autoTrackingDiagnostics.expandedSearch ? "是（×2）" : "否" : "—"}</dd></div><div><dt className="text-slate-500">最終 blob 面積</dt><dd className="font-mono text-slate-200">{autoTrackingDiagnostics?.selected?.area ?? "—"} px²</dd></div><div><dt className="text-slate-500">blob centroid</dt><dd className="font-mono text-slate-200">{autoTrackingDiagnostics?.selected ? `(${autoTrackingDiagnostics.selected.centroidX.toFixed(1)}, ${autoTrackingDiagnostics.selected.centroidY.toFixed(1)})` : "—"}</dd></div><div><dt className="text-slate-500">與前格位移</dt><dd className="font-mono text-slate-200">{autoTrackingDiagnostics?.displacement?.toFixed(2) ?? "—"} px</dd></div><div><dt className="text-slate-500">trackingConfidence</dt><dd className="font-mono font-semibold text-emerald-100">{autoTrackingDiagnostics?.selected?.confidence?.toFixed(3) ?? "—"}</dd></div></dl>
                  {autoTrackingDiagnostics?.failureReason && <p className="mt-3 rounded-lg border border-rose-300/30 bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-100">失敗原因：{autoTrackingDiagnostics.failureReason}</p>}
                </>}
              </details>}
              {trackingFailures.length > 0 && <p className="mt-3 rounded-lg border border-rose-300/30 bg-rose-300/5 px-3 py-2 text-xs leading-5 text-rose-100">追蹤失敗：Frame {trackingFailures[trackingFailures.length - 1].frame}。切換手動追蹤、點選物體修正後，可從該 frame 繼續。</p>}
            </section>}

            {workflowStep === "video" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <label htmlFor="fps" className="mb-2 block text-sm font-semibold text-slate-100">影片 FPS</label>
              <div className="relative"><input id="fps" type="number" min="0.001" step="1" inputMode="decimal" value={fpsInput} onChange={(event) => setFpsInput(event.target.value)} onBlur={commitFps} onKeyDown={(event) => event.key === "Enter" && commitFps()} className="w-full rounded-xl border border-slate-600 bg-slate-900 px-4 py-3 pr-14 text-lg font-semibold text-white outline-none transition focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/20" /><span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-sm text-slate-400">fps</span></div>
              <p className="mt-3 text-xs leading-5 text-slate-400">逐格控制每次移動精確的 1 / fps 秒。</p>
              <div className="mt-3 flex flex-wrap gap-2">{[30, 60, 120, 240].map((preset) => <button key={preset} type="button" onClick={() => { setFps(preset); setFpsInput(String(preset)); }} className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${activeFps === preset ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>{preset}</button>)}</div>
            </section>}

            {workflowStep === "calibration" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Ruler size={18} className="text-fuchsia-300" />校正資訊</div>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between gap-4 border-b border-slate-700/80 pb-3"><dt className="text-slate-400">比例尺</dt><dd className="text-right font-mono font-semibold text-slate-100">{scaleCalibration ? `${scaleCalibration.realLengthM.toFixed(3)} m / ${formatPixelDistance(scaleCalibration.pixelDistance)} px` : "尚未設定"}</dd></div>
                <div className="flex justify-between gap-4 border-b border-slate-700/80 pb-3"><dt className="text-slate-400">原點</dt><dd className="font-mono font-semibold text-slate-100">{origin ? `(${origin.pixelX}, ${origin.pixelY})` : "尚未設定"}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-slate-400">座標軸</dt><dd className="text-right text-slate-200">x：相對向右旋轉 {axisAngleDegrees}°<br />y：與 x 軸垂直、向上為正</dd></div>
              </dl>
              <div className="mt-4 rounded-xl border border-amber-300/25 bg-amber-300/5 p-3">
                <div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold text-amber-100">座標軸旋轉</span><output className="font-mono text-sm font-bold text-amber-100">θ = {axisAngleDegrees.toFixed(1)}°</output></div>
                <p className="mt-2 text-xs leading-5 text-slate-300">直接拖曳影片 x 軸正方向上的 <span className="font-bold text-amber-100">旋轉控制點</span>。接近 0°、90°、180°、270° 時會輕微吸附。</p>
                <div className="mt-3 flex gap-2"><button type="button" disabled={!canControl} onClick={() => setAxisAngleDegrees(0)} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-amber-300/40 px-3 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:opacity-40"><RotateCcw size={15} />重設水平</button></div>
                <p className="mt-2 text-xs leading-5 text-slate-400">旋轉後所有位置、速度、加速度、圖表、擬合與 CSV 立即使用新座標軸。</p>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" disabled={!canControl} onClick={() => { setScaleCalibration(null); setActiveMode("scale"); }} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-fuchsia-300/40 px-3 text-xs font-semibold text-fuchsia-100 transition hover:bg-fuchsia-300/10 disabled:cursor-not-allowed disabled:opacity-40"><Ruler size={15} />{scaleCalibration ? "重新設定比例尺" : "設定比例尺"}</button>
                <button type="button" disabled={!canControl} onClick={() => setActiveMode("origin")} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-amber-300/40 px-3 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/10 disabled:cursor-not-allowed disabled:opacity-40"><MapPin size={15} />{origin ? "重新設定原點" : "設定原點"}</button>
              </div>
              {origin && <p className="mt-3 text-xs leading-5 text-amber-100">可直接拖曳影片上的 <span className="font-bold">O</span> 移動原點，或拖曳 x 軸上的 <span className="font-bold">旋轉控制點</span>；所有追蹤點、運動分析、圖表與擬合會即時重新換算。</p>}
              {scaleDraftA && scaleDraftB && <div className="mt-4 rounded-xl border border-fuchsia-300/30 bg-fuchsia-300/5 p-3"><p className="text-xs leading-5 text-fuchsia-100">A、B 相距 <span className="font-mono font-bold">{formatPixelDistance(draftPixelDistance)} px</span>。請輸入實際長度：</p><div className="mt-3 flex gap-2"><div className="relative min-w-0 flex-1"><input aria-label="比例尺實際長度（公尺）" type="number" min="0.000001" step="any" inputMode="decimal" value={scaleLengthInput} onChange={(event) => setScaleLengthInput(event.target.value)} placeholder="例如 1.00" className="w-full rounded-lg border border-fuchsia-300/40 bg-slate-950 px-3 py-2 pr-8 text-sm font-semibold text-white outline-none focus:border-fuchsia-200" /><span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-slate-400">m</span></div><button type="button" onClick={applyScaleCalibration} className="rounded-lg bg-fuchsia-300 px-3 text-xs font-bold text-slate-950 hover:bg-fuchsia-200">套用</button></div></div>}
            </section>}

            {workflowStep === "video" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <div className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-100"><Timer size={18} className="text-cyan-300" />目前位置</div>
              <dl className="space-y-3"><div className="flex items-baseline justify-between gap-4 border-b border-slate-700/80 pb-3"><dt className="text-sm text-slate-400">Current time</dt><dd className="font-mono text-sm font-semibold text-cyan-100">{formatTime(currentTime)}</dd></div><div className="flex items-baseline justify-between gap-4 border-b border-slate-700/80 pb-3"><dt className="text-sm text-slate-400">Duration</dt><dd className="font-mono text-sm font-semibold text-cyan-100">{formatTime(duration)}</dd></div><div className="flex items-baseline justify-between gap-4 border-b border-slate-700/80 pb-3"><dt className="text-sm text-slate-400">Current frame</dt><dd className="font-mono text-xl font-bold text-white">{currentFrame.toLocaleString()}</dd></div><div className="flex items-baseline justify-between gap-4"><dt className="text-sm text-slate-400">影片解析度</dt><dd className="font-mono text-sm font-semibold text-slate-100">{videoDimensions ? `${videoDimensions.width} × ${videoDimensions.height}` : "尚未載入"}</dd></div></dl>
              <p className="mt-4 text-xs leading-5 text-slate-500">Frame 從 0 開始計算，依目前設定的 {activeFps} fps 顯示。</p>
            </section>}

            {workflowStep === "tracking" && <section className="rounded-2xl border border-cyan-300/20 bg-cyan-300/5 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-cyan-100">追蹤準星位置</p><p className="mt-1 font-mono text-xs text-slate-300">準星 X: {crosshairPreviewPoint?.pixelX ?? "—"} px　Y: {crosshairPreviewPoint?.pixelY ?? "—"} px</p></div><div className="flex flex-wrap gap-2"><button type="button" disabled={!canControl || !crosshairPreviewPoint || trackingMethod !== "manual" || autoTrackingStatus === "running"} onClick={() => editingFrame !== null ? updateEditingTrackingPoint() : crosshairPreviewPoint && recordManualTrackingPoint(crosshairPreviewPoint)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-cyan-300 px-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"><Crosshair size={16} />{editingFrame !== null ? "更新此點" : "記錄準星位置"}</button><button type="button" disabled={!canControl || !videoWidth || !videoHeight || autoTrackingStatus === "running"} onClick={() => setCrosshairCenter({ pixelX: Math.round(videoWidth / 2), pixelY: Math.round(videoHeight / 2) })} className="inline-flex min-h-11 items-center rounded-lg border border-cyan-300/40 px-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40">置中</button>{editingFrame !== null && <button type="button" onClick={() => setEditingFrame(null)} className="inline-flex min-h-11 items-center rounded-lg border border-slate-600 px-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800">取消修正</button>}</div></div>
              {editingFrame !== null && <p className="mt-3 rounded-lg border border-amber-300/35 bg-amber-300/10 px-3 py-2 text-sm font-semibold text-amber-100" aria-live="polite">正在修正 Frame {editingFrame}</p>}
              <p className="mt-2 text-xs leading-5 text-slate-400">點選影片只會移動準星；確認位置後再按「記錄準星位置」。自動追蹤中拖曳準星會停止追蹤，但保留已建立資料。</p>
              <div className="mt-3 flex flex-wrap gap-2"><label className={`inline-flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs font-semibold ${trackingMethod === "manual" ? "cursor-pointer border-cyan-300/50 text-cyan-100" : "cursor-not-allowed border-slate-700 text-slate-500"}`}><input type="checkbox" checked={advanceAfterManualRecord} disabled={trackingMethod !== "manual"} onChange={(event) => setAdvanceAfterManualRecord(event.target.checked)} className="h-4 w-4 accent-cyan-300 disabled:opacity-40" />記錄後自動前進一格</label><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-600 px-2.5 py-2 text-xs font-semibold text-slate-200"><input type="checkbox" checked={showTrackingTrail} onChange={(event) => setShowTrackingTrail(event.target.checked)} className="h-4 w-4 accent-cyan-300" />顯示軌跡點</label><label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-600 px-2.5 py-2 text-xs font-semibold text-slate-200"><input type="checkbox" checked={showTrajectoryLines} disabled={!showTrackingTrail} onChange={(event) => setShowTrajectoryLines(event.target.checked)} className="h-4 w-4 accent-cyan-300 disabled:opacity-40" />連接軌跡</label></div>
            </section>}

            {workflowStep === "tracking" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5">
              <div className="mb-4 flex items-center justify-between gap-3"><div className="flex items-center gap-2 text-sm font-semibold text-slate-100"><Crosshair size={18} className="text-cyan-300" />追蹤資料</div><span className="rounded-md bg-slate-800 px-2 py-1 text-xs font-mono text-slate-300">{trackingPoints.length} 點</span></div>
              <div className="mb-3 flex flex-wrap gap-2"><button type="button" onClick={clearTrackingPoints} disabled={trackingPoints.length === 0} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-rose-400/40 px-3 text-sm font-semibold text-rose-200 transition hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-40"><Trash2 size={16} />清除全部點位</button></div>
              {sortedPoints.length > 0 ? <><div className="space-y-3 sm:hidden">{sortedPoints.map((point) => { const isLowConfidence = point.trackingMethod === "auto" && (point.trackingConfidence ?? 1) < 0.55; return <article key={point.frame} className={`rounded-xl border p-3 ${point.frame === currentFrame ? "border-cyan-300/50 bg-cyan-300/10" : "border-slate-700 bg-slate-950/25"}`}><div className="flex items-start justify-between gap-3"><div><p className="font-mono text-base font-bold text-white">Frame {point.frame}</p><p className="mt-1 font-mono text-xs text-slate-400">Time {(point.frame / activeFps).toFixed(3)} s</p></div><span className={`rounded-md px-2 py-1 font-mono text-xs font-semibold ${isLowConfidence ? "bg-amber-300/15 text-amber-100" : point.trackingMethod === "auto" ? "bg-emerald-300/15 text-emerald-100" : "bg-slate-800 text-slate-300"}`}>{point.trackingMethod === "auto" ? `信心 ${(point.trackingConfidence ?? 0).toFixed(2)}${isLowConfidence ? " ⚠" : ""}` : "手動"}</span></div><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><div><dt className="text-xs text-slate-500">Pixel X</dt><dd className="font-mono text-slate-100">{point.pixelX}</dd></div><div><dt className="text-xs text-slate-500">Pixel Y</dt><dd className="font-mono text-slate-100">{point.pixelY}</dd></div></dl><div className="mt-3 grid grid-cols-2 gap-3"><button type="button" disabled={!canControl} onClick={() => beginEditingTrackingPoint(point)} className="min-h-11 rounded-lg border border-cyan-300/45 px-3 text-sm font-bold text-cyan-100 transition hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40">修正</button><button type="button" onClick={() => deleteTrackingPoint(point.frame)} className="min-h-11 rounded-lg border border-rose-400/45 px-3 text-sm font-bold text-rose-200 transition hover:bg-rose-400/10">刪除</button></div></article>; })}</div><div className="hidden max-h-72 overflow-auto rounded-lg border border-slate-700 sm:block"><table className="w-full min-w-[660px] border-collapse text-left text-xs"><thead className="sticky top-0 bg-slate-800 text-slate-300"><tr><th className="px-2.5 py-2 font-semibold">Frame</th><th className="px-2.5 py-2 font-semibold">Time (s)</th><th className="px-2.5 py-2 font-semibold">Pixel X</th><th className="px-2.5 py-2 font-semibold">Pixel Y</th><th className="px-2.5 py-2 font-semibold">Confidence</th><th className="px-2.5 py-2 font-semibold">修正</th><th className="px-2.5 py-2 font-semibold">刪除</th></tr></thead><tbody>{sortedPoints.map((point) => { const isLowConfidence = point.trackingMethod === "auto" && (point.trackingConfidence ?? 1) < 0.55; return <tr key={point.frame} className={point.frame === currentFrame ? "bg-cyan-300/10" : "border-t border-slate-700/80"}><td className="px-2.5 py-2 font-mono text-slate-100">{point.frame}</td><td className="px-2.5 py-2 font-mono text-slate-300">{(point.frame / activeFps).toFixed(3)}</td><td className="px-2.5 py-2 font-mono text-slate-300">{point.pixelX}</td><td className="px-2.5 py-2 font-mono text-slate-300">{point.pixelY}</td><td className={`px-2.5 py-2 font-mono font-semibold ${isLowConfidence ? "text-amber-200" : point.trackingMethod === "auto" ? "text-emerald-200" : "text-slate-400"}`}>{point.trackingMethod === "auto" ? `${(point.trackingConfidence ?? 0).toFixed(2)}${isLowConfidence ? " ⚠" : ""}` : "—"}</td><td className="px-2.5 py-2"><button type="button" disabled={!canControl} onClick={() => beginEditingTrackingPoint(point)} className="min-h-11 whitespace-nowrap rounded-lg border border-cyan-300/45 px-3 text-sm font-bold text-cyan-100 transition hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-40">修正</button></td><td className="px-2.5 py-2"><button type="button" onClick={() => deleteTrackingPoint(point.frame)} className="min-h-11 whitespace-nowrap rounded-lg border border-rose-400/45 px-3 text-sm font-bold text-rose-200 transition hover:bg-rose-400/10">刪除</button></td></tr>; })}</tbody></table></div></> : <p className="rounded-lg border border-dashed border-slate-700 px-3 py-4 text-center text-xs leading-5 text-slate-400">暫停影片後，點選物體以移動準星，再按「記錄準星位置」。</p>}
            </section>}
            <div className="mt-auto flex items-center justify-between gap-3 rounded-2xl border border-slate-700 bg-[#0c1b2c] p-4">
              <button type="button" disabled={workflowIndex === 0} onClick={() => goToWorkflowStep(workflowOrder[workflowIndex - 1])} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-slate-600 px-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"><ChevronLeft size={17} />上一步</button>
              {workflowIndex < workflowOrder.length - 1 && <button type="button" onClick={() => goToWorkflowStep(workflowOrder[workflowIndex + 1])} className="inline-flex min-h-10 items-center gap-1.5 rounded-xl bg-cyan-300 px-3 text-sm font-bold text-slate-950 transition hover:bg-cyan-200">下一步：{workflowOrder[workflowIndex + 1] === "reticle" ? "調整準星" : workflowOrder[workflowIndex + 1] === "tracking" ? "追蹤軌跡" : workflowOrder[workflowIndex + 1] === "calibration" ? "原點與比例尺" : "圖形與擬合"}<ChevronRight size={17} /></button>}
            </div>
          </aside>
          </>}

          {workflowStep === "analysis" && <section className="rounded-2xl border border-slate-700 bg-[#0c1b2c] p-5 shadow-lg shadow-black/10 lg:col-span-2 sm:p-6">
            <div className="flex flex-col gap-4 border-b border-slate-700/80 pb-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex items-center gap-2 text-lg font-semibold text-white"><MoveRight size={20} className="text-emerald-300" />運動分析</div>
                <p className="mt-1 text-sm text-slate-400">分析時間以最早追蹤點為 t = 0；所有差分都採用實際影格間的時間差。</p>
              </div>
              <button type="button" onClick={exportCsv} disabled={!hasPhysicalCoordinates || analysisPoints.length === 0} className="inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-emerald-300/40 px-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-300/10 disabled:cursor-not-allowed disabled:opacity-40"><Download size={17} />匯出 CSV</button>
            </div>

            <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-1 text-sm font-semibold text-slate-200">分析資料</span>
                <button type="button" onClick={() => setAnalysisMode("raw")} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${analysisMode === "raw" ? "bg-cyan-300 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>原始資料</button>
                <button type="button" onClick={() => setAnalysisMode("smooth")} className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${analysisMode === "smooth" ? "bg-emerald-300 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>平滑資料</button>
              </div>
              <span className={`inline-flex w-fit items-center rounded-full px-3 py-1.5 text-xs font-semibold ${analysisMode === "smooth" ? "bg-emerald-300/15 text-emerald-100" : "bg-cyan-300/15 text-cyan-100"}`}>{analysisMode === "smooth" ? "目前使用平滑資料（3 點移動平均）" : "目前使用原始資料"}</span>
            </div>

            {!hasPhysicalCoordinates ? (
              <p className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm leading-6 text-amber-100">尚未設定{missingSetup}，位置、速度與加速度分析尚未啟用。</p>
            ) : (
              <>
                {analysisPoints.length < 2 && <p className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm leading-6 text-amber-100">有效追蹤點少於 2 個，尚無法計算速度。</p>}
                {analysisPoints.length >= 2 && analysisPoints.length < 3 && <p className="mt-5 rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-3 text-sm leading-6 text-amber-100">目前有 {analysisPoints.length} 個有效追蹤點；可計算速度，但少於 3 點，尚不顯示可靠的加速度。</p>}

                <div className="mt-5 overflow-auto rounded-xl border border-slate-700">
                  <table className="w-full min-w-[980px] border-collapse text-left text-xs">
                    <thead className="sticky top-0 bg-slate-800 text-slate-300"><tr><th className="px-3 py-2.5 font-semibold">Frame</th><th className="px-3 py-2.5 font-semibold">Time (s)</th><th className="px-3 py-2.5 font-semibold">X (m)</th><th className="px-3 py-2.5 font-semibold">Y (m)</th><th className="px-3 py-2.5 font-semibold">Vx (m/s)</th><th className="px-3 py-2.5 font-semibold">Vy (m/s)</th><th className="px-3 py-2.5 font-semibold">Speed (m/s)</th><th className="px-3 py-2.5 font-semibold">Ax (m/s²)</th><th className="px-3 py-2.5 font-semibold">Ay (m/s²)</th><th className="px-3 py-2.5 font-semibold">|a| (m/s²)</th></tr></thead>
                    <tbody>{analysisPoints.length > 0 ? analysisPoints.map((point) => <tr key={point.frame} className={point.frame === currentFrame ? "bg-cyan-300/10" : "border-t border-slate-700/80"}><td className="px-3 py-2.5 font-mono text-slate-100">{point.frame}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.time)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.x)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.y)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.vx)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.vy)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.speed)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.ax)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.ay)}</td><td className="px-3 py-2.5 font-mono text-slate-300">{formatNumber(point.acceleration)}</td></tr>) : <tr><td colSpan={10} className="px-4 py-6 text-center text-sm text-slate-400">尚無追蹤資料。</td></tr>}</tbody>
                  </table>
                </div>

                <div className="mt-7 rounded-xl border border-slate-700 bg-slate-950/35 p-4 sm:p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-1.5">{chartOptions.map((option) => <button key={option.id} type="button" onClick={() => setChartMetric(option.id)} className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition ${chartMetric === option.id ? "bg-slate-100 text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>{option.label}</button>)}</div>
                    {chartMetric === "xy" && <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-semibold text-cyan-100"><input type="checkbox" checked={equalAxisScale} onChange={(event) => setEqualAxisScale(event.target.checked)} className="h-4 w-4 accent-cyan-300" />x / y 軸採 1:1 比例</label>}
                  </div>

                  <div className="mt-3 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
                    <div ref={fitPanelContainerRef} className="relative min-w-0">
                      <div className="h-80">
                      {(chartMetric === "xy" ? xyData.length > 0 : chartData.length > 0) ? <ResponsiveContainer width="100%" height="100%"><ComposedChart data={activeChartData} margin={{ top: 16, right: 22, bottom: 26, left: 20 }}><CartesianGrid stroke="#334155" strokeDasharray="4 4" />{chartMetric === "xy" ? <><XAxis type="number" dataKey="x" name="x" unit=" m" domain={xyDomain} stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "x (m)", position: "insideBottom", offset: -10, fill: "#cbd5e1", fontSize: 12 }} /><YAxis type="number" dataKey="y" name="y" unit=" m" domain={xyDomain} stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "y (m)", angle: -90, position: "insideLeft", offset: -6, fill: "#cbd5e1", fontSize: 12 }} /><Tooltip cursor={{ strokeDasharray: "4 4", stroke: "#94a3b8" }} contentStyle={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 8, color: "#f8fafc" }} /><Scatter name="位置點" data={xyChartPoints} shape="circle">{xyChartPoints.map((point) => <Cell key={`${point.frame}-${point.x}`} fill={point.inFitRange ? "#22d3ee" : "#64748b"} opacity={point.inFitRange ? 1 : 0.55} />)}</Scatter>{fitCurvePoints.length > 0 && <Line name="擬合曲線" data={fitCurvePoints.map((point) => ({ x: point.time, y: point.fit }))} dataKey="y" type="monotone" stroke="#f8fafc" strokeWidth={2.5} dot={false} isAnimationActive={false} />}</> : <><XAxis type="number" dataKey="time" name="Time" unit=" s" stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: "Time (s)", position: "insideBottom", offset: -10, fill: "#cbd5e1", fontSize: 12 }} /><YAxis type="number" dataKey="value" name={selectedChart.axisLabel} stroke="#94a3b8" tick={{ fill: "#cbd5e1", fontSize: 12 }} label={{ value: selectedChart.axisLabel, angle: -90, position: "insideLeft", offset: -6, fill: "#cbd5e1", fontSize: 12 }} /><Tooltip cursor={{ strokeDasharray: "4 4", stroke: "#94a3b8" }} contentStyle={{ background: "#0f172a", border: "1px solid #475569", borderRadius: 8, color: "#f8fafc" }} labelStyle={{ color: "#cbd5e1" }} /><Scatter name="量測點" data={chartData} shape="circle">{chartData.map((point) => <Cell key={`${point.frame}-${point.time}`} fill={point.inFitRange ? selectedChart.color : "#64748b"} opacity={point.inFitRange ? 1 : 0.55} />)}</Scatter>{fitCurvePoints.length > 0 && <Line name="擬合曲線" data={fitCurvePoints} dataKey="fit" type="monotone" stroke="#f8fafc" strokeWidth={2.5} dot={false} isAnimationActive={false} />}</>}</ComposedChart></ResponsiveContainer> : <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-700 text-center text-sm text-slate-400">此物理量目前沒有足夠的有效資料可繪圖。</div>}
                      </div>
                      {fitModel !== "none" && isFitPanelVisible && <FloatingFitResultPanel containerRef={fitPanelContainerRef} position={fitPanelPosition} onPositionChange={setFitPanelPosition} collapsed={isFitPanelCollapsed} onCollapsedChange={setIsFitPanelCollapsed} onClose={() => setIsFitPanelVisible(false)}>{fitError ? <p className="text-amber-100">{fitError}</p> : fitResult && fitResult.ok ? <><p className="font-semibold text-fuchsia-100">{fitModelLabel[fitResult.model]}</p>{fitInputRange && <p className="text-slate-300">{fitIndependentVariable} 範圍：<span className="font-mono">{formatSignificant(fitInputRange.minimum)} – {formatSignificant(fitInputRange.maximum)} {fitIndependentUnit}</span></p>}<p className="text-slate-300">{fitFrameRange}</p><p className="mt-1 break-words font-mono font-semibold text-white">{fitEquation}</p><div className="mt-1 grid grid-cols-2 gap-x-4">{Object.entries(fitResult.coefficients).map(([name, value]) => <p key={name}><span className="text-slate-400">{name === "omega" ? "ω" : name === "phi" ? "φ" : name}：</span><span className="font-mono text-white">{formatSignificant(value)}</span></p>)}<p><span className="text-slate-400">r：</span><span className="font-mono text-white">{formatSignificant(fitResult.correlation)}</span></p><p><span className="text-slate-400">R²：</span><span className="font-mono text-white">{formatSignificant(fitResult.rSquared)}</span></p><p className="col-span-2"><span className="text-slate-400">均方根誤差：</span><span className="font-mono text-white">{formatSignificant(fitResult.rmse)}</span></p><p className="col-span-2"><span className="text-slate-400">n：</span><span className="font-mono text-white">{fitResult.n}</span></p></div>{fitResult.model === "quadratic" && chartMetric === "y" && <p className="mt-1 border-t border-amber-300/20 pt-1 text-amber-100">a_y = 2A = <span className="font-mono font-bold">{formatSignificant(2 * fitResult.coefficients.A)} m/s²</span></p>}{fitResult.model === "linear" && chartMetric === "x" && <p className="mt-1 border-t border-cyan-300/20 pt-1 text-cyan-100">v_x = slope = <span className="font-mono font-bold">{formatSignificant(fitResult.coefficients.m)} m/s</span></p>}{fitResult.model === "linear" && (chartMetric === "vx" || chartMetric === "vy") && <p className="mt-1 border-t border-cyan-300/20 pt-1 text-cyan-100">a_{chartMetric === "vx" ? "x" : "y"} = slope = <span className="font-mono font-bold">{formatSignificant(fitResult.coefficients.m)} m/s²</span></p>}</> : <p className="text-slate-300">請選擇適用的擬合模式。</p>}</FloatingFitResultPanel>}
                      <div className="mt-3"><h2 className="text-base font-semibold text-white">圖表分析：{selectedChart.label}</h2><p className="mt-1 text-xs leading-5 text-slate-400">散點代表量測影格，亮色點納入擬合，灰色點保留作為範圍外的參考。</p></div>
                    </div>

                    <div className="rounded-xl border border-slate-700 bg-[#0c1b2c] p-4">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white"><Ruler size={17} className="text-fuchsia-300" />曲線擬合</div>
                      <p className="mt-1 text-xs leading-5 text-slate-400">本次擬合使用：<span className="font-semibold text-slate-200">{analysisMode === "smooth" ? "平滑資料（3 點移動平均）" : "原始資料"}</span></p>
                      {accelerationAverage !== undefined && <p className="mt-2 rounded-lg border border-amber-300/20 bg-amber-300/5 px-2.5 py-2 text-xs text-amber-100">平均 {chartMetric === "ax" ? "aₓ" : "aᵧ"} = <span className="font-mono font-bold">{formatSignificant(accelerationAverage)} m/s²</span></p>}
                      <label className="mt-3 block text-xs font-semibold text-slate-200">擬合模式<select aria-label="擬合模式" value={fitModel} onChange={(event) => { const nextModel = event.target.value as FitModel; setFitModel(nextModel); if (nextModel !== "none") { setIsFitPanelVisible(true); setIsFitPanelCollapsed(false); } }} className="mt-1.5 block w-full rounded-lg border border-fuchsia-300/40 bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white outline-none focus:border-fuchsia-200"><option value="none">不擬合</option><option value="linear">線性</option><option value="quadratic">二次</option><option value="exponential">指數</option><option value="logarithmic">對數</option><option value="power">冪次</option><option value="inverse">反比</option><option value="sine">正弦</option><option value="cosine">餘弦</option></select></label>
                      {fitModel !== "none" && !isFitPanelVisible && <button type="button" onClick={() => { setIsFitPanelVisible(true); setIsFitPanelCollapsed(false); }} className="mt-2 text-xs font-semibold text-fuchsia-100 transition hover:text-white">顯示圖內結果框</button>}
                      <div className="mt-4 border-t border-slate-700 pt-4"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-slate-200">擬合資料範圍</span><button type="button" onClick={() => { setFitStartFrame(""); setFitEndFrame(""); }} className="text-xs font-semibold text-cyan-200 hover:text-cyan-100">全部資料</button></div><div className="grid grid-cols-2 gap-2"><label className="text-xs text-slate-400">起始 frame<input type="number" min="0" step="1" value={fitStartFrame} onChange={(event) => setFitStartFrame(event.target.value)} placeholder="全部" className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-2 font-mono text-sm text-white outline-none focus:border-cyan-300" /></label><label className="text-xs text-slate-400">結束 frame<input type="number" min="0" step="1" value={fitEndFrame} onChange={(event) => setFitEndFrame(event.target.value)} placeholder="全部" className="mt-1 block w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 py-2 font-mono text-sm text-white outline-none focus:border-cyan-300" /></label></div><p className="mt-2 text-xs text-slate-500">納入 {fittingData.length} 個有效點 · {fitFrameRange}</p></div>
                    </div>
                  </div>

                  <details className="mt-5 rounded-xl border border-fuchsia-300/25 bg-fuchsia-300/5 p-4">
                    <summary className="cursor-pointer list-none text-sm font-semibold text-fuchsia-100">詳細擬合結果</summary>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold text-fuchsia-100">擬合結果</h3>{fitModel !== "none" && <span className="rounded-full bg-fuchsia-300/15 px-2.5 py-1 text-xs font-semibold text-fuchsia-100">{analysisMode === "smooth" ? "平滑資料" : "原始資料"}</span>}</div>
                    {fitModel === "none" ? <p className="mt-2 text-sm text-slate-400">選擇擬合模式以分析目前圖表與指定 frame 範圍。</p> : fitError ? <p className="mt-2 text-sm leading-6 text-amber-100">{fitError}</p> : fitResult && fitResult.ok ? <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4"><div><p className="text-xs text-slate-400">圖表種類</p><p className="mt-1 font-semibold text-white">{selectedChart.label}</p></div><div><p className="text-xs text-slate-400">擬合模型／範圍</p><p className="mt-1 font-semibold text-white">{fitModelLabel[fitResult.model]} · {fitFrameRange}</p></div><div className="sm:col-span-2"><p className="text-xs text-slate-400">方程式</p><p className="mt-1 break-words font-mono font-semibold text-fuchsia-100">{fitEquation}</p></div>{Object.entries(fitResult.coefficients).map(([name, value]) => <div key={name}><p className="text-xs text-slate-400">{name === "omega" ? "ω" : name === "phi" ? "φ" : name}</p><p className="mt-1 font-mono text-white">{formatSignificant(value)}</p></div>)}<div><p className="text-xs text-slate-400">R²</p><p className="mt-1 font-mono text-white">{formatSignificant(fitResult.rSquared)}</p></div><div><p className="text-xs text-slate-400">Pearson r</p><p className="mt-1 font-mono text-white">{formatSignificant(fitResult.correlation)}</p></div><div><p className="text-xs text-slate-400">RMSE</p><p className="mt-1 font-mono text-white">{formatSignificant(fitResult.rmse)}</p></div><div><p className="text-xs text-slate-400">使用資料點 n</p><p className="mt-1 font-mono text-white">{fitResult.n}</p></div><div className="sm:col-span-2"><p className="text-xs text-slate-400">Frame 範圍</p><p className="mt-1 font-mono text-white">{fitFrameRange}</p></div>{fitResult.model === "quadratic" && chartMetric === "y" && <div className="sm:col-span-2 xl:col-span-4 rounded-lg border border-amber-300/20 bg-amber-300/5 px-3 py-2"><p className="text-xs leading-5 text-amber-100">由二次項推得的加速度：a_y = 2A = <span className="font-mono font-bold">{formatSignificant(2 * fitResult.coefficients.A)} m/s²</span><br />若 y 軸向上為正，估計重力加速度大小 g = |2A| = <span className="font-mono font-bold">{formatSignificant(Math.abs(2 * fitResult.coefficients.A))} m/s²</span></p></div>}{fitResult.model === "linear" && chartMetric === "x" && <div className="sm:col-span-2 xl:col-span-4 rounded-lg border border-cyan-300/20 bg-cyan-300/5 px-3 py-2 text-xs leading-5 text-cyan-100">等速度運動輔助量：v_x = slope = <span className="font-mono font-bold">{formatSignificant(fitResult.coefficients.m)} m/s</span></div>}{fitResult.model === "linear" && (chartMetric === "vx" || chartMetric === "vy") && <div className="sm:col-span-2 xl:col-span-4 rounded-lg border border-cyan-300/20 bg-cyan-300/5 px-3 py-2 text-xs leading-5 text-cyan-100">等加速度運動輔助量：a_{chartMetric === "vx" ? "x" : "y"} = slope = <span className="font-mono font-bold">{formatSignificant(fitResult.coefficients.m)} m/s²</span></div>}</div> : <p className="mt-2 text-sm text-slate-400">請選擇擬合模式。</p>}
                  </details>
                </div>
              </>
            )}
          </section>}
        </section>
      </div>
    </main>
  );
}
