/**
 * Live mode: the gate port reproduces the core's check values from the
 * same detector outputs (fixtures/live_gates.json, made by gen_fixtures.py from the core's
 * own `quality.frontal_checks`), and the display smoothing is the core's One-Euro filter.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fixture from "../fixtures/live_gates.json" with { type: "json" };
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import { ClientConfigSchema } from "../src/api/schemas";
import { fitBurst, framesToKeep, REQUEST_OVERHEAD_BYTES, Streak } from "../src/capture/live/burst";
import {
  assumedFocalPx,
  Calibration,
  CALIBRATION_FRAMES,
  faceSizeAt,
  focalFromIris,
  loadCalibration,
  saveCalibration,
  TYPICAL_IPD_MM,
} from "../src/capture/live/calibration";
import { nextCameraId } from "../src/capture/live/camera";
import { detections, matrixRows, type FaceDetector } from "../src/capture/live/detector";
import { HintDisplay, Steady } from "../src/capture/live/display";
import type { Frame, FrameSource } from "../src/capture/live/frames";
import {
  CHECK_ORDER,
  EXPRESSION_HINTS,
  faceCountCheck,
  frontalChecks,
  meshIrisPx,
  poseFromMatrix,
  summarize,
  type Detection,
} from "../src/capture/live/gates";
import { LiveLoop, MAX_FAILED_FRAMES, type KeptFrame, type LiveStatus } from "../src/capture/live/loop";
import { FACE_OVAL_RING, IRIS } from "../src/capture/live/mesh";
import { OneEuroFilter } from "../src/capture/live/oneEuro";
import { faceBox, type Region } from "../src/capture/live/pixels";
import { STORAGE_KEYS } from "../src/app/storage";
import { WEB } from "./paths";
import { readPng } from "./png";

const config = ClientConfigSchema.parse(configEn);
const gates = config.frontal.gates;
const irisMm = config.frontal.iris_diameter_mm;

type Image = (typeof fixture.images)[keyof typeof fixture.images];
const images = fixture.images as Record<string, Image>;

function region(name: string): Region {
  const png = readPng(join(WEB, "fixtures", "live", `${name}.png`));
  const [left, top] = images[name]!.region as [number, number, number, number];
  return { data: png.data, width: png.width, height: png.height, channels: 3, left, top };
}

type Case = (typeof fixture.cases)[number] & { xy_patch?: Record<string, number[]> };

function detection(c: Case): Detection {
  const xy = images[c.image]!.xy.map((p) => [p[0]!, p[1]!] as const);
  for (const [i, p] of Object.entries(c.xy_patch ?? {})) xy[Number(i)] = [p[0]!, p[1]!];
  return { xy, blendshapes: c.blendshapes as Record<string, number>, matrix: c.matrix };
}

/**
 * Sharpness and exposure come from OpenCV's resize, whose rounding the port follows closely
 * but not bit for bit. The tolerance, relative (absolute for the glare fraction, a fraction
 * itself): sharpness 0.5 %, brightness 0.1 %, glare 0.001. Measured on these fixtures: at most
 * 0.07 %, 0.02 % and 0.0001. The other checks match to 1e-9.
 */
const PIXEL_TOLERANCE: Readonly<Record<string, number>> = { sharpness: 0.005, exposure_mean: 0.001, exposure_clipped_frac: 0.001 };

describe("the gate port's constants are the core's", () => {
  it("check order, expression hints, face oval and iris points", () => {
    expect([...CHECK_ORDER]).toEqual(fixture.constants.check_order);
    expect(EXPRESSION_HINTS).toEqual(fixture.constants.expression_hints);
    expect([...FACE_OVAL_RING]).toEqual(fixture.constants.face_oval_ring);
    expect(IRIS).toEqual(fixture.constants.iris);
  });

  it("the fixtures were made with the client-config's gates", () => {
    expect(gates.ipd_min_px).toBe(150);
    expect(Object.keys(fixture.images)).toEqual(["small", "x3", "x4", "dark", "bright", "blur", "cut"]);
  });
});

