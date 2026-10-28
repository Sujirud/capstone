/**
 * Frames from the camera. Each processed frame is a snapshot of the video, as
 * the camera delivers it (never mirrored): the detector reads it, the pixel gates read the
 * face region of it, and a frame kept for the burst is encoded as JPEG at quality 95, since a
 * video frame has no original file.
 */
import type { Box, Region } from "./pixels";

export const JPEG_QUALITY = 0.95;

export interface Frame {
  readonly width: number;
  readonly height: number;
  /** What the detector reads. */
  readonly image: ImageBitmap;
  /** The frame's pixels inside `box`, unscaled. */
  region(box: Box): Region;
  encode(): Promise<Blob>;
  /** Frees the frame's memory; it cannot be read after. */
  close(): void;
}

export interface FrameSource {
  /** The video's current frame, or null while there is none. */
  grab(): Promise<Frame | null>;
}

function canvas2d(width: number, height: number, readBack: boolean, canvas = document.createElement("canvas")) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", readBack ? { willReadFrequently: true } : undefined);
  if (!ctx) throw new Error("no 2D canvas");
  return { canvas, ctx };
}

/** A frame from a bitmap; `scratch`, if given, is reused to read regions (one per video). */
export function bitmapFrame(bitmap: ImageBitmap, scratch?: HTMLCanvasElement): Frame {
  return {
    width: bitmap.width,
    height: bitmap.height,
    image: bitmap,
    region(box) {
      const width = box.x1 - box.x0;
      const height = box.y1 - box.y0;
      const { ctx } = canvas2d(width, height, true, scratch);
      ctx.drawImage(bitmap, box.x0, box.y0, width, height, 0, 0, width, height);
      const data = ctx.getImageData(0, 0, width, height).data;
      return { data, width, height, channels: 4, left: box.x0, top: box.y0 };
    },
    async encode() {
      const { canvas, ctx } = canvas2d(bitmap.width, bitmap.height, false);
      ctx.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
      // Release the full-size canvas at once: phones allow little canvas memory.
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error("the frame could not be encoded");
      return blob;
    },
    close() {
      bitmap.close();
    },
  };
}

/** Snapshots of a playing video element. */
export function videoFrames(video: HTMLVideoElement): FrameSource {
  const scratch = document.createElement("canvas");
  return {
    async grab() {
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth === 0) return null;
      return bitmapFrame(await createImageBitmap(video), scratch);
    },
  };
}
