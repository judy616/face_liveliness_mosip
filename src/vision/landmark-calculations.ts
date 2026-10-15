import {
  NormalizedLandmark,
  BoundingBox,
  HeadPoseEstimation,
  FaceLandmarkMeasurements,
} from '../types/index.js';

/**
 * Standard MediaPipe FaceMesh Landmark Indices:
 * Left Eye: Top=159, Bottom=145, Inner=133, Outer=33
 * Right Eye: Top=386, Bottom=374, Inner=362, Outer=263
 * Lips: Upper=13, Lower=14, CornerLeft=61, CornerRight=291
 * Nose tip: 1
 * Chin: 152
 * Left Face Border: 234, Right Face Border: 454
 */

function distance2D(p1: NormalizedLandmark, p2: NormalizedLandmark): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function safeGet(landmarks: readonly NormalizedLandmark[], index: number): NormalizedLandmark {
  const lm = landmarks[index];
  if (!lm) {
    return { x: 0.5, y: 0.5, z: 0 };
  }
  return lm;
}

/**
 * Computes bounding box enclosing all face landmarks
 */
export function computeBoundingBox(landmarks: readonly NormalizedLandmark[]): BoundingBox {
  if (landmarks.length === 0) {
    return { xMin: 0, yMin: 0, width: 0, height: 0 };
  }

  let minX = 1.0;
  let minY = 1.0;
  let maxX = 0.0;
  let maxY = 0.0;

  for (const lm of landmarks) {
    if (lm.x < minX) minX = lm.x;
    if (lm.y < minY) minY = lm.y;
    if (lm.x > maxX) maxX = lm.x;
    if (lm.y > maxY) maxY = lm.y;
  }

  return {
    xMin: Math.max(0, minX),
    yMin: Math.max(0, minY),
    width: Math.min(1, Math.max(0, maxX - minX)),
    height: Math.min(1, Math.max(0, maxY - minY)),
  };
}

/**
 * Estimates Eye Aspect Ratio (EAR) / openness
 * EAR = ||p2 - p6|| / (2 * ||p1 - p4||)
 */
export function calculateEyeOpenness(
  landmarks: readonly NormalizedLandmark[],
  isLeft: boolean
): number {
  const topIdx = isLeft ? 159 : 386;
  const btmIdx = isLeft ? 145 : 374;
  const inIdx = isLeft ? 133 : 362;
  const outIdx = isLeft ? 33 : 263;

  const top = safeGet(landmarks, topIdx);
  const bottom = safeGet(landmarks, btmIdx);
  const inner = safeGet(landmarks, inIdx);
  const outer = safeGet(landmarks, outIdx);

  const verticalDist = distance2D(top, bottom);
  const horizontalDist = distance2D(inner, outer);

  if (horizontalDist <= 0.0001) return 0;
  return verticalDist / horizontalDist;
}

/**
 * Calculates Mouth Openness / Aspect Ratio (MAR) and smile stretch
 */
export function calculateMouthMetrics(landmarks: readonly NormalizedLandmark[]): {
  mouthOpenness: number;
  smileMetric: number;
} {
  const upperLip = safeGet(landmarks, 13);
  const lowerLip = safeGet(landmarks, 14);
  const leftCorner = safeGet(landmarks, 61);
  const rightCorner = safeGet(landmarks, 291);
  const leftCheek = safeGet(landmarks, 234);
  const rightCheek = safeGet(landmarks, 454);

  const verticalDist = distance2D(upperLip, lowerLip);
  const mouthWidth = distance2D(leftCorner, rightCorner);
  const faceWidth = distance2D(leftCheek, rightCheek);

  const mouthOpenness = mouthWidth > 0.0001 ? verticalDist / mouthWidth : 0;
  const smileMetric = faceWidth > 0.0001 ? mouthWidth / faceWidth : 0;

  return { mouthOpenness, smileMetric };
}

/**
 * Calculates approximate head pose angles (yaw, pitch, roll) from geometric landmarks
 */
