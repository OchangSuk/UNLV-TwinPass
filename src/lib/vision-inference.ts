import type { InferenceSession, Tensor as OrtTensor } from "onnxruntime-web";
import type { RegisteredPersonId } from "./people";

type OrtRuntime = {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: {
    create(modelUrl: string, options: {
      executionProviders: string[];
      graphOptimizationLevel: "all";
    }): Promise<InferenceSession>;
  };
  Tensor: new (type: "float32", data: Float32Array, dimensions: number[]) => OrtTensor;
};

declare global {
  interface Window {
    ort?: OrtRuntime;
  }
}

export type VisionIdentification = {
  person_id: RegisteredPersonId | "OTHER";
  confidence: number;
  label: string;
  box?: { x: number; y: number; width: number; height: number };
};

type PreparedImage = {
  tensor: OrtTensor;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  padX: number;
  padY: number;
};

type Detection = {
  classIndex: number;
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

const MODEL_URL = "/models/yolo/twinpass-team-only-yolo11n-224.onnx";
const RUNTIME_ROOT = "/models/yolo/runtime";
const INPUT_SIZE = 224;
const TEAM_THRESHOLD = 0.65;
const IOU_THRESHOLD = 0.45;
const MIN_LOG_SCORE = 0.001;
const LABELS = ["Catherine", "Sihoon", "changsuk", "seoyeon"] as const;

let sessionPromise: Promise<InferenceSession> | null = null;
let runtimePromise: Promise<OrtRuntime> | null = null;

function loadRuntime() {
  if (window.ort) return Promise.resolve(window.ort);
  if (runtimePromise) return runtimePromise;

  runtimePromise = new Promise<OrtRuntime>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `${RUNTIME_ROOT}/ort.min.js`;
    script.async = true;
    script.onload = () => window.ort
      ? resolve(window.ort)
      : reject(new Error("ONNX Runtime을 초기화하지 못했습니다."));
    script.onerror = () => reject(new Error("ONNX Runtime 파일을 불러오지 못했습니다."));
    document.head.appendChild(script);
  }).catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export function loadVisionModel() {
  if (sessionPromise) return sessionPromise;

  sessionPromise = loadRuntime().then(async (runtime) => {
    runtime.env.wasm.numThreads = 1;
    runtime.env.wasm.wasmPaths = `${RUNTIME_ROOT}/`;
    const session = await runtime.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    console.info("[TwinPass Vision] YOLO11n team-only model ready", {
      model: MODEL_URL,
      input: `${INPUT_SIZE}x${INPUT_SIZE}`,
      labels: LABELS,
      threshold: TEAM_THRESHOLD,
      backend: "wasm",
    });
    return session;
  }).catch((error) => {
    sessionPromise = null;
    throw error;
  });
  return sessionPromise;
}

function normalizeLabel(label: string): RegisteredPersonId | "OTHER" {
  switch (label.trim().toLowerCase()) {
    case "sihoon": return "Sihoon";
    case "changsuk": return "changsuk";
    case "catherine": return "Catherine";
    case "seoyeon": return "seoyeon";
    default: return "OTHER";
  }
}

function prepareImage(source: HTMLVideoElement | HTMLCanvasElement, runtime: OrtRuntime): PreparedImage {
  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!sourceWidth || !sourceHeight) throw new Error("카메라 프레임이 아직 준비되지 않았습니다.");

  const scale = Math.min(INPUT_SIZE / sourceWidth, INPUT_SIZE / sourceHeight);
  const resizedWidth = Math.round(sourceWidth * scale);
  const resizedHeight = Math.round(sourceHeight * scale);
  const padX = Math.floor((INPUT_SIZE - resizedWidth) / 2);
  const padY = Math.floor((INPUT_SIZE - resizedHeight) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = INPUT_SIZE;
  canvas.height = INPUT_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("카메라 프레임을 처리할 수 없습니다.");

  context.fillStyle = "rgb(114, 114, 114)";
  context.fillRect(0, 0, INPUT_SIZE, INPUT_SIZE);
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, padX, padY, resizedWidth, resizedHeight);

  const rgba = context.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data;
  const planeSize = INPUT_SIZE * INPUT_SIZE;
  const chw = new Float32Array(planeSize * 3);
  for (let pixel = 0, offset = 0; pixel < planeSize; pixel++, offset += 4) {
    chw[pixel] = rgba[offset] / 255;
    chw[planeSize + pixel] = rgba[offset + 1] / 255;
    chw[planeSize * 2 + pixel] = rgba[offset + 2] / 255;
  }

  return {
    tensor: new runtime.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]),
    sourceWidth,
    sourceHeight,
    scale,
    padX,
    padY,
  };
}