describe("the gate port reproduces quality.frontal_checks", () => {
  it.each((fixture.cases as Case[]).map((c) => [c.name, c] as const))("%s", (_, c) => {
    const img = images[c.image]!;
    const det = detection(c);
    const [x0, y0, x1, y1] = img.region;
    expect(faceBox(det.xy, img.width, img.height)).toEqual({ x0, y0, x1, y1 });
    const camera = c.camera as { focal_px: number; source: "calibration" } | null;
    const checks = frontalChecks(det, img, region(c.image), camera, gates, irisMm);
    const expected = c.expected;
    expect(checks.map((k) => k.id)).toEqual(expected.checks.map((k) => k.id));
    checks.forEach((got, i) => {
      const want = expected.checks[i]!;
      expect({ id: got.id, status: got.status, hint: got.hintKey, limit: got.limit }).toEqual({
        id: want.id,
        status: want.status,
        hint: want.hint_key,
        limit: want.limit,
      });
      if (want.value === null) expect(got.value).toBeNull();
      else if (got.id in PIXEL_TOLERANCE) {
        expect(Math.abs(got.value! - want.value) / Math.max(Math.abs(want.value), 1)).toBeLessThanOrEqual(PIXEL_TOLERANCE[got.id]!);
      } else expect(got.value).toBeCloseTo(want.value, 9);
    });
    const summary = summarize(checks);
    expect(summary).toEqual({ passed: expected.passed, hintKeys: expected.hint_keys, warnings: expected.warnings });
    expect(meshIrisPx(det)).toBeCloseTo(expected.iris_px, 9);
  });
});

describe("display smoothing is the core's One-Euro filter (webcam_capture.OneEuroFilter)", () => {
  it("gives the same values for noise, a jump and a timestamp going back", () => {
    const filter = new OneEuroFilter(fixture.one_euro.params);
    expect(fixture.one_euro.params).toEqual(config.frontal.guided_capture.one_euro);
    for (const { t, x, y } of fixture.one_euro.samples) expect(filter.filter(x, t)).toBeCloseTo(y, 12);
  });
});

// ------------------------------------------------------------------------------ helpers

type FixtureCase = (typeof fixture.cases)[number];
const byName = (name: string) => (fixture.cases as Case[]).find((c) => c.name === name)!;

/** A frame of the x4 image: its face region, and a detection from a fixture case. */
function fakeFrame(width = images.x4!.width, height = images.x4!.height) {
  const closed = { value: false };
  const frame: Frame = {
    width,
    height,
    image: { width, height } as ImageBitmap,
    region: () => region("x4"),
    encode: async () => new Blob([new Uint8Array(1000)], { type: "image/jpeg" }),
    close: () => {
      closed.value = true;
    },
  };
  return { frame, closed };
}

function scripted(cases: Array<FixtureCase | null | "two">, size?: { width: number; height: number }) {
  const frames: Array<ReturnType<typeof fakeFrame>> = [];
  let i = 0;
  const detector: FaceDetector = {
    detect: () => {
      const c = cases[Math.min(i - 1, cases.length - 1)];
      if (c === null || c === undefined) return [];
      if (c === "two") return [detection(byName("passes")), detection(byName("passes"))];
      return [detection(c as Case)];
    },
    close: () => undefined,
  };
  const source: FrameSource = {
    grab: async () => {
      i += 1;
      const f = fakeFrame(size?.width, size?.height);
      frames.push(f);
      return f.frame;
    },
  };
  return { detector, source, frames };
}

function loopWith(cases: Array<FixtureCase | null | "two">, over: Partial<typeof config> = {}) {
  const { detector, source, frames } = scripted(cases);
  const events = { statuses: [] as LiveStatus[], bursts: [] as KeptFrame[][], calibrated: [] as number[], tooLarge: 0, errors: 0 };
  let t = 0;
  const loop = new LiveLoop(
    { ...config, ...over },
    { detector, frames: source, nextFrame: () => () => undefined, now: () => (t += 33) },
    {
      onStatus: (s) => events.statuses.push(s),
      onBurst: (kept) => events.bursts.push(kept),
      onCalibrated: (f) => events.calibrated.push(f),
      onTooLarge: () => (events.tooLarge += 1),
      onError: () => (events.errors += 1),
    },
  );
  loop.start();
  return { loop, events, frames };
}

