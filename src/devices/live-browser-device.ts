import {
  VideoFrame,
  BiometricDeviceLevel,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { BiometricDevice, FrameCallback } from './device-interface.js';
import { RealtimeFaceAcquisitionController } from '../camera/acquisition-controller.js';
import { OnnxPadModel, NullPadModel, type PadModel } from '../vision/pad-model.js';

/** How often to run PAD inference (every N frames). Lower = more accurate, higher = more performant. */
const PAD_INFERENCE_INTERVAL_FRAMES = 5;

/** URL of the ONNX model served from the public/ folder by Vite. */
const PAD_MODEL_URL = '/models/pad-model.onnx';

/**
 * LiveBrowserBiometricDevice adapts the real camera pipeline to the
 * BiometricDevice interface consumed by FaceLivenessWorkflowController.
 *
 * Device level: L0 — browser webcam is an untrusted capture endpoint.
 * It MUST NOT be labeled or claimed as L1 hardware.
 *
 * PAD integration:
 * - Loads OnnxPadModel on connect(); gracefully handles absent model file.
 * - Runs inference every PAD_INFERENCE_INTERVAL_FRAMES frames (non-blocking).
 * - Caches the latest PadFrameResult and attaches it to each VideoFrame.
 * - When model is unavailable: padLiveScore is undefined → liveness engine
 *   fails closed (no passive pass without a score).
 */
export class LiveBrowserBiometricDevice implements BiometricDevice {
  public readonly deviceId: string = 'LIVE-BROWSER-WEBCAM';
  public readonly deviceModel: string = 'Client-Webcam-MediaPipe';
  // Browser webcam is L0 — untrusted capture endpoint, NOT verified L0/L1 hardware
  public readonly level: BiometricDeviceLevel = 'L0';

  private _connected: boolean = false;
  private frameCount: number = 0;
  private currentCallback: FrameCallback | null = null;
  private padModel: PadModel;
  private latestPadScore: number | undefined = undefined;
  private latestPadModelVersion: string | undefined = undefined;
  private isPadRunning = false;

  constructor(
    private acquisitionController: RealtimeFaceAcquisitionController,
    private videoElement: HTMLVideoElement,
    private overlayCanvas: HTMLCanvasElement | null = null
  ) {
    // Use OnnxPadModel in browser, NullPadModel in server-side / test contexts
    const isBrowser = typeof document !== 'undefined';
    this.padModel = isBrowser
      ? new OnnxPadModel(PAD_MODEL_URL)
      : new NullPadModel();
  }

  get isConnected(): boolean {
    return this._connected;
  }

  public async connect(): Promise<void> {
    this._connected = true;
    // Load PAD model in background — does not block connect()
    this.padModel.load().then(() => {
      console.info(`[LiveDevice] PAD model state after load: ${this.padModel.state}`);
    });
  }

  public async disconnect(): Promise<void> {
    await this.stopStream();
    this._connected = false;
    this.latestPadScore = undefined;
    this.latestPadModelVersion = undefined;
  }

  public async startStream(onFrame: FrameCallback): Promise<void> {
    if (!this._connected) {
      throw new Error(`Device ${this.deviceId} is not connected.`);
    }

    this.currentCallback = onFrame;
    this.frameCount = 0;

    await this.acquisitionController.start(this.videoElement, this.overlayCanvas, {
      onDetectionResult: (result: FrameLandmarkDetectionResult) => {
        if (!this.currentCallback) return;

        // Drop frames with invalid dimensions (hardware not ready yet)
        if (result.frameWidth === 0 || result.frameHeight === 0) return;

        this.frameCount++;
        const primary = result.primaryFace;

        // Run PAD inference every N frames (non-blocking)
        if (
          primary &&
          this.frameCount % PAD_INFERENCE_INTERVAL_FRAMES === 0 &&
          !this.isPadRunning &&
          this.padModel.state === 'READY'
        ) {
          this.isPadRunning = true;
          const box = {
            x: primary.boundingBox.xMin * result.frameWidth,
            y: primary.boundingBox.yMin * result.frameHeight,
            w: primary.boundingBox.width * result.frameWidth,
            h: primary.boundingBox.height * result.frameHeight,
          };

          this.padModel.predict(this.videoElement, box).then((padResult) => {
            // Only store BONA_FIDE / ATTACK scores; INDETERMINATE/UNAVAILABLE → undefined
            if (padResult.outcome === 'BONA_FIDE' || padResult.outcome === 'ATTACK') {
              this.latestPadScore = padResult.liveScore;
              this.latestPadModelVersion = padResult.modelVersion;
            } else {
              // Keep last known score — do not reset to undefined on a single indeterminate frame
            }
            this.isPadRunning = false;
          }).catch(() => {
            this.isPadRunning = false;
          });
        }

        // Build VideoFrame — attach cached PAD score (undefined if model not ready)
        const videoFrame: VideoFrame = {
          frameId: this.frameCount,
          timestamp: result.timestamp,
          width: result.frameWidth,
          height: result.frameHeight,
          data: new Uint8Array(0), // Raw frame kept in GPU / videoElement; never stored to disk
          metadata: {
            isPhotoPaperTexture: false,
            isScreenPixelGrid: false,
            isVideoReplayArtifacts: false,
            // padLiveScore is undefined when model is not loaded → engine fails closed
            padLiveScore: this.latestPadScore,
            padModelVersion: this.latestPadModelVersion,
            eyeBlinkRate: primary ? (primary.measurements.isEyeBlinking ? 0.95 : 0.05) : 0,
            smileConfidence: primary
              ? Math.min(1.0, primary.measurements.smileMetric * 2.0)
              : 0,
            // Convention: selfie-view webcam mirrors left/right.
            // MediaPipe reports in camera space (pre-mirror), so:
            //   user turns their physical LEFT → yawDeg is NEGATIVE (correct for our detector)
            //   user turns their physical RIGHT → yawDeg is POSITIVE
            // The head-turn detector already matches this convention.
            headAngleYaw: primary ? primary.measurements.headPose.yawDeg : 0,
          },
        };

        this.currentCallback(videoFrame);
      },

      onError: (err) => {
        console.error('[LiveBrowserBiometricDevice] Acquisition error:', err);
        // Propagate camera errors: stop the stream so the workflow controller
        // sees a device error rather than an infinite hang.
        this.currentCallback = null;
      },
    });
  }

  public async stopStream(): Promise<void> {
    this.acquisitionController.stop();
    this.currentCallback = null;
    // Reset PAD score window on session end
    if (this.padModel instanceof OnnxPadModel) {
      this.padModel.resetWindow();
    }
    this.latestPadScore = undefined;
    this.latestPadModelVersion = undefined;
  }

  /** Expose PAD model state for UI display. */
  public getPadModelState(): PadModel['state'] {
    return this.padModel.state;
  }
}
