/**
 * Core domain types for MOSIP Face Liveness and PAD (Presentation Attack Detection)
 * Conforming to ISO/IEC 30107 and MOSIP Device Specifications.
 */

export type WorkflowRole = 'RESIDENT' | 'OPERATOR' | 'SUPERVISOR';

export type BiometricDeviceLevel = 'L0' | 'L1';

export interface VideoFrame {
  readonly frameId: number;
  readonly timestamp: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  /** Synthetic or measured simulated metadata */
  readonly metadata?: {
    readonly isPhotoPaperTexture?: boolean;
    readonly isScreenPixelGrid?: boolean;
    readonly isVideoReplayArtifacts?: boolean;
    readonly padLiveScore?: number;
    readonly padModelVersion?: string;
    readonly eyeBlinkRate?: number;
    readonly smileConfidence?: number;
    readonly headAngleYaw?: number; // negative = left, positive = right
  };
}

/** ISO/IEC 30107 Attack Types */
export type PresentationAttackType =
  | 'PRINTED_PHOTO'
  | 'DIGITAL_DISPLAY_SCREEN'
  | 'VIDEO_REPLAY'
  | '3D_MASK'
  | 'UNKNOWN_SPOOF';

export interface PadAssessmentResult {
  readonly isAttackDetected: boolean;
  readonly attackType?: PresentationAttackType;
  readonly attackConfidence: number; // 0.0 to 1.0
  readonly details: string;
}

export interface PassiveLivenessResult {
  readonly livenessScore: number; // 0.0 to 1.0
  readonly padResult: PadAssessmentResult;
  readonly meetsThreshold: boolean;
}

export type ChallengeType = 'BLINK' | 'SMILE' | 'TURN_HEAD_LEFT' | 'TURN_HEAD_RIGHT';

export interface ActiveChallenge {
  readonly id: string;
  readonly type: ChallengeType;
  readonly promptMessage: string;
  readonly timeoutMs: number;
}

export type LivenessStatus =
  | 'IDLE'
  | 'CHECKING_PASSIVE'
  | 'ACTIVE_CHALLENGE_REQUIRED'
  | 'ACTIVE_CHALLENGE_IN_PROGRESS'
  | 'VERIFIED_SUCCESS'
  | 'FAILED_PAD_ATTACK'
  | 'FAILED_TIMEOUT'
  | 'FAILED_MAX_RETRIES_EXCEEDED';

export interface WorkflowConfig {
  readonly role: WorkflowRole;
  readonly passiveConfidenceThreshold: number; // e.g. 0.85
  readonly activeLivenessEnabled: boolean;
  readonly challengeTimeoutMs: number;
  readonly maxRetries: number;
  readonly challengePool: readonly ChallengeType[];
  /** Minimum number of sequential challenges required for active verification. */
  readonly minChallengesRequired: number;
}

// ============================================================================
// Real Camera Acquisition and Landmark Measurement Types
// ============================================================================

export type FacePresenceStatus = 'NO_FACE' | 'EXACTLY_ONE_FACE' | 'MULTIPLE_FACES';

export interface NormalizedLandmark {
  readonly x: number; // 0.0 to 1.0
  readonly y: number; // 0.0 to 1.0
  readonly z: number; // Depth relative to face center
}

export interface BoundingBox {
  readonly xMin: number;
  readonly yMin: number;
  readonly width: number;
  readonly height: number;
}

export interface HeadPoseEstimation {
  readonly yawDeg: number;   // Left (-) / Right (+)
  readonly pitchDeg: number; // Down (-) / Up (+)
  readonly rollDeg: number;  // Tilt left (-) / Tilt right (+)
}

export interface FaceLandmarkMeasurements {
  /** Eye Openness / Aspect Ratio (approx 0.0 closed to ~0.4+ wide open) */
  readonly leftEyeOpenness: number;
  readonly rightEyeOpenness: number;
  readonly averageEyeOpenness: number;
  readonly isEyeBlinking: boolean;

  /** Mouth Openness / Aspect Ratio (approx 0.0 closed to ~0.5+ open) */
  readonly mouthOpenness: number;
  /** Mouth Smile Stretch metric */
  readonly smileMetric: number;

  /** Estimated head pose angles in degrees */
  readonly headPose: HeadPoseEstimation;

  /** Face positioning in frame (0.0 to 1.0 normalized center coords) */
  readonly faceCenter: { readonly x: number; readonly y: number };
  readonly faceCoverageRatio: number; // Bounding box area / frame area
  readonly isFaceCentered: boolean;

  /** Basic image quality assessment */
  readonly qualityIndicators: {
    readonly isAdequatelySized: boolean; // coverage between 15% and 75%
    readonly estimatedSharpnessScore: number;
    readonly estimatedBrightness: number; // 0 to 255
    readonly isLightingAdequate: boolean;
  };
}

export interface SingleFaceLandmarkResult {
  readonly faceIndex: number;
  readonly landmarks: readonly NormalizedLandmark[];
  readonly boundingBox: BoundingBox;
  readonly measurements: FaceLandmarkMeasurements;
}

export interface FrameLandmarkDetectionResult {
  readonly timestamp: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly faceCount: number;
  readonly presenceStatus: FacePresenceStatus;
  /** Populated only if presenceStatus is EXACTLY_ONE_FACE; null for NO_FACE or MULTIPLE_FACES */
  readonly primaryFace: SingleFaceLandmarkResult | null;
  readonly allFaces: readonly SingleFaceLandmarkResult[];
  readonly processingLatencyMs: number;
}

export type CameraErrorType =
  | 'BROWSER_UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_IN_USE'
  | 'STREAM_DISCONNECTED'
  | 'DETECTOR_INIT_FAILED'
  | 'UNKNOWN';

export interface CameraErrorInfo {
  readonly type: CameraErrorType;
  readonly message: string;
  readonly originalError?: unknown;
}

// ============================================================================
// Phase 2: Action Detection & Challenge State Machine Types
// ============================================================================

export type ActionDetectionState =
  | 'NOT_STARTED'
  | 'CALIBRATING_BASELINE'
  | 'TRACKING'
  | 'DETECTED'
  | 'INCONCLUSIVE';

export interface FacialActionEvent {
  readonly actionType: ChallengeType;
  readonly timestamp: number;
  readonly confidence: number; // 0.0 to 1.0 (where meaningfully defined)
  readonly state: ActionDetectionState;
  readonly qualityValid: boolean;
  readonly details?: string;
  readonly failureReason?: string;
}

export type ChallengeExecutionState =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

export interface ActiveChallengeSessionState {
  readonly currentChallenge: ActiveChallenge | null;
  readonly state: ChallengeExecutionState;
  readonly currentChallengeIndex: number; // 1-based (e.g. 1 of 2)
  readonly totalChallengesRequired: number;
  readonly currentAttempt: number;
  readonly maxRetries: number;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly lastEvent: FacialActionEvent | null;
  readonly failureReason?: string;
}
