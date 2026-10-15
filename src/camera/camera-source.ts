import { CameraErrorInfo } from '../types/index.js';

export interface CameraStreamConstraints {
  readonly idealWidth?: number;
  readonly idealHeight?: number;
  readonly idealFps?: number;
  readonly facingMode?: 'user' | 'environment';
}

export type CameraErrorListener = (error: CameraErrorInfo) => void;
export type CameraStreamListener = (stream: MediaStream) => void;

/**
 * Clean lifecycle abstraction for browser camera access via navigator.mediaDevices.getUserMedia
 */
export class BrowserCameraSource {
  private activeStream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private errorListeners: CameraErrorListener[] = [];
  private isAcquiring: boolean = false;

  constructor(private constraints: CameraStreamConstraints = { idealWidth: 1280, idealHeight: 720, idealFps: 30, facingMode: 'user' }) {}

  public onError(listener: CameraErrorListener): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter(l => l !== listener);
    };
  }

  private emitError(type: CameraErrorInfo['type'], message: string, originalError?: unknown): CameraErrorInfo {
    const errorInfo: CameraErrorInfo = { type, message, originalError };
    for (const listener of this.errorListeners) {
      try {
        listener(errorInfo);
      } catch (e) {
        console.error('Error in camera error listener', e);
      }
    }
    return errorInfo;
  }

  public isActive(): boolean {
    if (!this.activeStream) return false;
    return this.activeStream.getVideoTracks().some(track => track.readyState === 'live');
  }

  public getStream(): MediaStream | null {
    return this.activeStream;
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  /**
   * Request user permission and attach camera stream to the given video element
   */
  public async start(videoEl: HTMLVideoElement): Promise<{ success: boolean; error?: CameraErrorInfo }> {
    if (this.isAcquiring) {
      return { success: false, error: { type: 'DEVICE_IN_USE', message: 'Camera acquisition already in progress.' } };
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      const err = this.emitError('BROWSER_UNSUPPORTED', 'Webcam access is not supported by this browser environment.');
      return { success: false, error: err };
    }

    this.isAcquiring = true;
    this.videoElement = videoEl;

    // Release any previous stream first
    this.stop();

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: this.constraints.idealWidth ?? 1280 },
          height: { ideal: this.constraints.idealHeight ?? 720 },
          frameRate: { ideal: this.constraints.idealFps ?? 30 },
          facingMode: this.constraints.facingMode ?? 'user',
        },
        audio: false,
      });

      this.activeStream = mediaStream;

      // Monitor track disconnection (e.g., unplugged USB camera)
      const videoTrack = mediaStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          this.emitError('STREAM_DISCONNECTED', 'Camera stream disconnected or unplugged.');
          this.stop();
        };
      }

      videoEl.srcObject = mediaStream;
      videoEl.playsInline = true;
      videoEl.muted = true;

      // Wait until metadata is loaded and video is playing
      await new Promise<void>((resolve, reject) => {
        const onLoaded = () => {
          videoEl.removeEventListener('loadedmetadata', onLoaded);
          videoEl.play().then(resolve).catch(reject);
        };
        if (videoEl.readyState >= 1) {
          videoEl.play().then(resolve).catch(reject);
        } else {
          videoEl.addEventListener('loadedmetadata', onLoaded);
        }
      });

      this.isAcquiring = false;
      return { success: true };
    } catch (err: unknown) {
      this.isAcquiring = false;
      this.stop();

      let errorType: CameraErrorInfo['type'] = 'UNKNOWN';
      let message = 'An unknown camera error occurred.';

      if (err instanceof DOMException) {
        switch (err.name) {
          case 'NotAllowedError':
          case 'PermissionDeniedError':
            errorType = 'PERMISSION_DENIED';
            message = 'Camera permission was denied by the user or system.';
            break;
          case 'NotFoundError':
          case 'DevicesNotFoundError':
            errorType = 'DEVICE_NOT_FOUND';
            message = 'No biometric/webcam camera device found on this system.';
            break;
          case 'NotReadableError':
          case 'TrackStartError':
            errorType = 'DEVICE_IN_USE';
            message = 'Camera device is already in use by another application or process.';
            break;
          default:
            errorType = 'UNKNOWN';
            message = `Camera error (${err.name}): ${err.message}`;
            break;
        }
      } else if (err instanceof Error) {
        message = err.message;
      }

      const errorInfo = this.emitError(errorType, message, err);
      return { success: false, error: errorInfo };
    }
  }

  /**
   * Stop the camera stream and explicitly release hardware devices
   */
  public stop(): void {
    if (this.activeStream) {
      for (const track of this.activeStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      this.activeStream = null;
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null;
      this.videoElement = null;
    }
  }
}
