/**
 * Live mode through the real app, with the camera, MediaPipe and video
 * frames faked: the detections are the core's fixture cases (fixtures/live_gates.json) and
 * the frames carry the fixture's face region, so the real gate port, auto-capture and burst
 * code run. The API is mocked from the core's fixtures.
 */
import { join } from "node:path";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/live_gates.json" with { type: "json" };
import configEn from "../fixtures/client_config.en.json" with { type: "json" };
import { STORAGE_KEYS } from "../src/app/storage";
import { saveCalibration } from "../src/capture/live/calibration";
import { CameraError, type Camera, type CameraProblem, type Facing } from "../src/capture/live/camera";
import type { FaceDetector } from "../src/capture/live/detector";
import type { Frame } from "../src/capture/live/frames";
import type { Detection } from "../src/capture/live/gates";
import type { LiveServices } from "../src/capture/live/services";
import { fixtureBytes, newCalls, scanHandlers, type AnalysisOutcome } from "./mocks/handlers";
import { server } from "./mocks/server";
import { WEB } from "./paths";
import { readPng } from "./png";
import { renderApp } from "./renderApp";

type Case = (typeof fixture.cases)[number] & { xy_patch?: Record<string, number[]> };
const x4 = fixture.images.x4;
const region = readPng(join(WEB, "fixtures", "live", "x4.png"));

function detection(name: string): Detection {
  const c = (fixture.cases as Case[]).find((k) => k.name === name)!;
  return { xy: x4.xy.map((p) => [p[0]!, p[1]!] as const), blendshapes: c.blendshapes as Record<string, number>, matrix: c.matrix };
}

/** What the fake camera sees; the test changes it as the person would move ("broken": the detector throws). */
type Scene = "nobody" | "passes" | "mouth_open" | "broken";

interface Fake extends LiveServices {
  scene: Scene;
  size: { width: number; height: number };
  opened: Array<{ facing: Facing; deviceId?: string }>;
  closed: number;
  grabbed: number;
  failOpen: CameraProblem | null;
  /** While set, encoding a frame waits for it (the "preparing" state). */
  encodeGate: Promise<void> | null;
  /** The fake clock (ms): 33 more at every reading. */
  clock: number;
}

function fakeLive(): Fake {
  const fake: Fake = {
    clock: 0,
    scene: "nobody",
    size: { width: x4.width, height: x4.height },
    opened: [],
    closed: 0,
    grabbed: 0,
    failOpen: null,
    encodeGate: null,
    supported: () => true,
    async openCamera(facing, deviceId) {
      if (fake.failOpen) throw new CameraError(fake.failOpen);
      fake.opened.push({ facing, deviceId });
      const track = { stop: () => undefined } as unknown as MediaStreamTrack;
      const stream = { getTracks: () => [track] } as unknown as MediaStream;
      const id = deviceId ?? "fake-camera";
      return { stream, track, facing, deviceId: id, zoomRange: { min: 1, max: 5, step: 0.1 }, zoom: 2 } satisfies Camera;
    },
    closeCamera: () => {
      fake.closed += 1;
    },
    async setZoom(camera, zoom) {
      camera.zoom = zoom;
    },
    cameraIds: async () => ["fake-camera", "fake-camera-2"],
    async createDetector(): Promise<FaceDetector> {
      return {
        detect: () => {
          if (fake.scene === "broken") throw new Error("the GPU context was lost");
          return fake.scene === "nobody" ? [] : [detection(fake.scene)];
        },
        close: () => undefined,
      };
    },
    frames: () => ({
      async grab(): Promise<Frame> {
        fake.grabbed += 1;
        const { width, height } = fake.size;
        return {
          width,
          height,
          image: { width, height } as ImageBitmap,
          region: () => ({ data: region.data, width: region.width, height: region.height, channels: 3, left: x4.region[0]!, top: x4.region[1]! }),
          encode: async () => {
            await fake.encodeGate;
            return new Blob([new Uint8Array(fixtureBytes("photo.jpg"))], { type: "image/jpeg" });
          },
          close: () => undefined,
        };
      },
    }),
    nextFrame(_video, callback) {
      const id = setTimeout(callback, 0);
      return () => clearTimeout(id);
    },
    now: () => (fake.clock += 33),
  };
  return fake;
}

