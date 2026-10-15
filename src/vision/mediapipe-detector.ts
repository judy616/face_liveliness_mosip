import {
  FaceLandmarker,
  FilesetResolver,
  FaceLandmarkerResult,
} from '@mediapipe/tasks-vision';
import {
  FrameLandmarkDetectionResult,
  SingleFaceLandmarkResult,
  FacePresenceStatus,
  CameraErrorInfo,
  NormalizedLandmark,
} from '../types/index.js';
import { IFaceLandmarkDetector } from './detector-interface.js';
import {
  computeBoundingBox,
  extractFaceLandmarkMeasurements,
} from './landmark-calculations.js';

/**
 * Concrete MediaPipe Tasks Vision Face Landmarker adapter
 */
export class MediaPipeFaceLandmarkDetector implements IFaceLandmarkDetector {
  private landmarker: FaceLandmarker | null = null;
  private isInitializing: boolean = false;
  private wasmBasePath: string;
  private modelAssetPath: string;

  constructor(options?: { wasmBasePath?: string; modelAssetPath?: string }) {
    // Official reliable Google CDN for tasks-vision wasm assets
    this.wasmBasePath =
      options?.wasmBasePath ??
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm';
    this.modelAssetPath =
      options?.modelAssetPath ??
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
  }

  public async initialize(): Promise<{ success: boolean; error?: CameraErrorInfo }> {
    if (this.landmarker) {
      return { success: true };
    }
    if (this.isInitializing) {
      return {
        success: false,
        error: {
          type: 'DETECTOR_INIT_FAILED',
          message: 'Detector is already initializing.',
        },
      };
    }

    this.isInitializing = true;
    try {
      const filesetResolver = await FilesetResolver.forVisionTasks(this.wasmBasePath);

      this.landmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
        baseOptions: {
          modelAssetPath: this.modelAssetPath,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 5, // Support detecting up to 5 faces to enforce single-face constraints
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });

      this.isInitializing = false;
      return { success: true };
    } catch (err: unknown) {
      this.isInitializing = false;
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: {
          type: 'DETECTOR_INIT_FAILED',
          message: `Failed to load MediaPipe Face Landmarker model: ${message}`,
          originalError: err,
        },
      };
    }
  }

  public detectVideoFrame(
    source: HTMLVideoElement | HTMLCanvasElement,
    timestampMs: number,
    renderCtx: CanvasRenderingContext2D | null = null
  ): FrameLandmarkDetectionResult {
    const startTime = performance.now();
    const width = 'videoWidth' in source ? source.videoWidth || source.width : source.width;
    const height = 'videoHeight' in source ? source.videoHeight || source.height : source.height;

    if (!this.landmarker || width === 0 || height === 0) {
      return {
        timestamp: timestampMs,
        frameWidth: width,
        frameHeight: height,
        faceCount: 0,
        presenceStatus: 'NO_FACE',
        primaryFace: null,
        allFaces: [],
        processingLatencyMs: 0,
      };
    }

    let results: FaceLandmarkerResult;
    try {
      results = this.landmarker.detectForVideo(source, timestampMs);
    } catch (e) {
      console.warn('FaceLandmarker detectForVideo error:', e);
      return {
        timestamp: timestampMs,
        frameWidth: width,
        frameHeight: height,
        faceCount: 0,
        presenceStatus: 'NO_FACE',
        primaryFace: null,
        allFaces: [],
        processingLatencyMs: performance.now() - startTime,
      };
    }

    const faceLandmarksList = results.faceLandmarks || [];
    const faceCount = faceLandmarksList.length;

    let presenceStatus: FacePresenceStatus = 'NO_FACE';
    if (faceCount === 1) {
      presenceStatus = 'EXACTLY_ONE_FACE';
    } else if (faceCount > 1) {
      presenceStatus = 'MULTIPLE_FACES';
    }

    const allFaces: SingleFaceLandmarkResult[] = [];

    for (let i = 0; i < faceCount; i++) {
      const rawLandmarks = faceLandmarksList[i];
      if (!rawLandmarks) continue;

      const landmarks: readonly NormalizedLandmark[] = rawLandmarks.map((lm) => ({
        x: lm.x,
        y: lm.y,
        z: lm.z,
      }));

      const boundingBox = computeBoundingBox(landmarks);
      const measurements = extractFaceLandmarkMeasurements(landmarks, renderCtx, width, height);

      allFaces.push({
        faceIndex: i,
        landmarks,
        boundingBox,
        measurements,
      });
    }

    // Only set primaryFace if EXACTLY_ONE_FACE is detected
    const primaryFace = presenceStatus === 'EXACTLY_ONE_FACE' ? allFaces[0] ?? null : null;

    return {
      timestamp: timestampMs,
      frameWidth: width,
      frameHeight: height,
      faceCount,
      presenceStatus,
      primaryFace,
      allFaces,
      processingLatencyMs: performance.now() - startTime,
    };
  }

  public close(): void {
    if (this.landmarker) {
      try {
        this.landmarker.close();
      } catch {
        // ignore
      }
      this.landmarker = null;
    }
  }
}
