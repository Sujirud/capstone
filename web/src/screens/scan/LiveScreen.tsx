/**
 * Live mode (milestone 5), for the front photo only: the camera on the page,
 * the core's hints one at a time while the person gets into position, and automatic capture
 * once every gate has passed for a run of frames. The burst is then analyzed like a photo.
 *
 * Its limits are stated before the camera starts and while it runs: the face size a stream
 * can reach, and the distance, which cannot be checked without the optional calibration (the
 * report then has no topics). The server runs every gate again.
 *
 * The hint is shown large, for reading from about 1.5 m, and can be read aloud. Screen
 * readers hear a hint once it has held for a moment, not every change.
 */
import { SwitchCamera } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import type { ClientConfig } from "../../api/schemas";
import { useLiveServices } from "../../app/services";
import { assumedFocalPx, CALIBRATION_FRAMES, faceSizeAt } from "../../capture/live/calibration";
import { Steady } from "../../capture/live/display";
import { hintName } from "../../capture/live/gates";
import type { LiveStatus } from "../../capture/live/loop";
import { speak, stopSpeaking, voiceFor, watchVoices } from "../../capture/live/speech";
import { Screen } from "../../components/layout/Screen";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { cx } from "../../components/ui/cx";
import { ICON } from "../../components/ui/icon";
import { Notice } from "../../components/ui/Notice";
import { ProgressLine } from "../../components/ui/ProgressLine";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { currentLanguage } from "../../i18n";
import { useScan } from "../../scan/ScanContext";
import { scanPath } from "../paths";
import { step } from "../steps";
import { useLiveCamera } from "./useLiveCamera";

/** A hint is announced or spoken once it has held this long, and the same one again only after a while. */
const ANNOUNCE = { holdMs: 1500, repeatMs: 10_000 };
const SPEAK = { holdMs: 1200, repeatMs: 6000 };

