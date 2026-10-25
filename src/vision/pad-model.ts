/**
 * PAD (Presentation Attack Detection) model interface and ONNX adapter.
 *
 * Uses MiniFASNetV2-SE architecture via onnxruntime-web when a model file
 * is available. When no model file is configured or loading fails, all
 * prediction calls return UNAVAILABLE — the liveness engine then fails
 * closed (no padLiveScore → no passive pass → challenge required with
 * PAD check still enforced).
 *
 * IMPORTANT: This module detects spoofs from image data only.
 * Successful blink or head-turn challenges are NEVER treated as PAD success.
 *
 * Licence note: MiniFASNetV2-SE weights used here are sourced from the
 * open-source face-antispoof-onnx project. Verify the licence before
 * commercial deployment.
 */

/** Four possible outcomes from a single-frame PAD assessment. */
export type PadOutcome = 'BONA_FIDE' | 'ATTACK' | 'INDETERMINATE' | 'UNAVAILABLE';

export interface PadFrameResult {
  readonly outcome: PadOutcome;
  /** Live probability 0–1. Only meaningful when outcome is BONA_FIDE or ATTACK. */
  readonly liveScore: number;
  readonly modelVersion: string;
  readonly details: string;
}

/** Public interface that the live device and liveness engine interact with. */
export interface PadModel {
  /** Current model state — check before calling predict(). */
  readonly state: 'NOT_CONFIGURED' | 'LOADING' | 'READY' | 'ERROR';

  /** Load the ONNX model from the configured URL. Resolves even on failure (state → ERROR). */
  load(): Promise<void>;

  /**
   * Predict liveness from a face crop.
   * @param video  Live HTMLVideoElement (frame is read at call time).
   * @param box    Face bounding box in pixel coords from MediaPipe.
   * Returns UNAVAILABLE immediately when state is not READY.
   */
  predict(
    video: HTMLVideoElement,
    box: { x: number; y: number; w: number; h: number }
  ): Promise<PadFrameResult>;
}

// ============================================================================
// ONNX adapter — requires onnxruntime-web in the browser bundle
// ============================================================================

const MODEL_VERSION = 'MiniFASNetV2-SE-v1.0';
/** Scale factor around face centre — must match model training config */
const CROP_SCALE = 2.7;
const INPUT_SIZE = 80;

/**
 * OnnxPadModel loads a MiniFASNetV2-SE ONNX file and runs it in the browser
 * via WebAssembly. When the model file is absent or fails to load, every
 * predict() call returns { outcome: 'UNAVAILABLE' }.
 *
 * Preprocessing (must match model training):
 * - Expand bounding box by CROP_SCALE around face centre
 * - Resize to 80×80
 * - Convert to float32 BGR, divided by 255 (no further normalisation)
 * - Shape: [1, 3, 80, 80] NCHW
 *
 * Output: softmax over [spoof, live] classes — index 1 is live probability.
 */
export class OnnxPadModel implements PadModel {
  private _state: PadModel['state'] = 'NOT_CONFIGURED';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private session: any | null = null;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  // Rolling average of recent live scores
  private readonly scoreWindow: number[] = [];
  private readonly windowSize: number;

  constructor(
    private readonly modelUrl: string | null,
    windowSize = 5
  ) {
    this.windowSize = windowSize;
    this.canvas = document.createElement('canvas');
    this.canvas.width = INPUT_SIZE;
    this.canvas.height = INPUT_SIZE;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OnnxPadModel: cannot create offscreen canvas context');
    this.ctx = ctx;
  }

  get state(): PadModel['state'] {
    return this._state;
  }

