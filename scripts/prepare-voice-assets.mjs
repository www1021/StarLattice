import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "public", "voice-assets");
mkdirSync(output, { recursive: true });
for (const name of ["silero_vad_v5.onnx", "vad.worklet.bundle.min.js"]) {
  copyFileSync(path.join(root, "node_modules/@ricky0123/vad-web/dist", name), path.join(output, name));
}
for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  copyFileSync(path.join(root, "node_modules/onnxruntime-web/dist", name), path.join(output, name));
}
