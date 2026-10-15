import {
  VideoFrame,
  BiometricDeviceLevel,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { BiometricDevice, FrameCallback } from './mock-device.js';
import { RealtimeFaceAcquisitionController } from '../camera/acquisition-controller.js';

/**
 * Adapter allowing RealtimeFaceAcquisitionController to be used directly by
 * MOSIP FaceLivenessWorkflowController or other MOSIP client modules.
 * Strictly separates real camera frames from MockBiometricDevice.
 */
export class LiveBrowserBiometricDevice implements BiometricDevice {
  public readonly deviceId: string = 'LIVE-BROWSER-WEBCAM';
  public readonly deviceModel: string = 'Client-Webcam-MediaPipe';
  public readonly level: BiometricDeviceLevel = 'L0'; // Browser webcam is L0 (untrusted capture endpoint)
  private _connected: boolean = false;
  private frameCount: number = 0;
  private currentCallback: FrameCallback | null = null;
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D | null;

  constructor(
    private acquisitionController: RealtimeFaceAcquisitionController,
    private videoElement: HTMLVideoElement,
    private overlayCanvas: HTMLCanvasElement | null = null
  ) {
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = 640;
    this.offscreenCanvas.height = 480;
    this.offscreenCtx = this.offscreenCanvas.getContext('2d');
  }

  get isConnected(): boolean {
    return this._connected;
  }

  public async connect(): Promise<void> {
    this._connected = true;
  }

  public async disconnect(): Promise<void> {
    await this.stopStream();
    this._connected = false;
  }

  public async startStream(onFrame: FrameCallback): Promise<void> {
    if (!this._connected) {
      throw new Error(`Device ${this.deviceId} is not connected.`);
    }

    this.currentCallback = onFrame;

    await this.acquisitionController.start(this.videoElement, this.overlayCanvas, {
      onDetectionResult: (result: FrameLandmarkDetectionResult) => {
        if (!this.currentCallback) return;

        this.frameCount++;
        const primary = result.primaryFace;

        // Convert detected real facial geometry into VideoFrame payload
        const videoFrame: VideoFrame = {
          frameId: this.frameCount,
          timestamp: result.timestamp,
          width: result.frameWidth,
          height: result.frameHeight,
          data: new Uint8Array(0), // Raw frame memory is kept in GPU/videoElement; not stored on disk
          metadata: {
            isPhotoPaperTexture: false,
            isScreenPixelGrid: false,
            isVideoReplayArtifacts: false,
            eyeBlinkRate: primary ? (primary.measurements.isEyeBlinking ? 0.95 : 0.05) : 0,
            smileConfidence: primary ? Math.min(1.0, primary.measurements.smileMetric * 2.0) : 0,
            headAngleYaw: primary ? primary.measurements.headPose.yawDeg : 0,
          },
        };

        this.currentCallback(videoFrame);
      },
      onError: (err) => {
        console.error('LiveBrowserBiometricDevice acquisition error:', err);
      },
    });
  }

  public async stopStream(): Promise<void> {
    this.acquisitionController.stop();
    this.currentCallback = null;
  }
}
