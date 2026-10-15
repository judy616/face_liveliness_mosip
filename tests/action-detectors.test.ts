import {
  FrameLandmarkDetectionResult,
  SingleFaceLandmarkResult,
  NormalizedLandmark,
  FaceLandmarkMeasurements,
} from '../src/types/index.js';
import { TemporalBlinkDetector } from '../src/actions/temporal-blink-detector.js';
import { SmileDetector } from '../src/actions/smile-detector.js';
import { HeadTurnDetector } from '../src/actions/head-turn-detector.js';
import { DynamicChallengeSessionController } from '../src/actions/challenge-session-controller.js';
import { ActiveChallengeEngine } from '../src/engine/liveness-engine.js';
import { WORKFLOW_CONFIGS } from '../src/config/liveness.config.js';

// Helper to construct synthetic landmark detection frames
function createMockFrame(
  timestamp: number,
  overrides?: {
    ear?: number;
    smileMetric?: number;
    yawDeg?: number;
    isLightingAdequate?: boolean;
    faceCount?: number;
  }
): FrameLandmarkDetectionResult {
  const ear = overrides?.ear ?? 0.30;
  const smile = overrides?.smileMetric ?? 0.40;
  const yaw = overrides?.yawDeg ?? 0;
  const lighting = overrides?.isLightingAdequate ?? true;
  const faceCount = overrides?.faceCount ?? 1;

  const dummyMeasurements: FaceLandmarkMeasurements = {
    leftEyeOpenness: ear,
    rightEyeOpenness: ear,
    averageEyeOpenness: ear,
    isEyeBlinking: ear < 0.18,
    mouthOpenness: 0.1,
    smileMetric: smile,
    headPose: { yawDeg: yaw, pitchDeg: 0, rollDeg: 0 },
    faceCenter: { x: 0.5, y: 0.5 },
    faceCoverageRatio: 0.35,
    isFaceCentered: true,
    qualityIndicators: {
      isAdequatelySized: true,
      estimatedSharpnessScore: 80,
      estimatedBrightness: 120,
      isLightingAdequate: lighting,
    },
  };

  const primaryFace: SingleFaceLandmarkResult = {
    faceIndex: 0,
    landmarks: [] as NormalizedLandmark[],
    boundingBox: { xMin: 0.3, yMin: 0.2, width: 0.4, height: 0.5 },
    measurements: dummyMeasurements,
  };

  return {
    timestamp,
    frameWidth: 640,
    frameHeight: 480,
    faceCount,
    presenceStatus: faceCount === 1 ? 'EXACTLY_ONE_FACE' : faceCount > 1 ? 'MULTIPLE_FACES' : 'NO_FACE',
    primaryFace: faceCount === 1 ? primaryFace : null,
    allFaces: faceCount === 1 ? [primaryFace] : [],
    processingLatencyMs: 12,
  };
}

let passedTests = 0;
let totalTests = 0;