export function estimateHeadPose(landmarks: readonly NormalizedLandmark[]): HeadPoseEstimation {
  const noseTip = safeGet(landmarks, 1);
  const chin = safeGet(landmarks, 152);
  const leftCheek = safeGet(landmarks, 234);
  const rightCheek = safeGet(landmarks, 454);
  const leftEyeOuter = safeGet(landmarks, 33);
  const rightEyeOuter = safeGet(landmarks, 263);

  // Roll: angle between left and right eye in image plane
  const eyeDx = rightEyeOuter.x - leftEyeOuter.x;
  const eyeDy = rightEyeOuter.y - leftEyeOuter.y;
  const rollRad = Math.atan2(eyeDy, eyeDx);
  const rollDeg = (rollRad * 180) / Math.PI;

  // Yaw: asymmetry of nose relative to left and right cheeks
  const distToLeft = distance2D(noseTip, leftCheek);
  const distToRight = distance2D(noseTip, rightCheek);
  const totalWidth = distToLeft + distToRight;
  let yawDeg = 0;
  if (totalWidth > 0.0001) {
    const asymmetry = (distToRight - distToLeft) / totalWidth; // -1 to +1
    yawDeg = asymmetry * 90; // approx degrees
  }

  // Pitch: ratio of nose-to-chin vs eye-level-to-nose
  const eyeCenterY = (leftEyeOuter.y + rightEyeOuter.y) / 2;
  const upperDist = Math.max(0.001, noseTip.y - eyeCenterY);
  const lowerDist = Math.max(0.001, chin.y - noseTip.y);
  const pitchRatio = lowerDist / upperDist;
  // Neutral pitch ratio is approx 1.6 to 1.8
  const pitchDeg = (pitchRatio - 1.7) * 45;

  return {
    yawDeg: Math.max(-90, Math.min(90, yawDeg)),
    pitchDeg: Math.max(-60, Math.min(60, pitchDeg)),
    rollDeg: Math.max(-60, Math.min(60, rollDeg)),
  };
}

/**
 * Evaluates basic image brightness and contrast from canvas context if available
 */
export function evaluateBasicImageQuality(
  ctx: CanvasRenderingContext2D | null,
  width: number,
  height: number,
  bbox: BoundingBox
): {
  isAdequatelySized: boolean;
  estimatedSharpnessScore: number;
  estimatedBrightness: number;
  isLightingAdequate: boolean;
} {
  const coverageRatio = bbox.width * bbox.height;
  // Face should occupy between 8% and 80% of image area for registration
  const isAdequatelySized = coverageRatio >= 0.08 && coverageRatio <= 0.8;

  let brightness = 128;
  let sharpness = 50;

  if (ctx && width > 0 && height > 0) {
    try {
      // Sample 20x20 pixel grid from face bounding box
      const sampleX = Math.floor(bbox.xMin * width);
      const sampleY = Math.floor(bbox.yMin * height);
      const sampleW = Math.max(10, Math.floor(bbox.width * width));
      const sampleH = Math.max(10, Math.floor(bbox.height * height));

      const imgData = ctx.getImageData(sampleX, sampleY, Math.min(sampleW, width - sampleX), Math.min(sampleH, height - sampleY));
      const data = imgData.data;
      let totalLuma = 0;
      let count = 0;
      for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
        const r = data[i] ?? 0;
        const g = data[i + 1] ?? 0;
        const b = data[i + 2] ?? 0;
        totalLuma += 0.299 * r + 0.587 * g + 0.114 * b;
        count++;
      }
      if (count > 0) {
        brightness = Math.round(totalLuma / count);
      }
    } catch {
      // Fallback if cross-origin or canvas read fails
      brightness = 128;
    }
  }

  // Lighting adequate if brightness between 40 (underexposed) and 220 (washed out)
  const isLightingAdequate = brightness >= 40 && brightness <= 220;

  return {
    isAdequatelySized,
    estimatedSharpnessScore: sharpness,
    estimatedBrightness: brightness,
    isLightingAdequate,
  };
}

/**
 * Full measurement aggregator for a single detected face
 */
export function extractFaceLandmarkMeasurements(
  landmarks: readonly NormalizedLandmark[],
  ctx: CanvasRenderingContext2D | null = null,
  frameWidth: number = 640,
  frameHeight: number = 480
): FaceLandmarkMeasurements {
  const bbox = computeBoundingBox(landmarks);
  const leftEyeOpenness = calculateEyeOpenness(landmarks, true);
  const rightEyeOpenness = calculateEyeOpenness(landmarks, false);
  const averageEyeOpenness = (leftEyeOpenness + rightEyeOpenness) / 2;
  const isEyeBlinking = averageEyeOpenness < 0.18;

  const { mouthOpenness, smileMetric } = calculateMouthMetrics(landmarks);
  const headPose = estimateHeadPose(landmarks);

  const faceCenter = {
    x: bbox.xMin + bbox.width / 2,
    y: bbox.yMin + bbox.height / 2,
  };

  const faceCoverageRatio = bbox.width * bbox.height;
  const isFaceCentered =
    faceCenter.x >= 0.35 && faceCenter.x <= 0.65 && faceCenter.y >= 0.3 && faceCenter.y <= 0.7;

  const qualityIndicators = evaluateBasicImageQuality(ctx, frameWidth, frameHeight, bbox);

  return {
    leftEyeOpenness,
    rightEyeOpenness,
    averageEyeOpenness,
    isEyeBlinking,
    mouthOpenness,
    smileMetric,
    headPose,
    faceCenter,
    faceCoverageRatio,
    isFaceCentered,
    qualityIndicators,
  };
}
