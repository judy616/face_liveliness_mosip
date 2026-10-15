import { FrameLandmarkDetectionResult } from '../types/index.js';

export interface OverlayOptions {
  drawBoundingBox?: boolean;
  drawLandmarks?: boolean;
  drawFaceMetrics?: boolean;
}

/**
 * Draws real-time visual overlays on top of the webcam feed
 */
export function renderLandmarkOverlay(
  canvas: HTMLCanvasElement,
  result: FrameLandmarkDetectionResult,
  options: OverlayOptions = { drawBoundingBox: true, drawLandmarks: true, drawFaceMetrics: true }
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width;
  const h = canvas.height;

  // Clear previous frame overlay
  ctx.clearRect(0, 0, w, h);

  if (result.presenceStatus === 'NO_FACE') {
    // Draw guide oval in center
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, w * 0.22, h * 0.35, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (result.presenceStatus === 'MULTIPLE_FACES') {
    // Alert red bounding boxes on all detected faces
    for (const face of result.allFaces) {
      const bbox = face.boundingBox;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3;
      ctx.strokeRect(bbox.xMin * w, bbox.yMin * h, bbox.width * w, bbox.height * h);
    }
    return;
  }

  // Exactly one face present
  const primary = result.primaryFace;
  if (!primary) return;

  const bbox = primary.boundingBox;
  const isCentered = primary.measurements.isFaceCentered;
  const isGoodSize = primary.measurements.qualityIndicators.isAdequatelySized;

  // 1. Draw Bounding Box
  if (options.drawBoundingBox) {
    ctx.strokeStyle = isCentered && isGoodSize ? '#10b981' : '#f59e0b'; // green if centered, amber otherwise
    ctx.lineWidth = 2.5;
    ctx.strokeRect(bbox.xMin * w, bbox.yMin * h, bbox.width * w, bbox.height * h);

    // Corner reticles
    const cornerLen = 16;
    const x0 = bbox.xMin * w;
    const y0 = bbox.yMin * h;
    const x1 = (bbox.xMin + bbox.width) * w;
    const y1 = (bbox.yMin + bbox.height) * h;

    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 3;
    ctx.beginPath();
    // Top-left
    ctx.moveTo(x0, y0 + cornerLen); ctx.lineTo(x0, y0); ctx.lineTo(x0 + cornerLen, y0);
    // Top-right
    ctx.moveTo(x1 - cornerLen, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + cornerLen);
    // Bottom-left
    ctx.moveTo(x0, y1 - cornerLen); ctx.lineTo(x0, y1); ctx.lineTo(x0 + cornerLen, y1);
    // Bottom-right
    ctx.moveTo(x1 - cornerLen, y1); ctx.lineTo(x1, y1); ctx.lineTo(x1, y1 - cornerLen);
    ctx.stroke();
  }

  // 2. Draw Landmark Dots
  if (options.drawLandmarks) {
    ctx.fillStyle = 'rgba(56, 189, 248, 0.7)'; // light cyan dots
    for (let i = 0; i < primary.landmarks.length; i += 3) { // sample to keep high framerate
      const lm = primary.landmarks[i];
      if (!lm) continue;
      ctx.beginPath();
      ctx.arc(lm.x * w, lm.y * h, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 3. Draw key feature indicators (eyes, lips)
  if (options.drawFaceMetrics) {
    // Left eye outer/inner
    const m = primary.measurements;
    ctx.fillStyle = m.isEyeBlinking ? '#f43f5e' : '#34d399';
    // Draw small status pill next to face
    const pillX = Math.min(w - 180, Math.max(10, bbox.xMin * w));
    const pillY = Math.max(25, bbox.yMin * h - 10);
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(pillX, pillY - 16, 170, 20);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(
      `Yaw: ${m.headPose.yawDeg.toFixed(0)}° | EAR: ${m.averageEyeOpenness.toFixed(2)}`,
      pillX + 8,
      pillY - 2
    );
  }
}
