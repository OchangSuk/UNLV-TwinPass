import type { RegisteredPersonId } from "./people";

type EdgeImpulseProperties = {
  image_input_width: number;
  image_input_height: number;
  classification_threshold?: number;
  labels?: string[];
  model_type?: string;
};

type EdgeImpulseResult = {
  label: string;
  value: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

type EdgeImpulseClassification = {
  results: EdgeImpulseResult[];
};

type EdgeImpulseClassifierInstance = {
  init(): Promise<void>;
  getProperties(): EdgeImpulseProperties;
  classify(features: number[]): EdgeImpulseClassification;
};

type EdgeImpulseClassifierConstructor = new () => EdgeImpulseClassifierInstance;

declare global {
  interface Window {
    EdgeImpulseClassifier?: EdgeImpulseClassifierConstructor;
  }
}

export type VisionIdentification = {
  person_id: RegisteredPersonId | "OTHER";
  confidence: number;
  label: string;
  box?: { x: number; y: number; width: number; height: number };
};

const MODEL_ROOT = "/models/vision-v2";
// V2에는 other 학습 데이터가 없으므로 낮은 신뢰도의 강제 분류를 거절한다.
const MIN_TEAM_CONFIDENCE = 0.65;

let classifierPromise: Promise<EdgeImpulseClassifierInstance> | null = null;
const scriptPromises = new Map<string, Promise<void>>();

function loadScript(src: string) {
  const existingPromise = scriptPromises.get(src);
  if (existingPromise) return existingPromise;

  const promise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }

    const script = existing ?? document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => {
      reject(new Error(`Vision 모델 파일을 불러오지 못했습니다: ${src}`));
    }, { once: true });
    if (!existing) document.head.appendChild(script);
  });

  scriptPromises.set(src, promise);
  return promise;
}

export function loadVisionModel() {
  if (classifierPromise) return classifierPromise;

  classifierPromise = (async () => {
    await loadScript(`${MODEL_ROOT}/edge-impulse-standalone.js`);
    await loadScript(`${MODEL_ROOT}/run-impulse.js`);

    if (!window.EdgeImpulseClassifier) {
      throw new Error("Edge Impulse Vision V2 모델을 초기화하지 못했습니다.");
    }

    const classifier = new window.EdgeImpulseClassifier();
    await classifier.init();
    const properties = classifier.getProperties();
    console.info("[TwinPass Vision] Edge Impulse V2 model ready", {
      modelType: properties.model_type,
      input: `${properties.image_input_width}x${properties.image_input_height}`,
      labels: properties.labels,
      modelThreshold: properties.classification_threshold,
      appThreshold: MIN_TEAM_CONFIDENCE,
    });
    return classifier;
  })().catch((error) => {
    classifierPromise = null;
    throw error;
  });

  return classifierPromise;
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

function imageToPackedRgbFeatures(
  source: HTMLVideoElement | HTMLCanvasElement,
  width: number,
  height: number,
) {
  const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!sourceWidth || !sourceHeight) throw new Error("카메라 프레임이 아직 준비되지 않았습니다.");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("카메라 프레임을 처리할 수 없습니다.");

  const cropSize = Math.min(sourceWidth, sourceHeight);
  const cropX = (sourceWidth - cropSize) / 2;
  const cropY = (sourceHeight - cropSize) / 2;
  context.drawImage(source, cropX, cropY, cropSize, cropSize, 0, 0, width, height);

  const rgba = context.getImageData(0, 0, width, height).data;
  const features = new Array<number>(width * height);
  for (let pixel = 0, offset = 0; pixel < features.length; pixel++, offset += 4) {
    features[pixel] = (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
  }
  return features;
}

export async function identifyPersonFromImage(
  source: HTMLVideoElement | HTMLCanvasElement,
): Promise<VisionIdentification> {
  const startedAt = performance.now();
  const classifier = await loadVisionModel();
  const properties = classifier.getProperties();
  const features = imageToPackedRgbFeatures(
    source,
    properties.image_input_width,
    properties.image_input_height,
  );
  const classification = classifier.classify(features);
  const modelThreshold = properties.classification_threshold ?? 0;
  const threshold = Math.max(modelThreshold, MIN_TEAM_CONFIDENCE);
  const best = classification.results
    .filter((item) => Number.isFinite(item.value))
    .sort((left, right) => right.value - left.value)[0];

  if (!best || best.value < threshold) {
    const result: VisionIdentification = {
      person_id: "OTHER",
      confidence: best?.value ?? 0,
      label: best ? `low-confidence:${best.label}` : "none",
    };
    console.info("[TwinPass Vision] inference result", {
      rawResults: classification.results.map(({ label, value }) => ({ label, confidence: value })),
      threshold,
      decision: result.person_id,
      selectedLabel: result.label,
      confidence: result.confidence,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    return result;
  }

  const personId = normalizeLabel(best.label);
  if (personId === "OTHER") {
    const result: VisionIdentification = {
      person_id: "OTHER",
      confidence: best.value,
      label: best.label,
    };
    console.info("[TwinPass Vision] inference result", {
      rawResults: classification.results.map(({ label, value }) => ({ label, confidence: value })),
      threshold,
      decision: result.person_id,
      selectedLabel: result.label,
      confidence: result.confidence,
      elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
    });
    return result;
  }

  const result: VisionIdentification = {
    person_id: personId,
    confidence: best.value,
    label: best.label,
    box: typeof best.x === "number" && typeof best.y === "number" &&
      typeof best.width === "number" && typeof best.height === "number"
      ? { x: best.x, y: best.y, width: best.width, height: best.height }
      : undefined,
  };
  console.info("[TwinPass Vision] inference result", {
    rawResults: classification.results.map(({ label, value }) => ({ label, confidence: value })),
    threshold,
    decision: result.person_id,
    selectedLabel: result.label,
    confidence: result.confidence,
    box: result.box,
    elapsedMs: Math.round((performance.now() - startedAt) * 10) / 10,
  });
  return result;
}
