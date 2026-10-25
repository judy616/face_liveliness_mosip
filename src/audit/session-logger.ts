/**
 * Session audit logger for OCULAR Face Liveness & PAD.
 *
 * Records structured, machine-readable events for each verification session.
 * Designed for diagnostics and submission evidence.
 *
 * Privacy rules enforced here:
 * - Raw face frames are NEVER stored.
 * - PAD diagnostic details are kept in a separate log channel (padDiagnostics)
 *   from user-facing messages.
 * - No unnecessary biometric data is persisted.
 */

import { LivenessStatus, ChallengeType, WorkflowRole } from '../types/index.js';

export type AuditEventType =
  | 'SESSION_START'
  | 'PASSIVE_CHECK'
  | 'CHALLENGE_ISSUED'
  | 'CHALLENGE_SUCCESS'
  | 'CHALLENGE_FAILED'
  | 'CHALLENGE_TIMEOUT'
  | 'PAD_RESULT'
  | 'SESSION_END'
  | 'DEVICE_ERROR'
  | 'QUALITY_FAILURE';

export interface AuditEvent {
  readonly eventType: AuditEventType;
  readonly timestamp: number;           // Unix ms
  readonly sessionId: string;
  readonly details: string;             // User-facing detail
  readonly padDiagnostics?: string;     // PAD-specific detail — NEVER shown to end user
}

export interface SessionAuditLog {
  readonly sessionId: string;
  readonly role: WorkflowRole;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly outcome: LivenessStatus | null;
  readonly events: readonly AuditEvent[];
  readonly detectorVersion: string;
  readonly configVersion: string;
}

let sessionCounter = 0;

export class SessionLogger {
  private events: AuditEvent[] = [];
  private readonly sessionId: string;
  private readonly startTime: number;
  private endTime: number | null = null;
  private outcome: LivenessStatus | null = null;

  constructor(
    private readonly role: WorkflowRole,
    private readonly detectorVersion: string = 'MediaPipe-FaceLandmarker-v1',
    private readonly configVersion: string = '1.0.0'
  ) {
    sessionCounter++;
    this.sessionId = `OCULAR-${Date.now()}-${sessionCounter}`;
    this.startTime = Date.now();
    this.log('SESSION_START', `Liveness session started for role: ${role}`);
  }

  private log(
    eventType: AuditEventType,
    details: string,
    padDiagnostics?: string
  ): void {
    this.events.push({
      eventType,
      timestamp: Date.now(),
      sessionId: this.sessionId,
      details,
      padDiagnostics,
    });
  }

  public recordPassiveCheck(score: number | undefined, meetsThreshold: boolean): void {
    this.log(
      'PASSIVE_CHECK',
      meetsThreshold ? 'Passive liveness threshold met.' : 'Passive liveness threshold not met — active challenge required.',
      score !== undefined
        ? `padLiveScore=${score.toFixed(4)}, meetsThreshold=${meetsThreshold}`
        : 'padLiveScore=undefined (model UNAVAILABLE — fails closed)'
    );
  }

  public recordChallengeIssued(challengeType: ChallengeType, challengeId: string): void {
    this.log('CHALLENGE_ISSUED', `Active challenge issued: ${challengeType}`, `id=${challengeId}`);
  }

  public recordChallengeSuccess(challengeType: ChallengeType): void {
    this.log('CHALLENGE_SUCCESS', `Challenge completed: ${challengeType}`);
  }

  public recordChallengeFailed(challengeType: ChallengeType, reason: string): void {
    this.log('CHALLENGE_FAILED', `Challenge failed: ${challengeType}`, `reason=${reason}`);
  }

  public recordChallengeTimeout(challengeType: ChallengeType, elapsedMs: number): void {
    this.log(
      'CHALLENGE_TIMEOUT',
      `Challenge timed out: ${challengeType}`,
      `elapsedMs=${elapsedMs}`
    );
  }

  public recordPadResult(outcome: string, details: string): void {
    // PAD details go to padDiagnostics only — not shown to end user
    this.log('PAD_RESULT', 'PAD assessment completed.', `outcome=${outcome}, ${details}`);
  }

  public recordDeviceError(errorType: string, message: string): void {
    this.log('DEVICE_ERROR', `Camera/device error: ${errorType}`, message);
  }

  public recordQualityFailure(reason: string): void {
    this.log('QUALITY_FAILURE', `Quality gate failed: ${reason}`);
  }

  public recordSessionEnd(outcome: LivenessStatus): void {
    this.outcome = outcome;
    this.endTime = Date.now();
    const durationMs = this.endTime - this.startTime;
    this.log(
      'SESSION_END',
      `Session ended: ${outcome}`,
      `durationMs=${durationMs}`
    );
  }

  public getLog(): SessionAuditLog {
    return {
      sessionId: this.sessionId,
      role: this.role,
      startTime: this.startTime,
      endTime: this.endTime,
      outcome: this.outcome,
      events: [...this.events],
      detectorVersion: this.detectorVersion,
      configVersion: this.configVersion,
    };
  }

  /** Print a readable summary to the console (for development/diagnostics only). */
  public printSummary(): void {
    const log = this.getLog();
    const durationMs = log.endTime ? log.endTime - log.startTime : Date.now() - log.startTime;
    console.groupCollapsed(`[AUDIT] Session ${log.sessionId} | ${log.outcome ?? 'IN_PROGRESS'} | ${durationMs}ms`);
    for (const e of log.events) {
      const ts = new Date(e.timestamp).toISOString().substring(11, 23);
      console.log(`  ${ts} [${e.eventType}] ${e.details}`);
      // PAD diagnostics only in verbose/debug mode — never in production user-facing output
      if (e.padDiagnostics) {
        console.debug(`          PAD: ${e.padDiagnostics}`);
      }
    }
    console.groupEnd();
  }
}