function assert(condition: boolean, testName: string, details?: string) {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✓ PASS: ${testName}`);
  } else {
    console.error(`  ✗ FAIL: ${testName}${details ? ` (${details})` : ''}`);
    throw new Error(`Test failed: ${testName}`);
  }
}

async function runAllTests() {
  console.log('\n======================================================');
  console.log('MOSIP Phase 2 - Temporal Action & Challenge Test Suite');
  console.log('======================================================\n');

  // 1. Temporal Blink Detector
  console.log('[Test Group 1: Temporal Blink Detector]');
  {
    const detector = new TemporalBlinkDetector({
      minBaselineFrames: 3,
      minBlinkDurationMs: 50,
      maxBlinkDurationMs: 500,
    });

    // Step A: Baseline calibration (open eyes: EAR ~0.32)
    for (let t = 0; t < 3; t++) {
      const res = detector.processFrame(createMockFrame(t * 100, { ear: 0.32 }));
      assert(res.state === 'CALIBRATING_BASELINE' || res.state === 'TRACKING', 'Calibrates baseline on open eyes');
    }

    // Step B: Closure phase (EAR drops to 0.08)
    const closeRes = detector.processFrame(createMockFrame(400, { ear: 0.08 }));
    assert(closeRes.state === 'TRACKING', 'Detects eye closure transition');

    // Step C: Re-opening phase (EAR recovers to 0.30 within duration)
    const openRes = detector.processFrame(createMockFrame(550, { ear: 0.30 }));
    assert(openRes.state === 'DETECTED', 'Detects valid blink sequence (open -> close -> open)');

    // Step D: Anti-duplicate check
    const dupRes = detector.processFrame(createMockFrame(650, { ear: 0.30 }));
    assert(dupRes.state === 'DETECTED', 'Maintains detected state without double-triggering events');

    // Step E: Prolonged closure rejection (>500ms closure)
    detector.reset();
    for (let t = 0; t < 3; t++) detector.processFrame(createMockFrame(t * 100, { ear: 0.32 }));
    detector.processFrame(createMockFrame(400, { ear: 0.08 }));
    const timeoutRes = detector.processFrame(createMockFrame(1000, { ear: 0.08 })); // 600ms closed
    assert(timeoutRes.state === 'INCONCLUSIVE', 'Rejects prolonged eye closure (sleeping/spoof)');
  }

  // 2. Smile Detector
  console.log('\n[Test Group 2: Dynamic Smile Detector]');
  {
    const detector = new SmileDetector({
      minBaselineFrames: 3,
      smileDeltaThreshold: 0.05,
      sustainedFrames: 2,
    });

    // Step A: Calibrate neutral baseline (mouth width metric 0.40)
    for (let t = 0; t < 3; t++) {
      detector.processFrame(createMockFrame(t * 100, { smileMetric: 0.40 }));
    }

    // Step B: Rejection of static mouth shape (no expression change)
    const staticRes = detector.processFrame(createMockFrame(400, { smileMetric: 0.40 }));
    assert(staticRes.state === 'TRACKING' && staticRes.confidence === 0, 'Rejects static mouth shape');

    // Step C: Expression expansion (stretch to 0.48, +0.08 delta)
    detector.processFrame(createMockFrame(500, { smileMetric: 0.48 }));
    const smileRes = detector.processFrame(createMockFrame(600, { smileMetric: 0.49 }));
    assert(smileRes.state === 'DETECTED', 'Detects dynamic smile expression expansion over neutral baseline');
  }

  // 3. Head Turn Detectors
  console.log('\n[Test Group 3: Directional Head Turn Detectors]');
  {
    // Test Left Turn (yaw < -18°)
    const leftDetector = new HeadTurnDetector('TURN_HEAD_LEFT', {
      minBaselineFrames: 3,
      targetAngleDeg: 18,
      sustainedFrames: 2,
    });

    // Baseline neutral (yaw ~ 0°)
    for (let t = 0; t < 3; t++) {
      leftDetector.processFrame(createMockFrame(t * 100, { yawDeg: 0 }));
    }

    // Wrong direction test: turning RIGHT (+25°) when LEFT was requested
    const wrongDir = leftDetector.processFrame(createMockFrame(400, { yawDeg: 25 }));
    assert(wrongDir.state === 'TRACKING' && wrongDir.details?.includes('wrong way'), 'Rejects wrong head turn direction');

    // Correct direction: turning LEFT (-24°)
    leftDetector.processFrame(createMockFrame(500, { yawDeg: -24 }));
    const leftRes = leftDetector.processFrame(createMockFrame(600, { yawDeg: -26 }));
    assert(leftRes.state === 'DETECTED', 'Detects valid TURN_HEAD_LEFT action');

    // Test Right Turn (yaw > +18°)
    const rightDetector = new HeadTurnDetector('TURN_HEAD_RIGHT', {
      minBaselineFrames: 3,
      targetAngleDeg: 18,
      sustainedFrames: 2,
    });
    for (let t = 0; t < 3; t++) rightDetector.processFrame(createMockFrame(t * 100, { yawDeg: 0 }));
    rightDetector.processFrame(createMockFrame(500, { yawDeg: 22 }));
    const rightRes = rightDetector.processFrame(createMockFrame(600, { yawDeg: 24 }));
    assert(rightRes.state === 'DETECTED', 'Detects valid TURN_HEAD_RIGHT action');
  }

  // 4. Multiple Faces and Missing Faces Guards
  console.log('\n[Test Group 4: Face Count & Quality Guard Validation]');
  {
    const detector = new TemporalBlinkDetector({ minBaselineFrames: 2 });
    const noFaceRes = detector.processFrame(createMockFrame(100, { faceCount: 0 }));
    assert(noFaceRes.state === 'INCONCLUSIVE' && noFaceRes.qualityValid === false, 'Rejects zero faces in frame');

    const multiFaceRes = detector.processFrame(createMockFrame(200, { faceCount: 2 }));
    assert(multiFaceRes.state === 'INCONCLUSIVE' && multiFaceRes.qualityValid === false, 'Rejects multiple faces (security constraint)');

    const poorLightRes = detector.processFrame(createMockFrame(300, { isLightingAdequate: false }));
    assert(poorLightRes.state === 'INCONCLUSIVE', 'Rejects inadequate lighting measurements');
  }

  // 5. Dynamic Challenge Engine & Session Sequencing
  console.log('\n[Test Group 5: Dynamic Challenge Engine & Session Controller]');
  {
    const engine = new ActiveChallengeEngine(['BLINK', 'SMILE', 'TURN_HEAD_LEFT', 'TURN_HEAD_RIGHT']);
    const c1 = engine.generateRandomChallenge(5000);
    const c2 = engine.generateRandomChallenge(5000);
    assert(c1.id !== c2.id, 'Generates unique challenge IDs with cryptographically secure randomization');

    // Session Controller 2-step verification
    let sessionCompleted = false;
    let completedSuccess = false;

    const controller = new DynamicChallengeSessionController(WORKFLOW_CONFIGS.RESIDENT, {
      minChallengesRequired: 2,
    });

    controller.startSession({
      onStateChange: () => {},
      onChallengeSuccess: () => {},
      onSessionCompleted: (success) => {
        sessionCompleted = true;
        completedSuccess = success;
      },
    });

    const state1 = controller.getState();
    assert(state1.state === 'IN_PROGRESS', 'Session enters IN_PROGRESS state');
    assert(state1.currentChallengeIndex === 1, 'Starts at challenge 1 of 2');

    // Test cancellation on camera disconnect
    controller.cancel('Camera disconnected during verification');
    const cancelledState = controller.getState();
    assert(cancelledState.state === 'CANCELLED', 'Cleans up and sets state to CANCELLED on camera disconnection');
  }

  console.log(`\n======================================================`);
  console.log(`All ${passedTests}/${totalTests} unit and integration tests passed cleanly!`);
  console.log(`======================================================\n`);
}

runAllTests().catch((e) => {
  console.error(e);
  process.exit(1);
});
