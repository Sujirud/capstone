/** Points of MediaPipe's face mesh that the live gates read (`facescan/core/landmark_map.py`). */

/** `landmark_map.NUM_MESH_POINTS`: the face mesh with the iris points. */
export const NUM_MESH_POINTS = 478;

/** `landmark_map.FACE_OVAL_RING`: the face outline, top (10) → one side → chin (152) → the other side. */
export const FACE_OVAL_RING = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172,
  58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109,
] as const;

/** The iris points of `landmark_map.MESH_LANDMARKS`. */
export const IRIS = {
  iris_center_right: 468,
  iris_right_medial: 469,
  iris_right_lateral: 471,
  iris_center_left: 473,
  iris_left_lateral: 474,
  iris_left_medial: 476,
} as const;
