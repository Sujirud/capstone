/**
 * Live mode's camera, detector and frame loop for the live screen: starting
 * and stopping them, switching camera and zoom, calibration, and the burst once
 * auto-capture fires (encoded as JPEG, fitted to the upload limits). Everything is released
 * when the screen goes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientConfig } from "../../api/schemas";
import { useLiveServices } from "../../app/services";
import { burstCapture, type Capture, type CameraIn } from "../../capture/CaptureSource";
import { fitBurst, type BurstProblem } from "../../capture/live/burst";
import { loadCalibration, saveCalibration, type CameraSetup } from "../../capture/live/calibration";
import { CameraError, nextCameraId, zoomChoices, type Camera, type CameraProblem, type Facing } from "../../capture/live/camera";
import type { FaceDetector } from "../../capture/live/detector";
import { LiveLoop, type KeptFrame, type LiveStatus } from "../../capture/live/loop";

export type LiveProblem = CameraProblem | "model" | "detection_failed" | "too_large" | "prepare_failed" | BurstProblem;

export type LivePhase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "preparing"; done: number; of: number }
  | { kind: "problem"; problem: LiveProblem };

export interface LiveEvents {
  /** Every processed frame's status (the screen decides what to show, say and announce). */
  onStatus(status: LiveStatus): void;
  onCaptured(capture: Capture): void;
  onCalibrated(): void;
}

function sameStatus(a: LiveStatus | null, b: LiveStatus): boolean {
  return (
    a !== null &&
    a.hint === b.hint &&
    a.streak === b.streak &&
    a.width === b.width &&
    a.height === b.height &&
    a.calibration?.count === b.calibration?.count
  );
}