beforeEach(() => {
  // jsdom has no media playback.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function toLive(outcomes: AnalysisOutcome[] = ["ok"], fake = fakeLive()) {
  const calls = newCalls();
  server.use(...scanHandlers({ outcomes, calls }));
  window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "female", age: 21 }));
  const user = userEvent.setup();
  await renderApp("/subject", { language: "en", live: fake });
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await user.click(await screen.findByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title });
  await user.click(screen.getByRole("button", { name: "Take a photo" }));
  await screen.findByRole("heading", { level: 1, name: "Live camera" });
  return { user, calls, fake };
}

const hint = () => screen.getByTestId("live-hint");

describe("live mode", () => {
  it("states its limits, then hints, captures a burst by itself and analyzes it", async () => {
    const { user, calls, fake } = await toLive();
    // Before the camera starts: the limits (face size, the report's topics and the calibration, side photo).
    const before = within(screen.getByRole("region", { name: "Before you start" })).getAllByRole("listitem");
    expect(before.map((li) => li.textContent)).toEqual([
      "Put the phone on a stand at eye level about 1.5 m away, or have a helper hold it there. Use the rear camera if you can.",
      expect.stringContaining("most laptop webcams"),
      expect.stringMatching(/^The report will have no discussion topics.* measure 1\.5 m from the camera with a tape measure/),
      expect.stringContaining("side photo"),
    ]);
    expect(fake.opened).toEqual([]); // no camera until asked

    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    expect(await screen.findByLabelText("Camera view")).toBeInTheDocument();
    // Nobody in view: the core's hint, verbatim, large.
    await waitFor(() => expect(hint()).toHaveTextContent(configEn.strings.hint.no_face));
    expect(fake.opened).toEqual([{ facing: "environment", deviceId: undefined }]);
    // Without a calibration: the distance cannot be checked.
    expect(screen.getByTestId("live-distance")).toHaveTextContent("no discussion topics until the distance is calibrated");
    // Zoom (the camera's range) and switching are offered.
    expect(screen.getByRole("radio", { name: "2×" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Switch camera" })).toBeInTheDocument();

    fake.scene = "mouth_open";
    await waitFor(() => expect(hint()).toHaveTextContent(configEn.strings.hint.close_mouth));

    // Every gate passes: hold still, and after a run of frames the burst is taken and sent.
    fake.scene = "passes";
    await screen.findByRole("heading", { level: 1, name: "Front photo results" }, { timeout: 5000 });
    expect(calls.analyze).toHaveLength(1);
    const sent = calls.analyze[0]!;
    expect(sent.frames.map((f) => f.name)).toEqual(Array.from({ length: 7 }, (_, i) => `live-${i + 1}.jpg`));
    expect(sent.frames.every((f) => f.type === "image/jpeg")).toBe(true);
    expect(sent.meta).toEqual({
      subject: { sex: "female", age: 21 },
      locale: "en",
      overlay: { layers: ["landmarks", "thirds", "fifths", "eyes_brows", "nose_lips", "labels"] },
    });
    expect(fake.closed).toBeGreaterThan(0); // the camera is off once the photos are taken
  });

  it("sends a saved calibration as the camera's focal length", async () => {
    const fake = fakeLive();
    saveCalibration({ camera: "fake-camera", width: x4.width, height: x4.height, zoom: 2 }, 5000);
    const { user, calls } = await toLive(["ok"], fake);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    await waitFor(() => expect(screen.getByTestId("live-calibrated")).toHaveTextContent("checked with this camera's calibration"));
    expect(screen.queryByTestId("live-distance")).toBeNull();
    fake.scene = "passes";
    await screen.findByRole("heading", { level: 1, name: "Front photo results" }, { timeout: 5000 });
    expect(calls.analyze[0]!.meta.camera).toEqual({ focal_px: 5000, source: "calibration" });
  });

  it("calibrates at the measured distance and keeps the result for this camera, size and zoom", async () => {
    const { user, fake, calls } = await toLive();
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    await user.click(await screen.findByRole("button", { name: "Calibrate the distance" }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Calibrate the distance" });
    expect(heading).toHaveFocus();
    expect(screen.getByText("Measure 1.5 m from the camera to where the person will stand, with a tape measure.")).toBeInTheDocument();
    fake.scene = "passes";
    await screen.findByText("The camera is calibrated. The distance is now checked for this camera, resolution and zoom.", undefined, { timeout: 5000 });
    expect(calls.analyze).toHaveLength(0); // nothing was captured while calibrating
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEYS.calibration)!) as Record<string, { focal_px: number }>;
    expect(Object.keys(saved)).toEqual([`fake-camera|${x4.width}x${x4.height}|2`]);
    const iris = (fixture.cases as Case[]).find((c) => c.name === "passes")!.expected.iris_px;
    expect(Object.values(saved)[0]!.focal_px).toBeCloseTo((iris * 1500) / configEn.frontal.iris_diameter_mm, 6);
    // Only the allowed keys are on the device.
    expect(Object.keys({ ...window.localStorage }).sort()).toEqual([STORAGE_KEYS.calibration, STORAGE_KEYS.subject].sort());
  });

  it("warns when the stream cannot show the face large enough at the recommended distance", async () => {
    const fake = fakeLive();
    fake.size = { width: 1280, height: 720 };
    const { user } = await toLive(["ok"], fake);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    const warning = await screen.findByTestId("live-face-size");
    expect(warning).toHaveTextContent("At about 1.5 m this camera probably cannot show the face large enough to measure");
    expect(warning).toHaveTextContent("150 px are needed");
    await user.click(screen.getByRole("button", { name: "Choose a photo instead" }));
    await screen.findByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title });
    expect(fake.closed).toBeGreaterThan(0); // leaving stops the camera
  });

  it("explains a refused camera and offers to try again or use photo mode", async () => {
    const fake = fakeLive();
    fake.failOpen = "denied";
    const { user } = await toLive(["ok"], fake);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The browser did not allow the camera.");
    fake.failOpen = null;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(hint()).toHaveTextContent(configEn.strings.hint.no_face));
  });

  it("a burst that does not pass is taken again with the live camera", async () => {
    const { user, fake } = await toLive(["quality_failed", "ok"]);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    fake.scene = "passes";
    await screen.findByRole("heading", { level: 1, name: "Please take the photo again" }, { timeout: 5000 });
    fake.scene = "nobody";
    await user.click(screen.getByRole("button", { name: "Take a photo" }));
    await screen.findByRole("heading", { level: 1, name: "Live camera" });
  });

  it("the side photo's “Take a photo” opens the camera app: live mode is for the front photo", async () => {
    const { user, fake } = await toLive();
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    fake.scene = "passes";
    await screen.findByRole("heading", { level: 1, name: "Front photo results" }, { timeout: 5000 });
    await user.click(screen.getByRole("link", { name: "Add a side photo" }));
    await screen.findByRole("heading", { level: 1, name: configEn.strings.capture.profile.title });
    const cameraApp = vi.spyOn(screen.getByTestId("input-camera"), "click");
    await user.click(screen.getByRole("button", { name: "Take a photo" }));
    expect(cameraApp).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1, name: configEn.strings.capture.profile.title })).toBeInTheDocument();
  });

  it("reads the hint aloud once it holds, with a voice for the language", async () => {
    const fake = fakeLive();
    const said: Array<{ text: string; lang: string; at: number }> = [];
    vi.stubGlobal("speechSynthesis", {
      getVoices: () => [{ lang: "en-GB", name: "Test voice" }],
      speak: (u: { text: string; lang: string }) => said.push({ text: u.text, lang: u.lang, at: fake.clock }),
      cancel: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    vi.stubGlobal("SpeechSynthesisUtterance", class {
      lang = "";
      voice: unknown = null;
      constructor(readonly text: string) {}
    });
    const { user } = await toLive(["ok"], fake);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    const box = await screen.findByRole("checkbox", { name: "Read the hints aloud" });
    await user.click(box);
    // At once, from the tap (iOS needs a first utterance from a user's action)…
    expect(said[0]).toMatchObject({ text: configEn.strings.hint.no_face, lang: "en-GB" });
    // …then while it holds.
    await waitFor(() => expect(said.length).toBeGreaterThanOrEqual(2), { timeout: 5000 });
    // Not every frame: the same hint again only after 6 s (on the screen's clock).
    for (let i = 1; i < said.length; i++) expect(said[i]!.at - said[i - 1]!.at).toBeGreaterThanOrEqual(6000);
  });

  it("without a voice for the language, reading aloud is off and says why", async () => {
    const { user } = await toLive();
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    const box = await screen.findByRole("checkbox", { name: "Read the hints aloud" });
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleDescription("This device has no English voice to read the hints aloud.");
  });
});

