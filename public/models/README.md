# PAD Model Placeholder

Place your ONNX PAD model file here as:

    public/models/pad-model.onnx

## Recommended Model
Download `best_model.onnx` from:
https://github.com/facenox/face-antispoof-onnx/tree/main/models

## Install the runtime (one-time)
```bash
npm install onnxruntime-web
```

## What happens without the model
- The OnnxPadModel detects the missing file on startup and logs a clear message
- PAD state = UNAVAILABLE
- The liveness engine fails closed: no padLiveScore → passive check fails → active challenge is required
- Active challenges (blink/smile/head-turn) still work fully
- The UI shows "PAD UNAVAILABLE" truthfully
