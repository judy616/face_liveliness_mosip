import { VideoFrame, BiometricDeviceLevel } from '../types/index.js';
import { BiometricDevice, FrameCallback } from './device-interface.js';

export type { FrameCallback };

export interface FrameSimulatorOptions {
  isAttack?: boolean;
  attackType?: 'PRINTED_PHOTO' | 'DIGITAL_DISPLAY_SCREEN' | 'VIDEO_REPLAY';
  isLiveHuman?: boolean;
  passiveQualityScore?: number;
  simulatedAction?: 'BLINK' | 'SMILE' | 'TURN_HEAD_LEFT' | 'TURN_HEAD_RIGHT' | 'NONE';
}

/**
 * Mock L0/L1 device for automated testing & development simulation.
 * Satisfies Bonus Task #1 in MOSIP Decode 04 requirements.
 *
 * This device supplies synthetic padLiveScore values for unit-testing the
 * liveness engine without needing a real camera or ONNX model.
 * It is NOT a substitute for a real PAD model in production.
 */
export class MockBiometricDevice implements BiometricDevice {
  public readonly deviceId: string;
  public readonly deviceModel: string;
  public readonly level: BiometricDeviceLevel;
  private _connected: boolean = false;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private frameCounter: number = 0;
  private simOptions: FrameSimulatorOptions;

  constructor(
    deviceId: string = 'MOCK-BIO-001',
    deviceModel: string = 'MOSIP-Certified-L1-FaceCam',
    level: BiometricDeviceLevel = 'L1',
    options: FrameSimulatorOptions = { isLiveHuman: true, passiveQualityScore: 0.95 }
  ) {
    this.deviceId = deviceId;
    this.deviceModel = deviceModel;
    this.level = level;
    this.simOptions = options;
  }

  get isConnected(): boolean {
    return this._connected;
  }

  public setSimulationOptions(options: Partial<FrameSimulatorOptions>): void {
    this.simOptions = { ...this.simOptions, ...options };
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

    // Stream frames at 10 fps (100ms interval) for realistic simulation
    this.intervalHandle = setInterval(() => {
      this.frameCounter++;
      const frame: VideoFrame = {
        frameId: this.frameCounter,
        timestamp: Date.now(),
        width: 640,
        height: 480,
        data: new Uint8Array(0), // raw frame memory not stored in mock
        metadata: {
          isPhotoPaperTexture: this.simOptions.attackType === 'PRINTED_PHOTO',
          isScreenPixelGrid: this.simOptions.attackType === 'DIGITAL_DISPLAY_SCREEN',
          isVideoReplayArtifacts: this.simOptions.attackType === 'VIDEO_REPLAY',
          // Synthetic PAD score: attacks get 0.05 (spoof), live humans get passiveQualityScore
          padLiveScore: this.simOptions.attackType
            ? 0.05
            : (this.simOptions.passiveQualityScore ?? 0.95),
          padModelVersion: 'MockPAD-1.0',
          eyeBlinkRate: this.simOptions.simulatedAction === 'BLINK' ? 0.92 : 0.05,
          smileConfidence: this.simOptions.simulatedAction === 'SMILE' ? 0.95 : 0.1,
          headAngleYaw:
            this.simOptions.simulatedAction === 'TURN_HEAD_LEFT'
              ? -35
              : this.simOptions.simulatedAction === 'TURN_HEAD_RIGHT'
              ? 35
              : 0,
        },
      };

      onFrame(frame);
    }, 100);
  }

  public async stopStream(): Promise<void> {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