describe("auto-capture (webcam_capture.GuidedCapture)", () => {
  const needed = config.frontal.guided_capture.consecutive_pass_frames;
  const keep = config.frontal.burst.recommended_frames;

  it("keeps the sharpest frames of a run; a failed frame starts the run over and frees the frames", () => {
    const released: number[] = [];
    const streak = new Streak<number>(4, 2, (f) => released.push(f));
    expect(streak.update(true, 1, 10)).toBe(false);
    expect(streak.update(true, 2, 30)).toBe(false);
    expect(streak.update(true, 3, 20)).toBe(false); // 1 is the least sharp: released
    expect(released).toEqual([1]);
    expect(streak.update(false, 4, 99)).toBe(false); // the run ends: its frames go too
    expect(released.sort()).toEqual([1, 2, 3, 4]);
    for (const [f, s] of [[5, 5], [6, 50], [7, 40]] as const) streak.update(true, f, s);
    expect(streak.update(true, 8, 45)).toBe(true);
    expect(streak.take().map((k) => k.frame)).toEqual([6, 8]); // capture order
    expect(streak.streak).toBe(0);
  });

  it("keeps burst.recommended_frames, within the burst, frame and pixel limits", () => {
    expect(framesToKeep(config, 3840, 2160)).toBe(keep);
    expect(keep).toBe(7);
    const tight = { ...config, upload_limits: { ...config.upload_limits, max_burst_pixels: 4 * 3840 * 2160 } };
    expect(framesToKeep(tight, 3840, 2160)).toBe(4);
    const none = { ...config, upload_limits: { ...config.upload_limits, max_burst_pixels: 2 * 3840 * 2160 } };
    expect(framesToKeep(none, 3840, 2160)).toBeNull(); // fewer than burst.min_frames (3) fit
  });

  it("drops the least sharp frames until the request fits, keeping capture order", () => {
    const limits = { ...config.upload_limits, max_request_bytes: 10_000_000 + REQUEST_OVERHEAD_BYTES, max_image_bytes: 4_000_000 };
    const frames = [30, 10, 50, 20, 40].map((score, i) => ({ id: i, bytes: 3_000_000, score }));
    const fit = fitBurst(frames, limits, 3);
    expect(fit).toEqual({ ok: true, frames: [frames[0], frames[2], frames[4]] });
    expect(fitBurst(frames, { ...limits, max_request_bytes: 5_000_000 }, 3)).toEqual({ ok: false, problem: "too_few_frames" });
    expect(fitBurst([{ bytes: 5_000_000, score: 1 }], limits, 1)).toEqual({ ok: false, problem: "frame_too_large" });
  });

  it("fires after consecutive_pass_frames passing frames and hands over the kept frames", async () => {
    const { loop, events, frames } = loopWith(Array(needed).fill(byName("passes")));
    for (let i = 0; i < needed; i++) await loop.step();
    expect(events.bursts).toHaveLength(1);
    const burst = events.bursts[0]!;
    expect(burst).toHaveLength(keep);
    expect(burst.every((k) => !frames.find((f) => f.frame === k.frame)!.closed.value)).toBe(true);
    // Every other frame was freed.
    expect(frames.filter((f) => f.closed.value)).toHaveLength(needed - keep);
    expect(events.statuses.at(-1)).toMatchObject({ hint: null, streak: needed, needed });
  });

  it("shows the first failing hint in the core's order, and starts over when a gate fails", async () => {
    const { loop, events } = loopWith([byName("passes"), byName("passes"), byName("mouth_open"), null, "two", byName("passes")]);
    for (let i = 0; i < 6; i++) await loop.step();
    expect(events.statuses.map((s) => [s.hint, s.streak])).toEqual([
      [null, 1],
      [null, 2],
      ["hint.close_mouth", 0],
      ["hint.no_face", 0],
      ["hint.multiple_faces", 0],
      [null, 1],
    ]);
    expect(events.bursts).toHaveLength(0);
  });

  it("sends the calibrated focal length with the gates: then the distance is checked", async () => {
    const { loop, events } = loopWith([byName("passes")]);
    loop.camera = { focal_px: 0.8 * byName("passes").camera!.focal_px / 1.5, source: "calibration" };
    await loop.step();
    expect(events.statuses[0]!.hint).toBe("hint.move_back");
  });
});