  async load(): Promise<void> {
    if (!this.modelUrl) {
      this._state = 'NOT_CONFIGURED';
      console.info('[PAD] No model URL configured — PAD will be UNAVAILABLE.');
      return;
    }

    this._state = 'LOADING';
    try {
      // Dynamic import so the bundle doesn't break when onnxruntime-web is absent
      const ort = await import('onnxruntime-web').catch(() => null);
      if (!ort) {
        this._state = 'ERROR';
        console.warn('[PAD] onnxruntime-web not installed. Run: npm install onnxruntime-web');
        return;
      }

      // Verify the model file is reachable before loading
      const probe = await fetch(this.modelUrl, { method: 'HEAD' }).catch(() => null);
      if (!probe || !probe.ok) {
        this._state = 'NOT_CONFIGURED';
        console.info(
          `[PAD] Model file not found at "${this.modelUrl}". ` +
          'Download best_model.onnx from https://github.com/facenox/face-antispoof-onnx ' +
          'and place it at public/models/pad-model.onnx. PAD will be UNAVAILABLE until then.'
        );
        return;
      }

      this.session = await ort.InferenceSession.create(this.modelUrl, {
        executionProviders: ['wasm'],
      });
      this._state = 'READY';
      console.info(`[PAD] Model loaded successfully: ${MODEL_VERSION}`);
    } catch (err) {
      this._state = 'ERROR';
      console.error('[PAD] Failed to load model:', err);
    }
  }

  async predict(
    video: HTMLVideoElement,
    box: { x: number; y: number; w: number; h: number }
  ): Promise<PadFrameResult> {
    if (this._state !== 'READY' || !this.session) {
      return {
        outcome: 'UNAVAILABLE',
        liveScore: 0,
        modelVersion: MODEL_VERSION,
        details: `PAD model ${this._state === 'NOT_CONFIGURED' ? 'not configured (no model file)' : this._state}`,
      };
    }

    try {
      const ort = await import('onnxruntime-web');

      // Expand crop around face centre
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const side = Math.max(box.w, box.h) * CROP_SCALE;

      this.ctx.drawImage(
        video,
        cx - side / 2, cy - side / 2, side, side,
        0, 0, INPUT_SIZE, INPUT_SIZE
      );

      const { data } = this.ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
      const px = INPUT_SIZE * INPUT_SIZE;
      const input = new Float32Array(3 * px);

      // BGR channel order, normalised to [0, 1]
      for (let i = 0; i < px; i++) {
        input[i]          = data[i * 4 + 2]! / 255; // B
        input[px + i]     = data[i * 4 + 1]! / 255; // G
        input[2 * px + i] = data[i * 4]!     / 255; // R
      }

      const inputName = this.session.inputNames[0] as string;
      const outputName = this.session.outputNames[0] as string;
      const feeds = { [inputName]: new ort.Tensor('float32', input, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
      const results = await this.session.run(feeds);
      const logits = results[outputName]!.data as Float32Array;

      // Softmax: class index 1 = real/live
      const maxLogit = Math.max(...logits);
      const exps = Array.from(logits, (v) => Math.exp(v - maxLogit));
      const sumExp = exps.reduce((a, c) => a + c, 0);
      const rawLiveScore = exps[1]! / sumExp;

      // Rolling average to smooth noise
      this.scoreWindow.push(rawLiveScore);
      if (this.scoreWindow.length > this.windowSize) this.scoreWindow.shift();
      const avgScore = this.scoreWindow.reduce((a, b) => a + b, 0) / this.scoreWindow.length;

      const outcome: PadOutcome =
        avgScore >= 0.6 ? 'BONA_FIDE' :
        avgScore <= 0.4 ? 'ATTACK' :
        'INDETERMINATE';

      return {
        outcome,
        liveScore: avgScore,
        modelVersion: MODEL_VERSION,
        details: `Live score: ${avgScore.toFixed(3)} (${this.scoreWindow.length}-frame avg)`,
      };
    } catch (err) {
      return {
        outcome: 'UNAVAILABLE',
        liveScore: 0,
        modelVersion: MODEL_VERSION,
        details: `PAD prediction error: ${String(err)}`,
      };
    }
  }

  /** Reset rolling score window (call on new session start). */
  resetWindow(): void {
    this.scoreWindow.length = 0;
  }
}

/**
 * NullPadModel — used in Node.js / test environments where
 * HTMLVideoElement and canvas don't exist.
 */
export class NullPadModel implements PadModel {
  readonly state: PadModel['state'] = 'NOT_CONFIGURED';
  async load(): Promise<void> { /* no-op */ }
  async predict(): Promise<PadFrameResult> {
    return {
      outcome: 'UNAVAILABLE',
      liveScore: 0,
      modelVersion: 'NULL',
      details: 'PAD not available in this environment',
    };
  }
}
