/**
 * The capture protocols: client-config's title and steps, verbatim, each with
 * its drawing.
 *
 * - Frontal (step 1 of the frontal flow): steps 1 and 2, the helper at a distance and no
 *   arm's-length selfie, are highlighted as a "like this / not like this" pair.
 * - Profile: the five side-photo steps, each with its drawing.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ClientConfig } from "../../api/schemas";
import {
  BackgroundDrawing,
  HairlineDrawing,
  HelperDistanceDrawing,
  LevelDrawing,
  NeutralDrawing,
  SelfieDrawing,
  ZoomDrawing,
} from "../../components/illustrations/Guide";
import {
  ProfileBackgroundDrawing,
  ProfileGazeDrawing,
  ProfileHairDrawing,
  ProfileNeckDrawing,
  ProfileTurnDrawing,
} from "../../components/illustrations/Profile";

/** The drawings for the core's six frontal steps, in its order (tests/guide.test.tsx). */
export const FRONTAL_STEP_COUNT = 6;
/** The drawings for the core's five profile steps, in its order (tests/guide.test.tsx). */
export const PROFILE_STEP_COUNT = 5;

function Figure({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <figure className="max-w-[16rem]">
      {children}
      {caption && <figcaption className="mt-1 text-sm font-medium text-ink-2">{caption}</figcaption>}
    </figure>
  );
}

function Step({ text, n, children }: { text: string; n: number; children: ReactNode }) {
  return (
    <li className="grid gap-3">
      <p className="flex gap-2">
        <span className="font-semibold tabular-nums">{n}.</span>
        <span>{text}</span>
      </p>
      {children}
    </li>
  );
}

export function FrontalProtocol({ config }: { config: ClientConfig }) {
  const { t } = useTranslation();
  const steps = config.strings.capture.frontal.steps;
  const distance = config.frontal.gates.camera_distance_recommended_m;
  const drawings: ReactNode[] = [
    <div key="1" className="grid gap-3">
      <Figure caption={t("guide.likeThis")}>
        <HelperDistanceDrawing distance={distance} />
      </Figure>
      <Figure>
        <ZoomDrawing />
      </Figure>
    </div>,
    <Figure key="2" caption={t("guide.notLikeThis")}>
      <SelfieDrawing />
    </Figure>,
    <Figure key="3">
      <BackgroundDrawing />
    </Figure>,
    <Figure key="4">
      <HairlineDrawing />
    </Figure>,
    <Figure key="5">
      <LevelDrawing />
    </Figure>,
    <Figure key="6">
      <NeutralDrawing />
    </Figure>,
  ];
  const item = (text: string, i: number) => (
    <Step key={i} text={text} n={i + 1}>
      {drawings[i]}
    </Step>
  );
  return (
    <>
      <div className="border border-line bg-surface p-4">
        <ol className="grid gap-6 md:grid-cols-2">{steps.slice(0, 2).map(item)}</ol>
      </div>
      <ol start={3} className="mt-8 grid gap-8 md:grid-cols-2">
        {steps.slice(2).map((text, j) => item(text, j + 2))}
      </ol>
      <p className="mt-6 text-ink-2">{t("guide.distance", { distance })}</p>
    </>
  );
}

export function ProfileProtocol({ config }: { config: ClientConfig }) {
  const { t } = useTranslation();
  const steps = config.strings.capture.profile.steps;
  // "Taken the same way as the front photo": the frontal distance applies (client-config
  // gives the profile only the minimum).
  const distance = config.frontal.gates.camera_distance_recommended_m;
  const drawings: ReactNode[] = [
    <ProfileTurnDrawing key="1" distance={distance} />,
    <ProfileBackgroundDrawing key="2" />,
    <ProfileHairDrawing key="3" />,
    <ProfileGazeDrawing key="4" />,
    <ProfileNeckDrawing key="5" />,
  ];
  return (
    <>
      <ol className="grid gap-8 md:grid-cols-2">
        {steps.map((text, i) => (
          <Step key={i} text={text} n={i + 1}>
            <Figure>{drawings[i]}</Figure>
          </Step>
        ))}
      </ol>
      <p className="mt-6 text-ink-2">{t("guide.distance", { distance })}</p>
    </>
  );
}

/** The view's protocol. */
export function Protocol({ config, view }: { config: ClientConfig; view: "frontal" | "profile" }) {
  return view === "frontal" ? <FrontalProtocol config={config} /> : <ProfileProtocol config={config} />;
}