export function useLiveCamera(config: ClientConfig, events: LiveEvents) {
  const live = useLiveServices();
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<Camera | null>(null);
  const detectorRef = useRef<Promise<FaceDetector> | null>(null);
  const loopRef = useRef<LiveLoop | null>(null);
  const eventsRef = useRef(events);
  useEffect(() => {
    eventsRef.current = events;
  });
  // A burst still being encoded when the screen goes is dropped, not analyzed.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The camera to open next when switching; otherwise the facing picks it.
  const deviceRef = useRef<string | undefined>(undefined);

  const [phase, setPhase] = useState<LivePhase>(() => (live.supported() ? { kind: "idle" } : { kind: "problem", problem: "unsupported" }));
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [zoom, setZoomValue] = useState(1);
  const [zoomOptions, setZoomOptions] = useState<number[]>([]);
  const [cameras, setCameras] = useState<string[]>([]);
  const [focalPx, setFocalPx] = useState<number | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const setupRef = useRef<CameraSetup | null>(null);

  /** The camera as calibrations apply to it; a new size or zoom looks up its own calibration. */
  const updateSetup = useCallback((width: number, height: number) => {
    const camera = cameraRef.current;
    const loop = loopRef.current;
    if (!camera || !loop || width === 0) return;
    const setup: CameraSetup = { camera: camera.deviceId || camera.facing, width, height, zoom: camera.zoom };
    setupRef.current = setup;
    const focal = loadCalibration(setup);
    loop.camera = focal === null ? null : ({ focal_px: focal, source: "calibration" } satisfies CameraIn);
    setFocalPx(focal);
  }, []);

  const release = useCallback(() => {
    loopRef.current?.stop();
    loopRef.current = null;
    if (cameraRef.current) live.closeCamera(cameraRef.current);
    cameraRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, [live]);

  /** Drops the detector (closed), so the next start loads a fresh one. */
  const dropDetector = useCallback(() => {
    void detectorRef.current?.then((d) => d.close()).catch(() => undefined);
    detectorRef.current = null;
  }, []);

  const prepare = useCallback(
    async (kept: KeptFrame[], camera: CameraIn | null) => {
      setPhase({ kind: "preparing", done: 0, of: kept.length });
      release();
      const encoded: Array<{ blob: Blob; bytes: number; score: number; width: number; height: number }> = [];
      try {
        for (const [i, { frame, score }] of kept.entries()) {
          if (!mounted.current) throw new Error("the screen was left");
          const blob = await frame.encode();
          encoded.push({ blob, bytes: blob.size, score, width: frame.width, height: frame.height });
          frame.close();
          setPhase({ kind: "preparing", done: i + 1, of: kept.length });
        }
      } catch {
        kept.forEach(({ frame }) => frame.close());
        return mounted.current ? setPhase({ kind: "problem", problem: "prepare_failed" }) : undefined;
      }
      if (!mounted.current) return;
      const fit = fitBurst(encoded, config.upload_limits, config.frontal.burst.min_frames);
      if (!fit.ok) return setPhase({ kind: "problem", problem: fit.problem });
      const frames = fit.frames.map((f, i) => ({ blob: f.blob, name: `live-${i + 1}.jpg`, width: f.width, height: f.height }));
      eventsRef.current.onCaptured(burstCapture(frames, camera));
    },
    [config, release],
  );

  // Opening the camera: when asked to start (a new facing starts it again).
  const starting = phase.kind === "starting";
  useEffect(() => {
    if (!starting) return;
    let cancelled = false;
    void (async () => {
      let camera: Camera;
      try {
        camera = await live.openCamera(facing, deviceRef.current);
      } catch (err) {
        if (!cancelled) setPhase({ kind: "problem", problem: err instanceof CameraError ? err.problem : "failed" });
        return;
      }
      if (cancelled) return live.closeCamera(camera);
      cameraRef.current = camera;
      setZoomValue(camera.zoom);
      setZoomOptions(zoomChoices(camera.zoomRange));
      // The list has ids only once the browser has camera permission, so it is read now.
      void live.cameraIds().then((ids) => !cancelled && setCameras(ids));
      const video = videoRef.current;
      let detector: FaceDetector;
      try {
        if (!video) throw new Error("no video element");
        video.srcObject = camera.stream;
        try {
          await video.play(); // muted and inline: allowed without a gesture
        } catch {
          // frames come once it plays
        }
        detector = await (detectorRef.current ??= live.createDetector());
      } catch {
        detectorRef.current = null;
        if (!cancelled) {
          release();
          setPhase({ kind: "problem", problem: "model" });
        }
        return;
      }
      if (cancelled) return;
      const loop = new LiveLoop(
        config,
        { detector, frames: live.frames(video), nextFrame: (cb) => live.nextFrame(video, cb), now: live.now },
        {
          onStatus(s) {
            if (s.width !== setupRef.current?.width || s.height !== setupRef.current?.height) updateSetup(s.width, s.height);
            setStatus((prev) => (sameStatus(prev, s) ? prev : s));
            eventsRef.current.onStatus(s);
          },
          onBurst(kept) {
            void prepare(kept, loop.camera);
          },
          onCalibrated(focal) {
            if (setupRef.current) saveCalibration(setupRef.current, focal);
            loop.camera = { focal_px: focal, source: "calibration" };
            setFocalPx(focal);
            setCalibrating(false);
            eventsRef.current.onCalibrated();
          },
          onTooLarge() {
            release();
            setPhase({ kind: "problem", problem: "too_large" });
          },
          onError() {
            release();
            dropDetector();
            setPhase({ kind: "problem", problem: "detection_failed" });
          },
        },
      );
      loopRef.current = loop;
      setupRef.current = null;
      loop.start();
      setPhase({ kind: "running" });
    })();
    return () => {
      cancelled = true;
    };
    // The config is fixed for this screen; `facing` is read when starting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting]);

  // Leaving the screen stops the camera and frees the detector.
  useEffect(
    () => () => {
      release();
      dropDetector();
    },
    [release, dropDetector],
  );

  const start = useCallback(() => {
    setStatus(null);
    setCalibrating(false);
    setPhase({ kind: "starting" });
  }, []);

  /** The next camera by id where the browser lists them (a laptop's webcams), else the other facing. */
  const switchCamera = useCallback(() => {
    const current = cameraRef.current;
    const next = current ? nextCameraId(cameras, current.deviceId) : null;
    release();
    deviceRef.current = next ?? undefined;
    if (next === null) setFacing((f) => (f === "environment" ? "user" : "environment"));
    start();
  }, [cameras, release, start]);

  const changeZoom = useCallback(
    async (value: number) => {
      const camera = cameraRef.current;
      const loop = loopRef.current;
      if (!camera || !loop) return;
      // A burst's frames share one zoom, and a calibration holds for one zoom.
      loop.stop();
      try {
        await live.setZoom(camera, value);
      } catch {
        // the camera keeps its zoom
      }
      setZoomValue(camera.zoom);
      if (setupRef.current) updateSetup(setupRef.current.width, setupRef.current.height);
      loop.start();
    },
    [live, updateSetup],
  );

  const calibrate = useCallback(() => {
    loopRef.current?.calibrate();
    setCalibrating(true);
  }, []);

  const cancelCalibration = useCallback(() => {
    loopRef.current?.cancelCalibration();
    setCalibrating(false);
  }, []);

  return {
    videoRef,
    phase,
    status,
    facing,
    zoom,
    zoomOptions,
    canSwitch: cameras.length > 1,
    focalPx,
    calibrating,
    start,
    switchCamera,
    changeZoom,
    calibrate,
    cancelCalibration,
  };
}
