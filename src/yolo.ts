import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ort from "onnxruntime-node";
import { fileExists } from "./credentials";

// Only used to lift the anonymous rate limit; the repositories themselves are public.
const HUGGING_FACE_TOKEN_FILE = path.join(os.homedir(), "facehuggingtoken.txt");
const MODEL_DIRECTORY = path.join(__dirname, "..", "models");
const MODEL_FILE_IN_REPO = "onnx/model.onnx";
const DEFAULT_INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.30;
const LOGITS_OUTPUT = "logits";
const BOXES_OUTPUT = "pred_boxes";

export type ModelName = "nano" | "medium" | "large" | "xlarge";

export const MODELS: { name: ModelName; letter: string; repo: string }[] = [
    { name: "nano", letter: "n", repo: "onnx-community/yolo26n-ONNX" },
    { name: "medium", letter: "m", repo: "onnx-community/yolo26m-ONNX" },
    { name: "large", letter: "l", repo: "onnx-community/yolo26l-ONNX" },
    { name: "xlarge", letter: "x", repo: "onnx-community/yolo26x-ONNX" },
];

export type Detection = {
    /** In the coordinate space of the image that was passed in. */
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
    classId: number;
    className: string;
};

export type DetectionResult = {
    detections: Detection[];
    preprocessMs: number;
    inferenceMs: number;
    postprocessMs: number;
};

export const COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
    "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
    "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
    "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
    "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

export type RgbImage = {
    width: number;
    height: number;
    /** Tightly packed 8-bit RGB, top row first. */
    rgb: Buffer;
};

function modelInfo(name: ModelName) {
    const model = MODELS.find(candidate => candidate.name === name);
    if (!model) {
        throw new Error(`Unknown model ${name}, expected one of ${MODELS.map(candidate => candidate.name).join(", ")}`);
    }
    return model;
}

async function readToken(): Promise<string | undefined> {
    if (!await fileExists(HUGGING_FACE_TOKEN_FILE)) {
        return undefined;
    }
    const token = (await fs.promises.readFile(HUGGING_FACE_TOKEN_FILE, "utf8")).trim();
    return token || undefined;
}

export async function ensureModel(name: ModelName): Promise<string> {
    const model = modelInfo(name);
    const file = path.join(MODEL_DIRECTORY, `yolo26${model.letter}.onnx`);
    if (await fileExists(file)) {
        return file;
    }
    const url = `https://huggingface.co/${model.repo}/resolve/main/${MODEL_FILE_IN_REPO}`;
    const token = await readToken();
    console.log(`[yolo] downloading YOLO26 ${model.name} from ${model.repo}${token ? " (authenticated)" : ""}`);
    const startedAtMs = Date.now();
    const response = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.promises.mkdir(MODEL_DIRECTORY, { recursive: true });
    await fs.promises.writeFile(file, bytes);
    console.log(`[yolo] downloaded YOLO26 ${model.name}: ${(bytes.length / 1024 / 1024).toFixed(1)} MiB in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);
    return file;
}

const sessions = new Map<ModelName, Promise<ort.InferenceSession>>();

export function loadModel(name: ModelName): Promise<ort.InferenceSession> {
    let existing = sessions.get(name);
    if (existing) {
        return existing;
    }
    const loading = (async () => {
        const file = await ensureModel(name);
        const startedAtMs = Date.now();
        const session = await ort.InferenceSession.create(file, { executionProviders: ["cpu"] });
        console.log(`[yolo] loaded YOLO26 ${name} in ${Date.now() - startedAtMs}ms, input ${session.inputNames.join(", ")}, outputs ${session.outputNames.join(", ")}`);
        return session;
    })();
    sessions.set(name, loading);
    return loading;
}

function inputSize(session: ort.InferenceSession): number {
    const metadata = session.inputMetadata[0];
    if (metadata && "shape" in metadata) {
        const height = metadata.shape[2];
        const width = metadata.shape[3];
        if (typeof height === "number" && height > 0 && typeof width === "number" && width > 0) {
            return Math.min(height, width);
        }
    }
    return DEFAULT_INPUT_SIZE;
}

/**
 * The export's preprocessor_config.json asks for a plain stretch to a square with no padding, so the
 * aspect ratio is deliberately not preserved here. Boxes come back normalized, which undoes the stretch.
 */
function resizeToTensor(image: RgbImage, size: number): Float32Array {
    const planeSize = size * size;
    const tensor = new Float32Array(planeSize * 3);
    const scaleX = image.width / size;
    const scaleY = image.height / size;
    for (let y = 0; y < size; y++) {
        const sourceRow = Math.min(image.height - 1, Math.floor(y * scaleY)) * image.width * 3;
        const targetRow = y * size;
        for (let x = 0; x < size; x++) {
            const source = sourceRow + Math.min(image.width - 1, Math.floor(x * scaleX)) * 3;
            const target = targetRow + x;
            tensor[target] = image.rgb[source] / 255;
            tensor[planeSize + target] = image.rgb[source + 1] / 255;
            tensor[planeSize * 2 + target] = image.rgb[source + 2] / 255;
        }
    }
    return tensor;
}

/**
 * YOLO26 is end to end, so each of the 300 queries is already a final detection and no NMS is needed.
 * This export splits them into a class head and a box head, the box head being normalized center form.
 */
function decodeOutput(logits: Float32Array, boxes: Float32Array, queryCount: number, classCount: number, image: RgbImage): Detection[] {
    const detections: Detection[] = [];
    for (let query = 0; query < queryCount; query++) {
        let bestScore = 0;
        let bestClass = 0;
        for (let classId = 0; classId < classCount; classId++) {
            const score = 1 / (1 + Math.exp(-logits[query * classCount + classId]));
            if (score > bestScore) {
                bestScore = score;
                bestClass = classId;
            }
        }
        if (bestScore < SCORE_THRESHOLD) {
            continue;
        }
        const centerX = boxes[query * 4] * image.width;
        const centerY = boxes[query * 4 + 1] * image.height;
        const width = boxes[query * 4 + 2] * image.width;
        const height = boxes[query * 4 + 3] * image.height;
        detections.push({
            x: centerX - width / 2,
            y: centerY - height / 2,
            width,
            height,
            score: bestScore,
            classId: bestClass,
            className: COCO_CLASSES[bestClass] || `class ${bestClass}`,
        });
    }
    return detections;
}

export async function detect(image: RgbImage, name: ModelName): Promise<DetectionResult> {
    const session = await loadModel(name);
    const modelSize = inputSize(session);

    const preprocessStartedAtMs = Date.now();
    const input = new ort.Tensor("float32", resizeToTensor(image, modelSize), [1, 3, modelSize, modelSize]);
    const preprocessMs = Date.now() - preprocessStartedAtMs;

    const inferenceStartedAtMs = Date.now();
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const inferenceMs = Date.now() - inferenceStartedAtMs;

    const postprocessStartedAtMs = Date.now();
    const logits = outputs[LOGITS_OUTPUT];
    const boxes = outputs[BOXES_OUTPUT];
    if (!logits || !boxes) {
        throw new Error(`Expected outputs ${LOGITS_OUTPUT} and ${BOXES_OUTPUT}, got ${session.outputNames.join(", ")}`);
    }
    const detections = decodeOutput(logits.data as Float32Array, boxes.data as Float32Array, logits.dims[1], logits.dims[2], image);
    const postprocessMs = Date.now() - postprocessStartedAtMs;

    return { detections, preprocessMs, inferenceMs, postprocessMs };
}
