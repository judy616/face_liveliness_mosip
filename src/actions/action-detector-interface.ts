import {
  ChallengeType,
  FacialActionEvent,
  FrameLandmarkDetectionResult,
} from '../types/index.js';

export interface IFacialActionDetector {
  readonly supportedAction: ChallengeType;
  /**
   * Resets internal temporal history, baselines, and states for a new challenge observation window
   */
  reset(): void;

  /**
   * Evaluates a timestamped landmark detection frame
   */
  processFrame(frame: FrameLandmarkDetectionResult): FacialActionEvent;
}