export function LiveScreen({ config }: { config: ClientConfig }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const scan = useScan();
  const live = useLiveServices();
  const language = currentLanguage();
  const gates = config.frontal.gates;
  const distance = gates.camera_distance_recommended_m;
  const calibrationId = useId();
  const calibrationHeading = useRef<HTMLHeadingElement>(null);

  const [announced, setAnnounced] = useState("");
  const [calibratedNow, setCalibratedNow] = useState(false);
  const [speakHints, setSpeakHints] = useState(false);
  // Voices can load after the page: read them again when the list changes.
  const [, setVoices] = useState(0);
  useEffect(() => watchVoices(() => setVoices((n) => n + 1)), []);
  const voice = voiceFor(language);
  useEffect(() => stopSpeaking, []);

  const hintText = (s: LiveStatus | null): string | null => {
    if (!s) return null;
    if (s.hint) return config.strings.hint[hintName(s.hint)] ?? null;
    return s.calibration ? null : t("live.holdStill");
  };

  // Announcements and speech follow the hint only once it holds (see Steady).
  const announcer = useRef(new Steady<string>(ANNOUNCE.holdMs, ANNOUNCE.repeatMs));
  const speaker = useRef(new Steady<string>(SPEAK.holdMs, SPEAK.repeatMs));
  const latest = useRef({ hintText, speakHints, voice, language });
  useEffect(() => {
    latest.current = { hintText, speakHints, voice, language };
  });

  const { videoRef, ...cam } = useLiveCamera(config, {
    onStatus(s) {
      const { hintText, speakHints, voice, language } = latest.current;
      const text = hintText(s) ?? "";
      const now = live.now();
      const announce = announcer.current.update(text, now);
      if (announce) setAnnounced(announce);
      const say = speaker.current.update(text, now);
      if (say && speakHints && voice) speak(say, language, voice);
    },
    onCaptured(capture) {
      stopSpeaking();
      scan.selectBurst(capture);
      navigate(scanPath("frontal", "analyzing"), { replace: true });
    },
    onCalibrated() {
      setCalibratedNow(true);
    },
  });
  const { phase, status } = cam;

  useEffect(() => {
    if (cam.calibrating) calibrationHeading.current?.focus();
  }, [cam.calibrating]);

  if (scan.state.subject === null) return <Navigate to="/subject" replace />;

  const toGuide = () => navigate(scanPath("frontal", "guide"));
  const photoMode = (
    <Button key="photo" variant="secondary" onClick={toGuide}>
      {t("live.photoMode")}
    </Button>
  );
  const camera = phase.kind === "starting" || phase.kind === "running";
  const problem = phase.kind === "problem" ? phase.problem : null;
  const retryable = problem !== null && problem !== "unsupported";

  let actions = <>{photoMode}</>;
  if (phase.kind === "idle")
    actions = (
      <>
        {photoMode}
        <Button variant="primary" onClick={cam.start}>
          {t("live.start")}
        </Button>
      </>
    );
  else if (retryable)
    actions = (
      <>
        {photoMode}
        <Button variant="primary" onClick={cam.start}>
          {t("live.tryAgain")}
        </Button>
      </>
    );
  else if (cam.calibrating)
    actions = (
      <Button variant="secondary" onClick={cam.cancelCalibration}>
        {t("live.calibration.cancel")}
      </Button>
    );
  else if (phase.kind === "preparing") actions = <></>;

  // Whether the face can be large enough at the recommended distance (warn, suggest photo mode).
  const reach =
    status && status.width > 0 ? faceSizeAt(cam.focalPx ?? assumedFocalPx(status.width, status.height, cam.zoom), gates) : null;
  const text = hintText(status);
  const calibration = status?.calibration ?? { count: 0, of: CALIBRATION_FRAMES };

  return (
    <Screen
      title={t("live.title")}
      step={step(t, "frontal")}
      onBack={toGuide}
      actions={phase.kind === "preparing" ? undefined : actions}
    >
      {phase.kind === "idle" && <Intro distance={distance} />}

      {problem && (
        <Notice role="alert" className="mb-6">
          <p>{t(`live.problem.${problem}`)}</p>
        </Notice>
      )}

      {(camera || phase.kind === "preparing") && (
        <>
          <div className={cx("overflow-hidden rounded-viewer bg-viewer", phase.kind === "preparing" && "hidden")}>
            {/* The front camera's preview is mirrored like a mirror; the frames never are. */}
            <video
              ref={videoRef}
              muted
              playsInline
              aria-label={t("live.cameraView")}
              data-testid="live-video"
              className={cx("mx-auto block max-h-[60dvh] w-full object-contain", cam.facing === "user" && "-scale-x-100")}
            />
          </div>

          <div className="mt-4" data-testid="live-hint">
            {phase.kind === "starting" && <p role="status">{t("live.starting")}</p>}
            {phase.kind === "running" && !status && <p role="status">{t("live.loading")}</p>}
            {phase.kind === "running" && status && (
              <>
                <p lang={config.locale} className="min-h-[calc(2*var(--leading-heading)*var(--fs-2xl))] text-2xl font-semibold">
                  {text}
                </p>
                {!status.hint && !status.calibration && <ProgressLine value={status.streak / status.needed} className="mt-2" />}
              </>
            )}
            {phase.kind === "preparing" && (
              <>
                <p role="status">{t("live.preparing", { done: phase.done, of: phase.of })}</p>
                <ProgressLine value={phase.done / phase.of} className="mt-2" />
              </>
            )}
            <p aria-live="polite" className="sr-only">
              {announced}
            </p>
          </div>

          {phase.kind === "running" && cam.calibrating && (
            <section aria-labelledby={calibrationId} className="mt-6 border-t border-line pt-6">
              <h2 id={calibrationId} ref={calibrationHeading} tabIndex={-1} className="mb-2 text-xl">
                {t("live.calibration.heading")}
              </h2>
              <ol className="mb-4 list-decimal space-y-2 pl-6">
                <li>{t("live.calibration.measure", { distance })}</li>
                <li>{t("live.calibration.stand")}</li>
              </ol>
              <p role="status" className="tabular-nums">
                {t("live.calibration.progress", { count: calibration.count, of: calibration.of })}
              </p>
              <ProgressLine value={calibration.count / calibration.of} className="mt-2" />
            </section>
          )}

          {phase.kind === "running" && !cam.calibrating && (
            <div className="mt-6 grid gap-6">
              <div className="flex flex-wrap items-center gap-4">
                {cam.zoomOptions.length > 1 && (
                  <SegmentedControl
                    label={t("live.zoom")}
                    options={cam.zoomOptions.map((z) => ({ value: String(z), label: `${z}×` }))}
                    value={String(nearest(cam.zoomOptions, cam.zoom))}
                    onChange={(v) => void cam.changeZoom(Number(v))}
                  />
                )}
                {cam.canSwitch && (
                  <Button variant="secondary" onClick={cam.switchCamera}>
                    <SwitchCamera {...ICON} size={20} />
                    {t("live.switchCamera")}
                  </Button>
                )}
              </div>
              <Checkbox
                label={t("live.speak")}
                checked={speakHints && voice !== null}
                disabled={voice === null}
                onChange={(on) => {
                  setSpeakHints(on);
                  if (!on) return stopSpeaking();
                  // Said at once, from the tap: iOS speaks only after a first utterance from a
                  // user's action, and the person hears that it works.
                  if (voice && text) {
                    speak(text, language, voice);
                    speaker.current.mark(text, live.now());
                  }
                }}
                description={voice === null ? t("live.noVoice", { language: t(`languages.${language}`) }) : undefined}
              />
              {reach && !reach.reachable && (
                <Notice data-testid="live-face-size">
                  <p>{t("live.faceTooSmall", { distance, ipd: Math.round(reach.ipdPx), min: gates.ipd_min_px })}</p>
                </Notice>
              )}
              {cam.focalPx === null ? (
                <Notice data-testid="live-distance">
                  <p className="mb-2">{t("live.distanceUnverified")}</p>
                  <Button variant="secondary" onClick={cam.calibrate}>
                    {t("live.calibrate")}
                  </Button>
                </Notice>
              ) : (
                <div data-testid="live-calibrated">
                  <p role={calibratedNow ? "status" : undefined}>{calibratedNow ? t("live.calibration.done") : t("live.calibrated")}</p>
                  <Button variant="tertiary" onClick={cam.calibrate}>
                    {t("live.calibrateAgain")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Screen>
  );
}

/** The offered zoom closest to the camera's (which may report 2.0001 for 2×). */
function nearest(options: readonly number[], value: number): number {
  return options.reduce((best, z) => (Math.abs(z - value) < Math.abs(best - value) ? z : best), options[0]!);
}

function Intro({ distance }: { distance: number }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <>
      <p className="mb-6">{t("live.intro")}</p>
      <section aria-labelledby={headingId}>
        <h2 id={headingId} className="mb-2 text-xl">
          {t("live.beforeHeading")}
        </h2>
        <ul className="list-disc space-y-2 pl-6">
          <li>{t("live.before.stand", { distance })}</li>
          <li>{t("live.before.size")}</li>
          <li>{t("live.before.distance", { distance })}</li>
          <li>{t("live.before.profile")}</li>
        </ul>
      </section>
    </>
  );
}
