import {
  ChallengeType,
  FacialActionEvent,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { IFacialActionDetector } from './action-detector-interface.js';

export interface HeadTurnDetectorConfig {
  readonly minBaselineFrames: number;      // Frames to establish centered/neutral pose
  readonly neutralMaxYawDeg: number;       // Max yaw allowed during neutral state (e.g. ±12°)
  readonly targetAngleDeg: number;         // Threshold angle (e.g. 20°)
  readonly sustainedFrames: number;        // Consecutive frames held at target angle (e.g. 3 frames)
  readonly maxSmoothingWindow: number;
}

const DEFAULT_CONFIG: HeadTurnDetectorConfig = {
  minBaselineFrames: 5,
  neutralMaxYawDeg: 12,
  targetAngleDeg: 18,
  sustainedFrames: 3,
  maxSmoothingWindow: 3,
};

type HeadTurnPhase = 'WAITING_NEUTRAL' | 'CONFIRMING_NEUTRAL' | 'WAITING_TURN' | 'TURN_COMPLETED';

/**
 * Head turn detector for TURN_HEAD_LEFT and TURN_HEAD_RIGHT.
 *
 * Coordinate Convention:
 * - Real 3D physical world: turning head toward the user's left creates an asymmetry
 *   where the right cheek is further from the nose in 2D projection than the left cheek.
 * - In our landmark-calculations.ts:
 *   distToLeft = dist(noseTip, leftCheek), distToRight = dist(noseTip, rightCheek)
 *   asymmetry = (distToRight - distToLeft) / totalWidth
 *   yawDeg = asymmetry * 90
 *   When user turns head to their LEFT, distToRight increases -> yawDeg < -15° (Negative).
 *   When user turns head to their RIGHT, distToLeft increases -> yawDeg > +15° (Positive).
 *
 * Enforces transition: User MUST first establish neutral baseline (face forward |yaw| < 12°)
 * before turning to the requested direction. Rejects pre-turned static poses.
 */
export class HeadTurnDetector implements IFacialActionDetector {
  public readonly supportedAction: 'TURN_HEAD_LEFT' | 'TURN_HEAD_RIGHT';
  private config: HeadTurnDetectorConfig;
  private phase: HeadTurnPhase = 'WAITING_NEUTRAL';
  private neutralSamples: number[] = [];
  private recentYawSamples: number[] = [];
  private sustainedCount: number = 0;
  private completedTimestamp: number | null = null;

  constructor(
    direction: 'TURN_HEAD_LEFT' | 'TURN_HEAD_RIGHT',
    config: Partial<HeadTurnDetectorConfig> = {}
  ) {
    this.supportedAction = direction;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public reset(): void {
    this.phase = 'WAITING_NEUTRAL';
    this.neutralSamples = [];
    this.recentYawSamples = [];
    this.sustainedCount = 0;
    this.completedTimestamp = null;
  }

  public processFrame(frame: FrameLandmarkDetectionResult): FacialActionEvent {
    const timestamp = frame.timestamp;

    if (frame.presenceStatus !== 'EXACTLY_ONE_FACE' || !frame.primaryFace) {
      return {
        actionType: this.supportedAction,
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
        actionType: this.supportedAction,
        timestamp,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason: 'Lighting inadequate for reliable head pose tracking.',
      };
    }

    const rawYaw = measurements.headPose.yawDeg;

    // Temporal smoothing
    this.recentYawSamples.push(rawYaw);
    if (this.recentYawSamples.length > this.config.maxSmoothingWindow) {
      this.recentYawSamples.shift();
    }
    const smoothedYaw =
      this.recentYawSamples.reduce((a, b) => a + b, 0) / this.recentYawSamples.length;

    if (this.phase === 'TURN_COMPLETED') {
      return {
        actionType: this.supportedAction,
        timestamp: this.completedTimestamp ?? timestamp,
        confidence: 0.95,
        state: 'DETECTED',
        qualityValid: true,
        details: `Head turn to ${this.supportedAction} validated.`,
      };
    }

    // 1. Mandatory Neutral Baseline Step: Require user to look straight first
    if (this.phase === 'WAITING_NEUTRAL' || this.phase === 'CONFIRMING_NEUTRAL') {
      if (Math.abs(smoothedYaw) <= this.config.neutralMaxYawDeg) {
        this.neutralSamples.push(smoothedYaw);
        if (this.neutralSamples.length >= this.config.minBaselineFrames) {
          this.phase = 'WAITING_TURN';
          return {
            actionType: this.supportedAction,
            timestamp,
            confidence: 0,
            state: 'TRACKING',
            qualityValid: true,
            details: `Neutral position confirmed. Please turn ${this.supportedAction === 'TURN_HEAD_LEFT' ? 'LEFT' : 'RIGHT'}.`,
          };
        }
      } else {
        this.neutralSamples = []; // Reset if head was turned
      }

      return {
        actionType: this.supportedAction,
        timestamp,
        confidence: 0,
        state: 'CALIBRATING_BASELINE',
        qualityValid: true,
        details: `Looking straight ahead (${this.neutralSamples.length}/${this.config.minBaselineFrames}, Yaw: ${smoothedYaw.toFixed(1)}°)`,
      };
    }

    // 2. Waiting for turn in the requested direction
    // TURN_HEAD_LEFT: yaw < -targetAngleDeg
    // TURN_HEAD_RIGHT: yaw > +targetAngleDeg
    const effectiveYaw = Math.abs(rawYaw) > Math.abs(smoothedYaw) ? rawYaw : smoothedYaw;

    const isTargetDirection =
      this.supportedAction === 'TURN_HEAD_LEFT'
        ? effectiveYaw <= -this.config.targetAngleDeg
        : effectiveYaw >= this.config.targetAngleDeg;

    // Check if user turned to the OPPOSITE direction
    const isOppositeDirection =
      this.supportedAction === 'TURN_HEAD_LEFT'
        ? effectiveYaw >= this.config.targetAngleDeg
        : effectiveYaw <= -this.config.targetAngleDeg;

    if (isOppositeDirection) {
      return {
        actionType: this.supportedAction,
        timestamp,
        confidence: 0,
        state: 'TRACKING',
        qualityValid: true,
        details: `Turned wrong way (Yaw: ${smoothedYaw.toFixed(1)}°). Please turn ${this.supportedAction === 'TURN_HEAD_LEFT' ? 'LEFT' : 'RIGHT'}.`,
      };
    }

    if (isTargetDirection) {
      this.sustainedCount++;
      if (this.sustainedCount >= this.config.sustainedFrames) {
        this.phase = 'TURN_COMPLETED';
        this.completedTimestamp = timestamp;
        return {
          actionType: this.supportedAction,
          timestamp,
          confidence: 0.94,
          state: 'DETECTED',
          qualityValid: true,
          details: `Valid head turn detected (${smoothedYaw.toFixed(1)}°)`,
        };
      }
      return {
        actionType: this.supportedAction,
        timestamp,
        confidence: 0.6,
        state: 'TRACKING',
        qualityValid: true,
        details: `Head turn in progress (${this.sustainedCount}/${this.config.sustainedFrames})`,
      };
    } else {
      this.sustainedCount = 0;
      return {
        actionType: this.supportedAction,
        timestamp,
        confidence: 0,
        state: 'TRACKING',
        qualityValid: true,
        details: `Awaiting turn to ${this.supportedAction === 'TURN_HEAD_LEFT' ? 'LEFT' : 'RIGHT'} (Current yaw: ${smoothedYaw.toFixed(1)}°)`,
      };
    }
  }
}
