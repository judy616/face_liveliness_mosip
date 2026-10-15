import {
  FacialActionEvent,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { IFacialActionDetector } from './action-detector-interface.js';

export interface BlinkDetectorConfig {
  readonly minBaselineFrames: number;      // Frames needed to establish open-eye baseline (e.g. 5)
  readonly closeRatioThreshold: number;   // EAR drops below (baseline * ratio) (e.g. 0.65 or absolute < 0.18)
  readonly reopenRatioThreshold: number;  // EAR recovers to (baseline * ratio) (e.g. 0.85)
  readonly minBlinkDurationMs: number;    // Physiological blink minimum (~50ms)
  readonly maxBlinkDurationMs: number;    // Physiological blink maximum (~800ms) to reject prolonged closed eyes
  readonly maxSmoothingWindow: number;    // Moving average window size
}

const DEFAULT_CONFIG: BlinkDetectorConfig = {
  minBaselineFrames: 4,
  closeRatioThreshold: 0.65,
  reopenRatioThreshold: 0.82,
  minBlinkDurationMs: 60,
  maxBlinkDurationMs: 800,
  maxSmoothingWindow: 3,
};

type BlinkPhase = 'WAITING_BASELINE' | 'EYES_OPEN' | 'EYES_CLOSING' | 'BLINK_COMPLETED';

/**
 * Temporal stateful blink detector.
 * Establishes baseline open EAR, tracks transition to closed state, and requires recovery to open.
 */
export class TemporalBlinkDetector implements IFacialActionDetector {
  public readonly supportedAction = 'BLINK' as const;
  private config: BlinkDetectorConfig;
  private phase: BlinkPhase = 'WAITING_BASELINE';
  private baselineSamples: number[] = [];
  private baselineEar: number = 0;
  private recentSamples: number[] = [];
  private closeStartTime: number | null = null;
  private blinkCompletedTimestamp: number | null = null;

  constructor(config: Partial<BlinkDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public reset(): void {
    this.phase = 'WAITING_BASELINE';
    this.baselineSamples = [];
    this.baselineEar = 0;
    this.recentSamples = [];
    this.closeStartTime = null;
    this.blinkCompletedTimestamp = null;
  }

  public processFrame(frame: FrameLandmarkDetectionResult): FacialActionEvent {
    const timestamp = frame.timestamp;

    // 1. Guard face presence
    if (frame.presenceStatus !== 'EXACTLY_ONE_FACE' || !frame.primaryFace) {
      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: frame.presenceStatus === 'MULTIPLE_FACES'
          ? 'Multiple faces detected in frame.'
          : 'Face not detected or lost.',
      };
    }

    const measurements = frame.primaryFace.measurements;

    // 2. Reject poor image quality or extreme head yaw (profile view makes EAR unreliable)
    if (!measurements.qualityIndicators.isLightingAdequate) {
      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: 'Lighting inadequate for reliable eye landmark detection.',
      };
    }

    if (Math.abs(measurements.headPose.yawDeg) > 30) {
      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: 'Face must be facing forward during blink verification.',
      };
    }

    const rawEar = measurements.averageEyeOpenness;

    // Temporal smoothing
    this.recentSamples.push(rawEar);
    if (this.recentSamples.length > this.config.maxSmoothingWindow) {
      this.recentSamples.shift();
    }
    const smoothedEar =
      this.recentSamples.reduce((a, b) => a + b, 0) / this.recentSamples.length;

    // 3. Already completed - don't re-trigger duplicate events
    if (this.phase === 'BLINK_COMPLETED') {
      return {
        actionType: 'BLINK',
        timestamp: this.blinkCompletedTimestamp ?? timestamp,
        confidence: 1.0,
        state: 'DETECTED',
        qualityValid: true,
        details: 'Blink sequence validated.',
      };
    }

    // 4. Baseline Calibration
    if (this.phase === 'WAITING_BASELINE') {
      // Collect initial frames when eyes appear open (EAR > 0.18)
      if (rawEar >= 0.18) {
        this.baselineSamples.push(rawEar);
      }
      if (this.baselineSamples.length >= this.config.minBaselineFrames) {
        this.baselineEar =
          this.baselineSamples.reduce((a, b) => a + b, 0) / this.baselineSamples.length;
        this.phase = 'EYES_OPEN';
      }
      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0,
        state: 'CALIBRATING_BASELINE',
        qualityValid: true,
        details: `Calibrating baseline (${this.baselineSamples.length}/${this.config.minBaselineFrames})`,
      };
    }

    const closeThreshold = Math.min(0.20, this.baselineEar * this.config.closeRatioThreshold);
    const reopenThreshold = Math.max(0.22, this.baselineEar * this.config.reopenRatioThreshold);

    // 5. State: EYES_OPEN -> detect dip
    if (this.phase === 'EYES_OPEN') {
      // Slowly adapt baseline to natural variations if open
      if (smoothedEar >= reopenThreshold) {
        this.baselineEar = this.baselineEar * 0.95 + smoothedEar * 0.05;
      }

      const isClosing = smoothedEar <= closeThreshold || rawEar <= closeThreshold;
      if (isClosing) {
        this.phase = 'EYES_CLOSING';
        this.closeStartTime = timestamp;
      }

      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0,
        state: 'TRACKING',
        qualityValid: true,
        details: `Eyes open (EAR: ${smoothedEar.toFixed(3)}, Baseline: ${this.baselineEar.toFixed(3)})`,
      };
    }

    // 6. State: EYES_CLOSING -> waiting for recovery to open
    if (this.phase === 'EYES_CLOSING') {
      const closeDuration = timestamp - (this.closeStartTime ?? timestamp);

      // Rejection: Eyes stayed closed longer than max duration (e.g. sleeping, squinting, spoof)
      if (closeDuration > this.config.maxBlinkDurationMs) {
        this.phase = 'EYES_OPEN';
        this.closeStartTime = null;
        return {
          actionType: 'BLINK',
          timestamp,
          confidence: 0,
          state: 'INCONCLUSIVE',
          qualityValid: true,
          failureReason: `Eye closure duration (${closeDuration}ms) exceeded maximum physiological blink threshold (${this.config.maxBlinkDurationMs}ms).`,
        };
      }

      // Detection: Eyes reopened sufficiently within physiological window
      // Check both smoothed and raw to handle fast sharp blinks
      const isReopened = smoothedEar >= reopenThreshold || rawEar >= reopenThreshold;
      if (isReopened) {
        if (closeDuration >= this.config.minBlinkDurationMs) {
          this.phase = 'BLINK_COMPLETED';
          this.blinkCompletedTimestamp = timestamp;
          return {
            actionType: 'BLINK',
            timestamp,
            confidence: 0.95,
            state: 'DETECTED',
            qualityValid: true,
            details: `Valid blink sequence completed in ${closeDuration}ms (EAR min: ${smoothedEar.toFixed(3)})`,
          };
        } else {
          // Too fast to be natural blink (<50ms, likely noise/glitch)
          this.phase = 'EYES_OPEN';
          this.closeStartTime = null;
        }
      }

      return {
        actionType: 'BLINK',
        timestamp,
        confidence: 0.5,
        state: 'TRACKING',
        qualityValid: true,
        details: `Eye closure in progress (${closeDuration}ms)`,
      };
    }

    return {
      actionType: 'BLINK',
      timestamp,
      confidence: 0,
      state: 'TRACKING',
      qualityValid: true,
    };
  }
}
