import { BrowserCameraSource } from './camera/camera-source.js';
import { MediaPipeFaceLandmarkDetector } from './vision/mediapipe-detector.js';
import { RealtimeFaceAcquisitionController } from './camera/acquisition-controller.js';
import { renderLandmarkOverlay } from './vision/overlay-renderer.js';
import {
  FrameLandmarkDetectionResult,
  CameraErrorInfo,
  ActiveChallengeSessionState,
} from './types/index.js';
import { WORKFLOW_CONFIGS } from './config/liveness.config.js';
import { DynamicChallengeSessionController } from './actions/challenge-session-controller.js';

// DOM Element references
const videoEl = document.getElementById('webcamVideo') as HTMLVideoElement;
const canvasEl = document.getElementById('overlayCanvas') as HTMLCanvasElement;
const btnStart = document.getElementById('btnStart') as HTMLButtonElement;
const btnStop = document.getElementById('btnStop') as HTMLButtonElement;
const btnStartChallenge = document.getElementById('btnStartChallenge') as HTMLButtonElement;
const chkLandmarks = document.getElementById('chkLandmarks') as HTMLInputElement;
const chkBbox = document.getElementById('chkBbox') as HTMLInputElement;
const fpsDisplay = document.getElementById('fpsDisplay') as HTMLElement;
const statusText = document.getElementById('statusText') as HTMLElement;
const statusDot = document.getElementById('statusDot') as HTMLElement;
const presenceStatusBadge = document.getElementById('presenceStatusBadge') as HTMLElement;
const presenceAlert = document.getElementById('presenceAlert') as HTMLElement;
const errorBanner = document.getElementById('errorBanner') as HTMLElement;
const errorMessage = document.getElementById('errorMessage') as HTMLElement;

// Challenge HUD DOM
const challengeHud = document.getElementById('challengeHud') as HTMLElement;
const challengeStepBadge = document.getElementById('challengeStepBadge') as HTMLElement;
const challengePromptText = document.getElementById('challengePromptText') as HTMLElement;
const challengeProgressBar = document.getElementById('challengeProgressBar') as HTMLElement;
const challengeSubtext = document.getElementById('challengeSubtext') as HTMLElement;
const challengeStateBadge = document.getElementById('challengeStateBadge') as HTMLElement;
const valAttempt = document.getElementById('valAttempt') as HTMLElement;
const valTimer = document.getElementById('valTimer') as HTMLElement;
const valActionFeedback = document.getElementById('valActionFeedback') as HTMLElement;
const sessionResultBanner = document.getElementById('sessionResultBanner') as HTMLElement;

// Telemetry fields
const valEar = document.getElementById('valEar') as HTMLElement;
const valBlink = document.getElementById('valBlink') as HTMLElement;
const valMar = document.getElementById('valMar') as HTMLElement;
const valSmile = document.getElementById('valSmile') as HTMLElement;
const valYaw = document.getElementById('valYaw') as HTMLElement;
const valPitch = document.getElementById('valPitch') as HTMLElement;
const valRoll = document.getElementById('valRoll') as HTMLElement;
const valLatency = document.getElementById('valLatency') as HTMLElement;
const valCentered = document.getElementById('valCentered') as HTMLElement;
const valCoverage = document.getElementById('valCoverage') as HTMLElement;
const valBrightness = document.getElementById('valBrightness') as HTMLElement;
const valLighting = document.getElementById('valLighting') as HTMLElement;

// Camera & Detector setup
const cameraSource = new BrowserCameraSource({
  idealWidth: 1280,
  idealHeight: 720,
  idealFps: 30,
  facingMode: 'user',
});

const detector = new MediaPipeFaceLandmarkDetector();
const controller = new RealtimeFaceAcquisitionController(cameraSource, detector);

// Active Challenge Session Controller (Resident Policy: 2 sequential challenges)
const challengeController = new DynamicChallengeSessionController(WORKFLOW_CONFIGS.RESIDENT, {
  minChallengesRequired: 2,
});

function setStatus(text: string, type: 'idle' | 'active' | 'warning' | 'error') {
  statusText.textContent = text;
  statusDot.className = `indicator-dot dot-${type}`;
}

