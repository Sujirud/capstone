/**
 * "Take a photo" on the guide and retake screens: for the front photo, live mode (§14) where
 * the browser can show a camera on a page; elsewhere, and for the side photo, the phone's
 * camera app (§7).
 */
import { useNavigate } from "react-router";
import { useLiveServices } from "../../app/services";
import type { View } from "../../scan/session";
import { scanPath } from "../paths";

export function useTakePhoto(view: View, openCameraApp: () => void): () => void {
  const navigate = useNavigate();
  const live = useLiveServices();
  return view === "frontal" && live.supported() ? () => navigate(scanPath("frontal", "live")) : openCameraApp;
}