function intersectionOverUnion(left: Detection, right: Detection) {
  const intersectionWidth = Math.max(0, Math.min(left.x2, right.x2) - Math.max(left.x1, right.x1));
  const intersectionHeight = Math.max(0, Math.min(left.y2, right.y2) - Math.max(left.y1, right.y1));
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea = Math.max(0, left.x2 - left.x1) * Math.max(0, left.y2 - left.y1);
  const rightArea = Math.max(0, right.x2 - right.x1) * Math.max(0, right.y2 - right.y1);
  return intersection / Math.max(leftArea + rightArea - intersection, Number.EPSILON);
}

function decodeOutput(output: OrtTensor): Detection[] {
  const dimensions = output.dims.map(Number);
  if (dimensions.length !== 3 || dimensions[1] !== 4 + LABELS.length) {
    throw new Error(`예상하지 못한 YOLO 출력 크기입니다: ${dimensions.join("x")}`);
  }

  const data = output.data as Float32Array;
  const candidates = dimensions[2];
  const detections: Detection[] = [];

  for (let candidate = 0; candidate < candidates; candidate++) {
    let classIndex = 0;
    let confidence = -Infinity;
    for (let label = 0; label < LABELS.length; label++) {
      const score = data[(4 + label) * candidates + candidate];
      if (score > confidence) {
        confidence = score;
        classIndex = label;
      }
    }
    if (confidence < MIN_LOG_SCORE) continue;

    const centerX = data[candidate];
    const centerY = data[candidates + candidate];
    const width = data[candidates * 2 + candidate];
    const height = data[candidates * 3 + candidate];
    detections.push({
      classIndex,
      confidence,
      x1: centerX - width / 2,
      y1: centerY - height / 2,
      x2: centerX + width / 2,
      y2: centerY + height / 2,
    });
  }

  const selected: Detection[] = [];
  for (const candidate of detections.sort((left, right) => right.confidence - left.confidence)) {
    const overlaps = selected.some((kept) =>
      kept.classIndex === candidate.classIndex && intersectionOverUnion(kept, candidate) > IOU_THRESHOLD,
    );
    if (!overlaps) selected.push(candidate);
  }
  return selected;
}

export async function identifyPersonFromImage(
  source: HTMLVideoElement | HTMLCanvasElement,
): Promise<VisionIdentification> {
  const startedAt = performance.now();
  const [runtime, session] = await Promise.all([loadRuntime(), loadVisionModel()]);
  const prepared = prepareImage(source, runtime);
  const outputs = await session.run({ [session.inputNames[0]]: prepared.tensor });
  const detections = decodeOutput(outputs[session.outputNames[0]]);
  const best = detections[0];
  const predictedLabel = best ? LABELS[best.classIndex] : "none";
  const predictedConfidence = best?.confidence ?? 0;

  if (!best || best.confidence < TEAM_THRESHOLD) {
    const result: VisionIdentification = {
      person_id: "OTHER",
      confidence: predictedConfidence,
      label: best ? `low-confidence:${predictedLabel}` : "none",
    };
    console.info("[TwinPass Vision] YOLO inference result", {
      predictedLabel,
      predictedConfidence,
      threshold: TEAM_THRESHOLD,
      decision: result.person_id,
      detections: detections.slice(0, 10).map((item) => ({
        label: LABELS[item.classIndex],
        confidence: item.confidence,
      })),
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    return result;
  }

  const x1 = Math.max(0, Math.min(prepared.sourceWidth, (best.x1 - prepared.padX) / prepared.scale));
  const y1 = Math.max(0, Math.min(prepared.sourceHeight, (best.y1 - prepared.padY) / prepared.scale));
  const x2 = Math.max(0, Math.min(prepared.sourceWidth, (best.x2 - prepared.padX) / prepared.scale));
  const y2 = Math.max(0, Math.min(prepared.sourceHeight, (best.y2 - prepared.padY) / prepared.scale));
  const result: VisionIdentification = {
    person_id: normalizeLabel(predictedLabel),
    confidence: best.confidence,
    label: predictedLabel,
    box: { x: x1, y: y1, width: x2 - x1, height: y2 - y1 },
  };

  console.info("[TwinPass Vision] YOLO inference result", {
    predictedLabel,
    predictedConfidence,
    threshold: TEAM_THRESHOLD,
    decision: result.person_id,
    box: result.box,
    detections: detections.slice(0, 10).map((item) => ({
      label: LABELS[item.classIndex],
      confidence: item.confidence,
    })),
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
  });
  return result;
}