describe("calibration", () => {
  it("is the inverse of the core's distance: at the measured distance the check reads that distance", () => {
    const c = byName("passes");
    const focal = focalFromIris(c.expected.iris_px, 1.5, irisMm);
    expect(focal).toBeCloseTo(c.camera!.focal_px, 9);
    const distance = c.expected.checks.find((k) => k.id === "camera_distance_m")!.value;
    expect(distance).toBeCloseTo(1.5, 9);
  });

  it("averages the iris over 30 frames, and ignores frames without one", () => {
    const cal = new Calibration();
    expect(CALIBRATION_FRAMES).toBe(30);
    for (let i = 0; i < 29; i++) cal.add(i % 2 ? 11 : 13);
    cal.add(0);
    expect(cal.done).toBe(false);
    expect(cal.focalPx(1.5, irisMm)).toBeNull();
    cal.add(12);
    expect(cal.focalPx(1.5, irisMm)).toBeCloseTo(focalFromIris((14 * 11 + 15 * 13 + 12) / 30, 1.5, irisMm), 9);
  });

  it("counts frames that pass every gate, with the distance left unverified meanwhile", async () => {
    const { loop, events } = loopWith(Array(CALIBRATION_FRAMES + 5).fill(byName("passes")));
    loop.camera = { focal_px: 1, source: "calibration" }; // a wrong one: the calibration must not use it
    loop.calibrate();
    for (let i = 0; i < CALIBRATION_FRAMES; i++) await loop.step();
    expect(events.bursts).toHaveLength(0); // no capture while calibrating
    expect(events.statuses.at(-1)!.calibration).toEqual({ count: CALIBRATION_FRAMES, of: CALIBRATION_FRAMES });
    expect(events.calibrated).toHaveLength(1);
    expect(events.calibrated[0]).toBeCloseTo(focalFromIris(byName("passes").expected.iris_px, 1.5, irisMm), 6);
    expect(loop.calibrating).toBe(false);
  });

  it("is saved on the device per camera, resolution (either way round) and zoom", () => {
    const setup = { camera: "cam-1", width: 2160, height: 3840, zoom: 2 };
    expect(loadCalibration(setup)).toBeNull();
    saveCalibration(setup, 3200);
    expect(loadCalibration({ ...setup, width: 3840, height: 2160 })).toBe(3200);
    expect(loadCalibration({ ...setup, zoom: 1 })).toBeNull();
    expect(loadCalibration({ ...setup, width: 1920, height: 1080 })).toBeNull();
    expect(Object.keys({ ...window.localStorage })).toEqual([STORAGE_KEYS.calibration]);
    window.localStorage.setItem(STORAGE_KEYS.calibration, "not json");
    expect(loadCalibration(setup)).toBeNull();
  });

  it("warns when the face cannot reach the face-size gate at the recommended distance", () => {
    expect(TYPICAL_IPD_MM).toBe(fixture.constants.typical_ipd_mm);
    // A 1080p webcam: about 60 px between the pupils at 1.5 m.
    expect(faceSizeAt(assumedFocalPx(1920, 1080, 1), gates)).toMatchObject({ reachable: false });
    expect(Math.round(faceSizeAt(assumedFocalPx(1920, 1080, 1), gates).ipdPx)).toBe(58);
    // A 4K phone stream at 2× zoom: about 230 px.
    expect(faceSizeAt(assumedFocalPx(2160, 3840, 2), gates)).toMatchObject({ reachable: true });
    // A calibration gives the real value.
    expect(faceSizeAt(3000, gates).ipdPx).toBeCloseTo((3000 * 63) / 1500, 9);
  });
});

describe("the hint on screen", () => {
  const params = config.frontal.guided_capture.one_euro;
  const checksOf = (name: string) => frontalChecks(detection(byName(name)), images.x4!, region("x4"), null, gates, irisMm);

  it("is the first failing hint in the core's order", () => {
    const display = new HintDisplay(gates, params);
    expect(display.update(checksOf("no_blendshapes"), 0)).toBe("hint.close_mouth");
    expect(display.update([faceCountCheck(0)], 0.03)).toBe("hint.no_face");
    expect(display.update(checksOf("passes"), 0.06)).toBeNull();
  });

  it("smooths the pose, so one outlying frame does not change the hint", () => {
    const display = new HintDisplay(gates, params);
    const level = byName("passes");
    // The level head turned 8° to the image right: over the 5° limit.
    const [c, s] = [Math.cos((8 * Math.PI) / 180), Math.sin((8 * Math.PI) / 180)];
    const ry = [[c, 0, s], [0, 1, 0], [-s, 0, c]];
    const turned = level.matrix.map((row, r) => row.map((v, k) => (r < 3 && k < 3 ? ry[r]!.reduce((sum, a, j) => sum + a * level.matrix[j]![k]!, 0) : v)));
    for (let i = 0; i < 10; i++) expect(display.update(checksOf("passes"), i / 30)).toBeNull();
    // One such frame shows no hint: the smoothed yaw stays within the limit.
    const once = frontalChecks({ ...detection(level), matrix: turned }, images.x4!, region("x4"), null, gates, irisMm);
    expect(poseFromMatrix(turned).yawDeg).toBeGreaterThan(gates.yaw_max_deg);
    expect(display.update(once, 10 / 30)).toBeNull();
    // Held, it shows.
    let hint: string | null = null;
    for (let i = 11; i < 40; i++) hint = display.update(once, i / 30);
    expect(hint).toBe("hint.turn_right");
  });

  it("is announced once it has held, and the same one again only after a while", () => {
    const steady = new Steady<string>(1000, 5000);
    expect(steady.update("a", 0)).toBeUndefined();
    expect(steady.update("a", 900)).toBeUndefined();
    expect(steady.update("a", 1000)).toBe("a");
    expect(steady.update("a", 2000)).toBeUndefined();
    expect(steady.update("b", 2100)).toBeUndefined();
    expect(steady.update("a", 2200)).toBeUndefined(); // back to a: held again, but said recently
    expect(steady.update("a", 3300)).toBeUndefined();
    expect(steady.update("a", 6100)).toBe("a");
    // Said by other means (from a tap): not repeated at once.
    steady.mark("b", 7000);
    expect(steady.update("b", 7100)).toBeUndefined();
    expect(steady.update("b", 8200)).toBeUndefined();
    expect(steady.update("b", 12_100)).toBe("b");
  });
});

