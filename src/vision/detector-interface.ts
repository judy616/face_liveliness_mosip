import { FrameLandmarkDetectionResult, CameraErrorInfo } from '../types/index.js';

/**
 * Clean adapter interface decoupling Face Landmarker implementation from the liveness engine.
 * Allows switching between MediaPipe Tasks Vision, OpenCV, or on-device native SDKs seamlessly.
 */
export interface IFaceLandmarkDetector {
  /**
   * Initializes detector models and wasm runtimes
   */
  initialize(): Promise<{ success: boolean; error?: CameraErrorInfo }>;

  /**
   * Processes a video frame or canvas element at the given high-res timestamp
   */
  detectVideoFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampMs: number,
    renderCtx?: CanvasRenderingContext2D | null
  ): FrameLandmarkDetectionResult;

  /**
   * Releases models and wasm memory
   */
  close(): void;
}
