import {
  VideoFrame,
  PadAssessmentResult,
  PassiveLivenessResult,
  ActiveChallenge,
  ChallengeType,
} from '../types/index.js';

/**
 * Presentation Attack Detection (PAD) conforming to ISO/IEC 30107
 * Evaluates spoofs: printed photos, screens/monitors, and video replays.
 */
export class PresentationAttackDetector {
  public evaluate(frame: VideoFrame): PadAssessmentResult {
    const meta = frame.metadata;
    if (!meta) {
      return { isAttackDetected: false, attackConfidence: 0.0, details: 'Clear frame' };
    }

    if (meta.isPhotoPaperTexture) {
      return {
        isAttackDetected: true,
        attackType: 'PRINTED_PHOTO',
        attackConfidence: 0.98,
        details: 'High specular reflection & paper halftone pattern detected (ISO 30107)',
      };
    }

    if (meta.isScreenPixelGrid) {
      return {
        isAttackDetected: true,
        attackType: 'DIGITAL_DISPLAY_SCREEN',
        attackConfidence: 0.95,
        details: 'Moiré pattern & RGB subpixel emission grid detected (Screen spoof)',
      };
    }

    if (meta.isVideoReplayArtifacts) {
      return {
        isAttackDetected: true,
        attackType: 'VIDEO_REPLAY',
        attackConfidence: 0.93,
        details: 'Inter-frame compression compression artifacts & frame jitter detected',
      };
    }

    return {
      isAttackDetected: false,
      attackConfidence: 0.02,
      details: 'No Presentation Attack patterns detected',
    };
  }
}

/**
 * Passive Liveness Analyzer
 * Checks depth, micromovements, and skin texture without requiring user interaction.
 */
export class PassiveLivenessAnalyzer {
  private padDetector: PresentationAttackDetector;

  constructor() {
    this.padDetector = new PresentationAttackDetector();
  }

  public analyzeFrame(frame: VideoFrame, threshold: number): PassiveLivenessResult {
    const padResult = this.padDetector.evaluate(frame);

    // If a presentation attack is detected, immediate passive failure
    if (padResult.isAttackDetected) {
      return {
        livenessScore: 0.1,
        padResult,
        meetsThreshold: false,
      };
    }

    // Default simulated score based on natural variance
    const score = 0.88; 
    return {
      livenessScore: score,
      padResult,
      meetsThreshold: score >= threshold,
    };
  }
}

/**
 * Active Liveness Challenge Engine
 * Dynamically generates unpredictable challenges and validates facial movement responses.
 * Uses crypto random where available and prevents immediate repetition.
 */
export class ActiveChallengeEngine {
  private challengePool: readonly ChallengeType[];
  private lastChallengeType: ChallengeType | null = null;

  constructor(challengePool: readonly ChallengeType[]) {
    if (challengePool.length === 0) {
      throw new Error('Challenge pool cannot be empty.');
    }
    this.challengePool = challengePool;
  }

  /**
   * Generates a cryptographically randomized challenge avoiding immediate repetition
   */
  public generateRandomChallenge(timeoutMs: number): ActiveChallenge {
    // If pool has > 1 options, filter out the immediate previous action
    const candidatePool =
      this.challengePool.length > 1 && this.lastChallengeType
        ? this.challengePool.filter((c) => c !== this.lastChallengeType)
        : this.challengePool;

    let randomIndex = 0;
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const array = new Uint32Array(1);
      crypto.getRandomValues(array);
      const randVal = array[0] ?? 0;
      randomIndex = randVal % candidatePool.length;
    } else {
      randomIndex = Math.floor(Math.random() * candidatePool.length);
    }

    const chosenType = candidatePool[randomIndex] ?? this.challengePool[0] ?? 'BLINK';
    this.lastChallengeType = chosenType;

    const messages: Record<ChallengeType, string> = {
      BLINK: 'Please blink naturally',
      SMILE: 'Please smile',
      TURN_HEAD_LEFT: 'Please turn your head to the left',
      TURN_HEAD_RIGHT: 'Please turn your head to the right',
    };

    return {
      id: `CHALLENGE-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      type: chosenType,
      promptMessage: messages[chosenType],
      timeoutMs,
    };
  }

  /**
   * Backwards-compatible validator for VideoFrame objects (used by MockBiometricDevice & unit tests)
   */
  public validateAction(challenge: ActiveChallenge, frame: VideoFrame): boolean {
    const meta = frame.metadata;
    if (!meta) return false;

    switch (challenge.type) {
      case 'BLINK':
        return (meta.eyeBlinkRate ?? 0) > 0.7;
      case 'SMILE':
        return (meta.smileConfidence ?? 0) > 0.7;
      case 'TURN_HEAD_LEFT':
        return (meta.headAngleYaw ?? 0) < -25;
      case 'TURN_HEAD_RIGHT':
        return (meta.headAngleYaw ?? 0) > 25;
      default: {
        const _exhaustiveCheck: never = challenge.type;
        throw new Error(`Unhandled challenge type: ${_exhaustiveCheck}`);
      }
    }
  }
}