function showError(err: CameraErrorInfo) {
  errorBanner.classList.remove('hidden');
  errorMessage.textContent = `${err.type}: ${err.message}`;
  setStatus(err.message, 'error');
}

function clearError() {
  errorBanner.classList.add('hidden');
  errorMessage.textContent = '';
}

function updateChallengeUI(state: ActiveChallengeSessionState) {
  challengeStateBadge.textContent = state.state;
  valAttempt.textContent = `${state.currentAttempt} / ${state.maxRetries}`;
  valTimer.textContent = `${(state.remainingMs / 1000).toFixed(1)} s`;

  if (state.state === 'IN_PROGRESS' && state.currentChallenge) {
    challengeHud.classList.remove('hidden');
    challengeStepBadge.textContent = `Challenge ${state.currentChallengeIndex} of ${state.totalChallengesRequired}`;
    challengePromptText.textContent = state.currentChallenge.promptMessage;

    const totalMs = state.currentChallenge.timeoutMs;
    const progressPercent = Math.max(0, Math.min(100, (state.remainingMs / totalMs) * 100));
    challengeProgressBar.style.width = `${progressPercent}%`;

    if (state.lastEvent?.details) {
      challengeSubtext.textContent = state.lastEvent.details;
      valActionFeedback.textContent = state.lastEvent.details;
    } else if (state.lastEvent?.failureReason) {
      challengeSubtext.textContent = state.lastEvent.failureReason;
      valActionFeedback.textContent = state.lastEvent.failureReason;
    } else {
      challengeSubtext.textContent = 'Awaiting facial movement...';
      valActionFeedback.textContent = 'Tracking action...';
    }
  } else {
    challengeHud.classList.add('hidden');
  }
}

function updateTelemetry(result: FrameLandmarkDetectionResult) {
  // Sync canvas size to video aspect ratio
  if (canvasEl.width !== videoEl.videoWidth || canvasEl.height !== videoEl.videoHeight) {
    if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
      canvasEl.width = videoEl.videoWidth;
      canvasEl.height = videoEl.videoHeight;
    }
  }

  // 1. Process Live Frame through Dynamic Challenge Controller
  challengeController.processFrame(result);

  // 2. Render Overlay
  renderLandmarkOverlay(canvasEl, result, {
    drawBoundingBox: chkBbox.checked,
    drawLandmarks: chkLandmarks.checked,
    drawFaceMetrics: true,
  });

  // 3. Presence Status Badge
  presenceStatusBadge.textContent = result.presenceStatus;
  presenceStatusBadge.className = 'presence-indicator';

  if (result.presenceStatus === 'EXACTLY_ONE_FACE') {
    presenceStatusBadge.classList.add('status-exactly-one');
    presenceAlert.classList.add('hidden');
  } else if (result.presenceStatus === 'MULTIPLE_FACES') {
    presenceStatusBadge.classList.add('status-multiple');
    presenceAlert.className = 'presence-alert alert-multiple';
    presenceAlert.textContent = `Multiple Faces Detected (${result.faceCount}). Only 1 face allowed.`;
    presenceAlert.classList.remove('hidden');
  } else {
    presenceStatusBadge.classList.add('status-no-face');
    presenceAlert.className = 'presence-alert alert-none';
    presenceAlert.textContent = 'No Face Detected. Position your face in front of the camera.';
    presenceAlert.classList.remove('hidden');
  }

  // 4. Primary Face Telemetry
  valLatency.textContent = `${result.processingLatencyMs.toFixed(1)} ms`;

  const primary = result.primaryFace;
  if (primary) {
    const m = primary.measurements;
    valEar.textContent = m.averageEyeOpenness.toFixed(3);
    valBlink.textContent = m.isEyeBlinking ? 'BLINKING' : 'OPEN';
    valBlink.style.color = m.isEyeBlinking ? '#f43f5e' : '#34d399';

    valMar.textContent = m.mouthOpenness.toFixed(3);
    valSmile.textContent = `${(m.smileMetric * 100).toFixed(0)}%`;

    valYaw.textContent = `${m.headPose.yawDeg > 0 ? '+' : ''}${m.headPose.yawDeg.toFixed(1)}°`;
    valPitch.textContent = `${m.headPose.pitchDeg > 0 ? '+' : ''}${m.headPose.pitchDeg.toFixed(1)}°`;
    valRoll.textContent = `${m.headPose.rollDeg > 0 ? '+' : ''}${m.headPose.rollDeg.toFixed(1)}°`;

    valCentered.textContent = m.isFaceCentered ? 'YES' : 'OFF-CENTER';
    valCentered.style.color = m.isFaceCentered ? '#34d399' : '#fbbf24';

    valCoverage.textContent = `${(m.faceCoverageRatio * 100).toFixed(1)}%`;
    valBrightness.textContent = `${m.qualityIndicators.estimatedBrightness} / 255`;
    valLighting.textContent = m.qualityIndicators.isLightingAdequate ? 'ADEQUATE' : 'POOR';
    valLighting.style.color = m.qualityIndicators.isLightingAdequate ? '#34d399' : '#f87171';
  } else {
    valEar.textContent = '--';
    valBlink.textContent = '--';
    valBlink.style.color = '#f1f5f9';
    valMar.textContent = '--';
    valSmile.textContent = '--';
    valYaw.textContent = '--';
    valPitch.textContent = '--';
    valRoll.textContent = '--';
    valCentered.textContent = '--';
    valCoverage.textContent = '--';
    valBrightness.textContent = '--';
    valLighting.textContent = '--';
  }
}

