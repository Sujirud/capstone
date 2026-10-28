/**
 * The two photo sources: "Take a photo" opens the phone's own camera
 * app on the rear camera; "Choose a photo" opens the library (or a file dialog on a
 * desktop). HEIC is not listed, so iOS usually hands over JPEG.
 */
import { useRef, useState, type ChangeEvent } from "react";
import type { ClientConfig } from "../../api/schemas";
import { useScan } from "../../scan/ScanContext";
import type { PhotoSource, View } from "../../scan/session";
import type { PreflightResult } from "./preflight";

export const ACCEPT = "image/jpeg,image/png,image/webp";

export function usePhotoPicker(view: View, config: ClientConfig, onDone: (result: PreflightResult, source: PhotoSource) => void) {
  const { selectPhoto } = useScan();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const onChange = (source: PhotoSource) => async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be chosen again
    if (!file) return;
    setBusy(true);
    try {
      onDone(await selectPhoto(view, file, source, config), source);
    } finally {
      setBusy(false);
    }
  };

  const inputs = (
    <>
      <input
        ref={camera}
        type="file"
        accept={ACCEPT}
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="input-camera"
        onChange={onChange("camera")}
      />
      <input
        ref={library}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="input-library"
        onChange={onChange("library")}
      />
    </>
  );

  return {
    inputs,
    busy,
    takePhoto: () => camera.current?.click(),
    choosePhoto: () => library.current?.click(),
    open: (source: Exclude<PhotoSource, "live">) => (source === "camera" ? camera : library).current?.click(),
  };
}
