import { BrowserCameraSource } from '../camera/camera-source.js';
import { IFaceLandmarkDetector } from '../vision/detector-interface.js';
import {
  FrameLandmarkDetectionResult,
  CameraErrorInfo,
  FacePresenceStatus,
} from '../types/index.js';

export interface AcquisitionSessionCallbacks {
  readonly onDetectionResult: (result: FrameLandmarkDetectionResult) => void;
  readonly onFpsUpdate?: (fps: number) => void;
  readonly onError: (error: CameraErrorInfo) => void;
  readonly onStatusChange?: (status: string) => void;
}

/**
 * High-level coordinator managing Camera Lifecycle + Detection Loop + Resource Release
 */
export class RealtimeFaceAcquisitionController {
  private camera: BrowserCameraSource;
  private detector: IFaceLandmarkDetector;
  private animFrameId: number | null = null;
  private isRunning: boolean = false;
  private lastFpsCalcTime: number = 0;
  private frameCounter: number = 0;
  private lastTimestampProcessed: number = 0;

  constructor(camera: BrowserCameraSource, detector: IFaceLandmarkDetector) {
    this.camera = camera;
    this.detector = detector;
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Starts the camera, initializes the landmark detector, and begins the real-time processing loop
   */
  public async start(
    videoElement: HTMLVideoElement,
    canvasElement: HTMLCanvasElement | null,
    callbacks: AcquisitionSessionCallbacks
  ): Promise<boolean> {
    if (this.isRunning) {
      return true;
    }

    callbacks.onStatusChange?.('Initializing face landmark model...');
    const detectorInit = await this.detector.initialize();
    if (!detectorInit.success && detectorInit.error) {
      callbacks.onError(detectorInit.error);
      callbacks.onStatusChange?.(`Failed: ${detectorInit.error.message}`);
      return false;
    }

    callbacks.onStatusChange?.('Requesting camera permissions...');
    const cameraStart = await this.camera.start(videoElement);
    if (!cameraStart.success && cameraStart.error) {
      callbacks.onError(cameraStart.error);
      callbacks.onStatusChange?.(`Failed: ${cameraStart.error.message}`);
      return false;
    }

    this.isRunning = true;
    this.lastFpsCalcTime = performance.now();
    this.frameCounter = 0;
    callbacks.onStatusChange?.('Camera active. Acquiring face stream...');

    const renderCtx = canvasElement ? canvasElement.getContext('2d') : null;

    const processFrameLoop = (now: DOMHighResTimeStamp) => {
      if (!this.isRunning) return;

      // Update FPS calculations every 500ms
      this.frameCounter++;
      if (now - this.lastFpsCalcTime >= 500) {
        const elapsedSec = (now - this.lastFpsCalcTime) / 1000;
        const currentFps = Math.round(this.frameCounter / elapsedSec);
        callbacks.onFpsUpdate?.(currentFps);
        this.frameCounter = 0;
        this.lastFpsCalcTime = now;
      }

      // Check if video is valid and has new frame
      if (videoElement.readyState >= 2 && !videoElement.paused && !videoElement.ended) {
        // Enforce strictly monotonic timestamp for MediaPipe Video Mode
        const frameTime = Math.max(now, this.lastTimestampProcessed + 1);
        this.lastTimestampProcessed = frameTime;

        try {
          const result = this.detector.detectVideoFrame(videoElement, frameTime, renderCtx);
          callbacks.onDetectionResult(result);
        } catch (err) {
          console.error('Error during detectVideoFrame:', err);
        }
      }

      this.animFrameId = requestAnimationFrame(processFrameLoop);
    };

    this.animFrameId = requestAnimationFrame(processFrameLoop);
    return true;
  }

  /**
   * Immediately stops frame loop, releases camera hardware, and clears resources
   */
  public stop(): void {
    this.isRunning = false;

    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    this.camera.stop();
  }

  /**
   * Full cleanup when leaving page or unmounting component
   */
  public dispose(): void {
    this.stop();
    this.detector.close();
  }
}