// Button Events
btnStart.addEventListener('click', async () => {
  clearError();
  btnStart.disabled = true;
  sessionResultBanner.classList.add('hidden');

  const success = await controller.start(videoEl, canvasEl, {
    onDetectionResult: updateTelemetry,
    onFpsUpdate: (fps) => {
      fpsDisplay.textContent = `FPS: ${fps}`;
    },
    onError: (err) => {
      showError(err);
      btnStart.disabled = false;
      btnStop.disabled = true;
      btnStartChallenge.disabled = true;
      challengeController.cancel('Camera error occurred.');
    },
    onStatusChange: (status) => {
      setStatus(status, 'active');
    },
  });

  if (success) {
    btnStop.disabled = false;
    btnStartChallenge.disabled = false;
    setStatus('Camera & Landmarker Active', 'active');
  } else {
    btnStart.disabled = false;
  }
});

btnStartChallenge.addEventListener('click', () => {
  sessionResultBanner.classList.add('hidden');
  btnStartChallenge.disabled = true;

  challengeController.startSession({
    onStateChange: (state) => {
      updateChallengeUI(state);
    },
    onChallengeSuccess: (challenge, event) => {
      setStatus(`Challenge Succeeded: ${challenge.type}`, 'active');
    },
    onSessionCompleted: (success, message) => {
      btnStartChallenge.disabled = false;
      sessionResultBanner.className = `session-result-banner ${
        success ? 'banner-success' : 'banner-failed'
      }`;
      sessionResultBanner.textContent = message;
      sessionResultBanner.classList.remove('hidden');
      setStatus(success ? 'Active Verification Succeeded' : 'Active Verification Failed', success ? 'active' : 'warning');
    },
  });
});

btnStop.addEventListener('click', () => {
  challengeController.cancel('User stopped camera.');
  controller.stop();
  btnStart.disabled = false;
  btnStop.disabled = true;
  btnStartChallenge.disabled = true;
  fpsDisplay.textContent = 'FPS: --';
  setStatus('Camera Stopped. Hardware Released.', 'idle');

  // Clear canvas overlay
  const ctx = canvasEl.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  presenceStatusBadge.textContent = 'STOPPED';
  presenceStatusBadge.className = 'presence-indicator';
  presenceAlert.classList.add('hidden');
  challengeHud.classList.add('hidden');
});

// Explicit cleanup on page unload / navigation
window.addEventListener('beforeunload', () => {
  challengeController.cancel('Page unloaded.');
  controller.dispose();
});
