import {
  ActiveChallenge,
  ActiveChallengeSessionState,
  ChallengeExecutionState,
  ChallengeType,
  FacialActionEvent,
  FrameLandmarkDetectionResult,
  WorkflowConfig,
} from '../types/index.js';
import { ActiveChallengeEngine } from '../engine/liveness-engine.js';
import { CompositeFacialActionDetector } from './composite-action-detector.js';

export interface ChallengeSessionCallbacks {
  readonly onStateChange: (state: ActiveChallengeSessionState) => void;
  readonly onChallengeSuccess: (challenge: ActiveChallenge, event: FacialActionEvent) => void;
  readonly onSessionCompleted: (success: boolean, message: string) => void;
}

export interface SessionOptions {
  readonly minChallengesRequired?: number; // Default 2 challenges per session for robust verification
}

/**
 * Orchestrates dynamic multi-step active challenges with landmark detectors.
 * Manages observation windows, timeout enforcement, non-repetition, and retry tracking.
 */
export class DynamicChallengeSessionController {
  private config: WorkflowConfig;
  private challengeEngine: ActiveChallengeEngine;
  private actionDetector: CompositeFacialActionDetector;
  private totalChallengesRequired: number;

  private currentAttempt: number = 0;
  private completedCount: number = 0;
  private currentChallenge: ActiveChallenge | null = null;
  private challengeStartTime: number = 0;
  private challengeDeadline: number = 0;
  private state: ChallengeExecutionState = 'PENDING';
  private lastEvent: FacialActionEvent | null = null;
  private failureReason: string | undefined;

  private callbacks: ChallengeSessionCallbacks | null = null;
  private isCancelled: boolean = false;

  constructor(config: WorkflowConfig, options: SessionOptions = {}) {
    this.config = config;
    this.totalChallengesRequired = options.minChallengesRequired ?? 2;
    this.challengeEngine = new ActiveChallengeEngine(config.challengePool);
    this.actionDetector = new CompositeFacialActionDetector();
  }

  public getState(): ActiveChallengeSessionState {
    const now = Date.now();
    const elapsed = this.currentChallenge ? Math.max(0, now - this.challengeStartTime) : 0;
    const remaining = this.currentChallenge ? Math.max(0, this.challengeDeadline - now) : 0;

    return {
      currentChallenge: this.currentChallenge,
      state: this.state,
      currentChallengeIndex: this.completedCount + 1,
      totalChallengesRequired: this.totalChallengesRequired,
      currentAttempt: this.currentAttempt,
      maxRetries: this.config.maxRetries,
      elapsedMs: elapsed,
      remainingMs: remaining,
      lastEvent: this.lastEvent,
      failureReason: this.failureReason,
    };
  }

  /**
   * Starts a new challenge verification session
   */
  public startSession(callbacks: ChallengeSessionCallbacks): void {
    this.callbacks = callbacks;
    this.isCancelled = false;
    this.currentAttempt = 1;
    this.completedCount = 0;
    this.failureReason = undefined;
    this.startNextChallenge();
  }

  private startNextChallenge(): void {
    if (this.isCancelled) return;

    this.currentChallenge = this.challengeEngine.generateRandomChallenge(
      this.config.challengeTimeoutMs
    );
    this.state = 'IN_PROGRESS';
    this.challengeStartTime = Date.now();
    this.challengeDeadline = this.challengeStartTime + this.currentChallenge.timeoutMs;
    this.lastEvent = null;
    this.failureReason = undefined;

    // Reset and arm the detector specifically for this newly selected action
    this.actionDetector.setAction(this.currentChallenge.type);

    this.emitState();
  }

  /**
   * Consumes a live landmark frame and verifies progress
   */
  public processFrame(frame: FrameLandmarkDetectionResult): void {
    if (this.isCancelled || this.state !== 'IN_PROGRESS' || !this.currentChallenge) {
      return;
    }

    const now = frame.timestamp > 0 ? frame.timestamp : Date.now();

    // 1. Guard Stale Frames / Observation Window Deadline
    if (now > this.challengeDeadline) {
      this.handleTimeout();
      return;
    }

    // 2. Reject frame if multiple faces or no face present
    if (frame.presenceStatus !== 'EXACTLY_ONE_FACE') {
      this.lastEvent = {
        actionType: this.currentChallenge.type,
        timestamp: now,
        confidence: 0,
        state: 'INCONCLUSIVE',
        qualityValid: false,
        failureReason:
          frame.presenceStatus === 'MULTIPLE_FACES'
            ? 'Multiple faces detected. Capture halted.'
            : 'Face not found. Keep face centered.',
      };
      this.emitState();
      return;
    }

    // 3. Process frame with specialized action detector
    const event = this.actionDetector.processFrame(frame);
    this.lastEvent = event;

    // 4. Verify if matching action was detected strictly within the observation window
    if (
      event.state === 'DETECTED' &&
      event.actionType === this.currentChallenge.type &&
      event.timestamp >= this.challengeStartTime
    ) {
      this.handleChallengeSuccess(event);
      return;
    }

    this.emitState();
  }

  private handleChallengeSuccess(event: FacialActionEvent): void {
    if (!this.currentChallenge) return;

    this.callbacks?.onChallengeSuccess(this.currentChallenge, event);
    this.completedCount++;

    if (this.completedCount >= this.totalChallengesRequired) {
      this.state = 'SUCCEEDED';
      this.emitState();
      this.callbacks?.onSessionCompleted(
        true,
        `All ${this.totalChallengesRequired} active challenges completed successfully!`
      );
      this.cleanup();
    } else {
      // Progress to subsequent challenge in sequence
      this.startNextChallenge();
    }
  }

  private handleTimeout(): void {
    this.state = 'TIMED_OUT';
    this.failureReason = `Challenge "${this.currentChallenge?.promptMessage}" timed out.`;
    this.emitState();

    if (this.currentAttempt < this.config.maxRetries) {
      this.currentAttempt++;
      // Reset completed count on retry attempt for complete verification
      this.completedCount = 0;
      setTimeout(() => {
        if (!this.isCancelled) {
          this.startNextChallenge();
        }
      }, 1000);
    } else {
      this.state = 'FAILED';
      this.failureReason = `Max retry limit (${this.config.maxRetries}) reached. Verification failed.`;
      this.emitState();
      this.callbacks?.onSessionCompleted(false, this.failureReason);
      this.cleanup();
    }
  }

  public cancel(reason: string = 'Session cancelled.'): void {
    this.isCancelled = true;
    this.state = 'CANCELLED';
    this.failureReason = reason;
    this.emitState();
    this.cleanup();
  }

  private cleanup(): void {
    this.actionDetector.reset();
    this.currentChallenge = null;
  }

  private emitState(): void {
    this.callbacks?.onStateChange(this.getState());
  }
}
