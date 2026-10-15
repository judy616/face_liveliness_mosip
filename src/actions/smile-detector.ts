import {
  FacialActionEvent,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { IFacialActionDetector } from './action-detector-interface.js';

export interface SmileDetectorConfig {
  readonly minBaselineFrames: number;      // Frames needed to establish neutral baseline
  readonly smileDeltaThreshold: number;    // Required increase in smileMetric over neutral baseline (e.g. +0.07)
  readonly sustainedFrames: number;        // Number of consecutive frames the smile must be held (e.g. 3 frames)
  readonly maxSmoothingWindow: number;
}

const DEFAULT_CONFIG: SmileDetectorConfig = {
  minBaselineFrames: 5,
  smileDeltaThreshold: 0.055, // 5.5% expansion of mouth width relative to face width
  sustainedFrames: 3,
  maxSmoothingWindow: 4,
};

type SmilePhase = 'WAITING_BASELINE' | 'TRACKING_NEUTRAL' | 'SMILE_COMPLETED';

/**
 * Stateful dynamic smile detector.
 * Establishes neutral mouth width baseline and detects genuine expression changes.
 * Rejects static smiling faces (photographs / cutouts).
 */
export class SmileDetector implements IFacialActionDetector {
  public readonly supportedAction = 'SMILE' as const;
  private config: SmileDetectorConfig;
  private phase: SmilePhase = 'WAITING_BASELINE';
  private baselineSamples: number[] = [];
  private baselineMetric: number = 0;
  private recentSamples: number[] = [];
  private sustainedCount: number = 0;
  private completedTimestamp: number | null = null;

  constructor(config: Partial<SmileDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public reset(): void {
    this.phase = 'WAITING_BASELINE';
    this.baselineSamples = [];
    this.baselineMetric = 0;
    this.recentSamples = [];
    this.sustainedCount = 0;
    this.completedTimestamp = null;
  }

  public processFrame(frame: FrameLandmarkDetectionResult): FacialActionEvent {
    const timestamp = frame.timestamp;

    if (frame.presenceStatus !== 'EXACTLY_ONE_FACE' || !frame.primaryFace) {
      return {
        actionType: 'SMILE',
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

    if (!measurements.qualityIndicators.isLightingAdequate) {
      return {
        actionType: 'SMILE',
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: 'Lighting inadequate for reliable mouth landmark detection.',
      };
    }

    if (Math.abs(measurements.headPose.yawDeg) > 25) {
      return {
        actionType: 'SMILE',
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: 'Face must be facing forward during smile verification.',
      };
    }

    const rawMetric = measurements.smileMetric;

    // Temporal smoothing
    this.recentSamples.push(rawMetric);
    if (this.recentSamples.length > this.config.maxSmoothingWindow) {
      this.recentSamples.shift();
    }
    const smoothedMetric =
      this.recentSamples.reduce((a, b) => a + b, 0) / this.recentSamples.length;

    if (this.phase === 'SMILE_COMPLETED') {
      return {
        actionType: 'SMILE',
        timestamp: this.completedTimestamp ?? timestamp,
        confidence: 0.95,
        state: 'DETECTED',
        qualityValid: true,
        details: 'Dynamic smile validated.',
      };
    }

    // 1. Baseline Calibration: Learn user's relaxed / neutral mouth shape
    if (this.phase === 'WAITING_BASELINE') {
      this.baselineSamples.push(rawMetric);
      if (this.baselineSamples.length >= this.config.minBaselineFrames) {
        this.baselineMetric =
          this.baselineSamples.reduce((a, b) => a + b, 0) / this.baselineSamples.length;
        this.phase = 'TRACKING_NEUTRAL';
      }
      return {
        actionType: 'SMILE',
        timestamp,
        confidence: 0,
        state: 'CALIBRATING_BASELINE',
        qualityValid: true,
        details: `Calibrating neutral baseline (${this.baselineSamples.length}/${this.config.minBaselineFrames})`,
      };
    }

    // 2. Expression change detection
    const delta = Math.max(rawMetric, smoothedMetric) - this.baselineMetric;

    if (delta >= this.config.smileDeltaThreshold) {
      this.sustainedCount++;
      if (this.sustainedCount >= this.config.sustainedFrames) {
        this.phase = 'SMILE_COMPLETED';
        this.completedTimestamp = timestamp;
        return {
          actionType: 'SMILE',
          timestamp,
          confidence: 0.92,
          state: 'DETECTED',
          qualityValid: true,
          details: `Smile detected (Δ: +${(delta * 100).toFixed(1)}% stretch over baseline)`,
        };
      }
      return {
        actionType: 'SMILE',
        timestamp,
        confidence: Math.min(0.9, delta / this.config.smileDeltaThreshold),
        state: 'TRACKING',
        qualityValid: true,
        details: `Smiling in progress (${this.sustainedCount}/${this.config.sustainedFrames})`,
      };
    } else {
      this.sustainedCount = 0;
      // If user relaxed further, gently adapt baseline downward
      if (smoothedMetric < this.baselineMetric) {
        this.baselineMetric = this.baselineMetric * 0.9 + smoothedMetric * 0.1;
      }
      return {
        actionType: 'SMILE',
        timestamp,
        confidence: 0,
        state: 'TRACKING',
        qualityValid: true,
        details: `Neutral expression (Δ: ${(delta * 100).toFixed(1)}%)`,
      };
    }
  }
}
