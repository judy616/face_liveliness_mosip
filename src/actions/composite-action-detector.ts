import {
  ChallengeType,
  FacialActionEvent,
  FrameLandmarkDetectionResult,
} from '../types/index.js';
import { IFacialActionDetector } from './action-detector-interface.js';
import { TemporalBlinkDetector } from './temporal-blink-detector.js';
import { SmileDetector } from './smile-detector.js';
import { HeadTurnDetector } from './head-turn-detector.js';

/**
 * Composite Action Detector routing evaluation to the specialized detector for a given action.
 */
export class CompositeFacialActionDetector implements IFacialActionDetector {
  private activeDetector: IFacialActionDetector;
  private currentAction: ChallengeType;

  constructor(initialAction: ChallengeType = 'BLINK') {
    this.currentAction = initialAction;
    this.activeDetector = this.createDetector(initialAction);
  }

  get supportedAction(): ChallengeType {
    return this.currentAction;
  }

  public setAction(action: ChallengeType): void {
    if (this.currentAction !== action) {
      this.currentAction = action;
      this.activeDetector = this.createDetector(action);
    } else {
      this.activeDetector.reset();
    }
  }

  private createDetector(action: ChallengeType): IFacialActionDetector {
    switch (action) {
      case 'BLINK':
        return new TemporalBlinkDetector();
      case 'SMILE':
        return new SmileDetector();
      case 'TURN_HEAD_LEFT':
        return new HeadTurnDetector('TURN_HEAD_LEFT');
      case 'TURN_HEAD_RIGHT':
        return new HeadTurnDetector('TURN_HEAD_RIGHT');
      default: {
        const _exhaustive: never = action;
        throw new Error(`Unsupported action type: ${_exhaustive}`);
      }
    }
  }

  public reset(): void {
    this.activeDetector.reset();
  }

  public processFrame(frame: FrameLandmarkDetectionResult): FacialActionEvent {
    return this.activeDetector.processFrame(frame);
  }
}
