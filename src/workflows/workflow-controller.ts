import {
  VideoFrame,
  WorkflowConfig,
  LivenessStatus,
  ActiveChallenge,
  PadAssessmentResult,
} from '../types/index.js';
import {
  PassiveLivenessAnalyzer,
  ActiveChallengeEngine,
  PresentationAttackDetector,
} from '../engine/liveness-engine.js';
import { BiometricDevice } from '../devices/mock-device.js';

export interface WorkflowResult {
  readonly success: boolean;
  readonly status: LivenessStatus;
  readonly message: string;
  readonly attempts: number;
  readonly finalFrame?: VideoFrame;
  readonly padResult?: PadAssessmentResult;
}

/**
 * Orchestrates the Hybrid Passive -> Active Face Capture Workflow
 * Implements Resident, Operator, and Supervisor Flows from MOSIP Decode 04
 */
export class FaceLivenessWorkflowController {
  private config: WorkflowConfig;
  private passiveAnalyzer: PassiveLivenessAnalyzer;
  private challengeEngine: ActiveChallengeEngine;
  private padDetector: PresentationAttackDetector;

  constructor(config: WorkflowConfig) {
    this.config = config;
    this.passiveAnalyzer = new PassiveLivenessAnalyzer();
    this.challengeEngine = new ActiveChallengeEngine(config.challengePool);
    this.padDetector = new PresentationAttackDetector();
  }

  public async runWorkflow(device: BiometricDevice): Promise<WorkflowResult> {
    console.log(`\n======================================================`);
    console.log(`[MOSIP CLIENT] Initiating Face Liveness for role: ${this.config.role}`);
    console.log(`Threshold: ${this.config.passiveConfidenceThreshold} | Active Enabled: ${this.config.activeLivenessEnabled}`);
    console.log(`======================================================`);

    let attempts = 0;

    while (attempts < this.config.maxRetries) {
      attempts++;
      console.log(`\n--- Attempt ${attempts}/${this.config.maxRetries} ---`);

      const result = await this.executeSingleAttempt(device);
      if (result.success) {
        return { ...result, attempts };
      }

      // If presentation attack spoof detected, reject immediately (security requirement)
      if (result.status === 'FAILED_PAD_ATTACK') {
        console.warn(`[SECURITY ALERT] PAD Attack detected! Immediate halt.`);
        return { ...result, attempts };
      }

      console.log(`[INFO] Attempt ${attempts} unsuccessful: ${result.message}. Retrying...`);
    }

    return {
      success: false,
      status: 'FAILED_MAX_RETRIES_EXCEEDED',
      message: `Max retries (${this.config.maxRetries}) exceeded. Please refer to supervisor or manual fallback.`,
      attempts,
    };
  }

  private executeSingleAttempt(device: BiometricDevice): Promise<Omit<WorkflowResult, 'attempts'>> {
    return new Promise((resolve) => {
      let currentStatus: LivenessStatus = 'CHECKING_PASSIVE';
      let activeChallenge: ActiveChallenge | null = null;
      let challengeStartTime = 0;
      let frameReceivedCount = 0;

      const onFrame = (frame: VideoFrame) => {
        frameReceivedCount++;

        // 1. Presentation Attack Detection on every frame (ISO 30107)
        const padResult = this.padDetector.evaluate(frame);
        if (padResult.isAttackDetected) {
          device.stopStream();
          resolve({
            success: false,
            status: 'FAILED_PAD_ATTACK',
            message: `Presentation Attack Detected: ${padResult.attackType} (${padResult.details})`,
            padResult,
          });
          return;
        }

        // 2. Initial Passive Liveness Phase
        if (currentStatus === 'CHECKING_PASSIVE') {
          // Accumulate a few frames for passive analysis
          if (frameReceivedCount >= 3) {
            const passiveRes = this.passiveAnalyzer.analyzeFrame(
              frame,
              this.config.passiveConfidenceThreshold
            );

            console.log(`[PASSIVE EVALUATION] Score: ${passiveRes.livenessScore.toFixed(2)} | Target: ${this.config.passiveConfidenceThreshold}`);

            if (passiveRes.meetsThreshold) {
              device.stopStream();
              console.log(`[SUCCESS] Passive threshold met! Face capture complete.`);
              resolve({
                success: true,
                status: 'VERIFIED_SUCCESS',
                message: 'Passive face liveness verified successfully.',
                finalFrame: frame,
              });
              return;
            } else {
              // Passive threshold not met: transition to Active Challenge
              if (this.config.activeLivenessEnabled) {
                currentStatus = 'ACTIVE_CHALLENGE_IN_PROGRESS';
                activeChallenge = this.challengeEngine.generateRandomChallenge(
                  this.config.challengeTimeoutMs
                );
                challengeStartTime = Date.now();
                console.log(`[ACTIVE CHALLENGE PROMPT] >>> ${activeChallenge.promptMessage} <<<`);
              } else {
                device.stopStream();
                resolve({
                  success: false,
                  status: 'CHECKING_PASSIVE',
                  message: 'Passive liveness score below threshold and active challenges disabled.',
                });
                return;
              }
            }
          }
          return;
        }

        // 3. Active Challenge Evaluation Phase
        if (currentStatus === 'ACTIVE_CHALLENGE_IN_PROGRESS' && activeChallenge) {
          const elapsed = Date.now() - challengeStartTime;

          if (elapsed > activeChallenge.timeoutMs) {
            device.stopStream();
            console.warn(`[TIMEOUT] Challenge "${activeChallenge.promptMessage}" timed out.`);
            resolve({
              success: false,
              status: 'FAILED_TIMEOUT',
              message: `Active challenge timed out after ${activeChallenge.timeoutMs}ms`,
            });
            return;
          }

          const actionValidated = this.challengeEngine.validateAction(activeChallenge, frame);
          if (actionValidated) {
            device.stopStream();
            console.log(`[SUCCESS] Facial action "${activeChallenge.type}" detected and verified!`);
            resolve({
              success: true,
              status: 'VERIFIED_SUCCESS',
              message: `Active challenge "${activeChallenge.promptMessage}" satisfied.`,
              finalFrame: frame,
            });
            return;
          }
        }
      };

      device.startStream(onFrame).catch((err) => {
        resolve({
          success: false,
          status: 'IDLE',
          message: `Device streaming error: ${err.message}`,
        });
      });
    });
  }
}
