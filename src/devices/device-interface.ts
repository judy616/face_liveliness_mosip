import { VideoFrame } from '../types/index.js';

export type FrameCallback = (frame: VideoFrame) => void;

/**
 * Vendor-independent face-frame streaming interface.
 * Separates the device boundary from mock and live implementations.
 *
 * Level L0: browser webcam / untrusted capture endpoint.
 * Level L1: cryptographically signed / secure hardware (requires vendor SDK).
 * A browser webcam is always L0; it must not be labeled or claimed as L1.
 */
export interface BiometricDevice {
  readonly deviceId: string;
  readonly deviceModel: string;
  readonly level: import('../types/index.js').BiometricDeviceLevel;
  readonly isConnected: boolean;

  /** Open connection to the device. Throws on failure. */
  connect(): Promise<void>;

  /** Close connection and release resources. */
  disconnect(): Promise<void>;

  /**
   * Begin streaming frames to `onFrame`.
   * Must call connect() first.
   * Each frame must be a valid VideoFrame; invalid / empty frames
   * should be dropped by the adapter before calling onFrame.
   */
  startStream(onFrame: FrameCallback): Promise<void>;

  /** Stop streaming. Safe to call even if stream is not running. */
  stopStream(): Promise<void>;
}