describe("MediaPipe's output in the browser", () => {
  it("matrices are column-major: row-major here, with the translation in the last column", () => {
    const rows = [
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9, 10, 11, 12],
      [0, 0, 0, 1],
    ];
    const data = [0, 1, 2, 3].flatMap((c) => rows.map((r) => r[c]!));
    expect(matrixRows({ rows: 4, columns: 4, data })).toEqual(rows);
    expect(matrixRows(undefined)).toEqual([
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ]);
  });

  it("landmarks become frame pixels, as the core's _convert makes them", () => {
    const small = images.small!;
    const result = {
      faceLandmarks: [small.xy.map(([x, y]) => ({ x: x! / small.width, y: y! / small.height, z: 0, visibility: 0 }))],
      faceBlendshapes: [{ categories: [{ categoryName: "jawOpen", score: 0.25, index: 0, displayName: "" }], headIndex: 0, headName: "" }],
      facialTransformationMatrixes: [],
    };
    const [det] = detections(result, small.width, small.height);
    expect(det!.xy[468]![0]).toBeCloseTo(small.xy[468]![0]!, 9);
    expect(det!.blendshapes).toEqual({ jawOpen: 0.25 });
    expect(() => detections({ ...result, faceLandmarks: [result.faceLandmarks[0]!.slice(0, 468)] }, 1, 1)).toThrow(/478/);
  });
});

describe("the frame loop", () => {
  it("keeps one chain of frame callbacks when stopped and started while a frame is processed", async () => {
    const pending: Array<() => void> = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let grabs = 0;
    const source: FrameSource = {
      grab: async () => {
        grabs += 1;
        if (grabs === 1) await slow; // the first frame is still being processed
        return fakeFrame().frame;
      },
    };
    const noop = () => undefined;
    const loop = new LiveLoop(
      config,
      {
        detector: { detect: () => [], close: noop },
        frames: source,
        nextFrame: (cb) => {
          pending.push(cb);
          return () => pending.splice(pending.indexOf(cb), 1);
        },
        now: () => 0,
      },
      { onStatus: noop, onBurst: noop, onCalibrated: noop, onTooLarge: noop, onError: noop },
    );
    loop.start();
    pending.shift()!(); // frame 1 starts and waits
    loop.stop(); // a zoom change…
    loop.start(); // …and back
    expect(pending).toHaveLength(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(1); // the finished frame did not add a second chain
  });

  it("stops and reports a detector that fails on every frame", async () => {
    const { detector, source } = scripted([null]);
    const errors: number[] = [];
    const pending: Array<() => void> = [];
    const loop = new LiveLoop(
      config,
      {
        detector: { ...detector, detect: () => { throw new Error("lost context"); } },
        frames: source,
        nextFrame: (cb) => {
          pending.push(cb);
          return () => undefined;
        },
        now: () => 0,
      },
      { onStatus: () => undefined, onBurst: () => undefined, onCalibrated: () => undefined, onTooLarge: () => undefined, onError: () => errors.push(1) },
    );
    loop.start();
    for (let i = 0; i < MAX_FAILED_FRAMES + 5 && pending.length > 0; i++) {
      pending.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(errors).toHaveLength(1);
    expect(pending).toHaveLength(0); // stopped
  });
});

describe("switching cameras", () => {
  it("goes to the next camera by id, round, and by facing when the browser lists no ids", () => {
    expect(nextCameraId(["a", "b", "c"], "a")).toBe("b");
    expect(nextCameraId(["a", "b", "c"], "c")).toBe("a");
    expect(nextCameraId(["a", "b"], "unknown")).toBe("a");
    expect(nextCameraId(["", ""], "")).toBeNull(); // before permission, ids are empty
    expect(nextCameraId(["a"], "a")).toBeNull();
  });
});