describe("live mode's edges", () => {
  it("shows the photos being prepared, and drops them when the screen is left meanwhile", async () => {
    const fake = fakeLive();
    let open!: () => void;
    fake.encodeGate = new Promise((resolve) => (open = resolve));
    const { user, calls } = await toLive(["ok"], fake);
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    fake.scene = "passes";
    expect(await screen.findByText("Preparing the photos: 0 of 7", undefined, { timeout: 5000 })).toHaveAttribute("role", "status");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title });
    open();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    // Nothing was analyzed, and the guide is still showing.
    expect(calls.analyze).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title })).toBeInTheDocument();
  });

  it("switches to the next camera by id (a laptop's webcams have no facing)", async () => {
    const { user, fake } = await toLive();
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    await user.click(await screen.findByRole("button", { name: "Switch camera" }));
    await waitFor(() => expect(fake.opened.at(-1)).toEqual({ facing: "environment", deviceId: "fake-camera-2" }));
    await waitFor(() => expect(hint()).toHaveTextContent(configEn.strings.hint.no_face));
    // And back to the first.
    await user.click(screen.getByRole("button", { name: "Switch camera" }));
    await waitFor(() => expect(fake.opened.at(-1)).toEqual({ facing: "environment", deviceId: "fake-camera" }));
  });

  it("says so when the face detection keeps failing, and starts again with a new detector", async () => {
    const fake = fakeLive();
    const created = vi.spyOn(fake, "createDetector");
    const { user } = await toLive(["ok"], fake);
    fake.scene = "broken";
    await user.click(screen.getByRole("button", { name: "Start the camera" }));
    expect(await screen.findByRole("alert", undefined, { timeout: 5000 })).toHaveTextContent("The face detection stopped working.");
    fake.scene = "nobody";
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(hint()).toHaveTextContent(configEn.strings.hint.no_face));
    expect(created).toHaveBeenCalledTimes(2);
  });
});

describe("live mode is offered only where the browser can show a camera", () => {
  it("“Take a photo” on the guide opens the camera app, and the screen says so if opened", async () => {
    const fake = fakeLive();
    fake.supported = () => false;
    server.use(...scanHandlers({}));
    window.localStorage.setItem(STORAGE_KEYS.subject, JSON.stringify({ sex: "female", age: 21 }));
    const user = userEvent.setup();
    await renderApp("/subject", { language: "en", live: fake });
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title });
    const cameraApp = vi.spyOn(screen.getByTestId("input-camera"), "click");
    await user.click(screen.getByRole("button", { name: "Take a photo" }));
    expect(cameraApp).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { level: 1, name: configEn.strings.capture.frontal.title })).toBeInTheDocument();
    window.location.hash = "#/scan/frontal/live";
    expect(await screen.findByRole("alert")).toHaveTextContent("This browser cannot show the camera on a page.");
    expect(screen.queryByRole("button", { name: "Start the camera" })).toBeNull();
  });
});
