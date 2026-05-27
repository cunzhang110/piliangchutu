import { AspectRatio, ImageSize } from "../types";

export const YUNWU_ASPECT_RATIOS: AspectRatio[] = [
  "1:1",
  "1:4",
  "1:8",
  "2:3",
  "3:2",
  "3:4",
  "4:1",
  "4:3",
  "4:5",
  "5:4",
  "8:1",
  "9:16",
  "16:9",
  "21:9"
];

type YunwuImageModelFamily = "gemini-3.1-flash-image-preview" | "gemini-3-pro-image-preview" | "gemini-2.5-flash-image" | "unknown";
type APIMartImageModelFamily = "gemini-3.1-flash-image-preview-official" | "gpt-image-2" | "gpt-image-2-official" | "unknown";

type RatioParts = {
  width: number;
  height: number;
};

const GEMINI_31_FLASH_RESOLUTIONS: Record<string, Record<ImageSize, string>> = {
  "1:1": { "1K": "1024 x 1024", "2K": "2048 x 2048", "4K": "4096 x 4096" },
  "2:3": { "1K": "848 x 1264", "2K": "1696 x 2528", "4K": "3392 x 5056" },
  "3:2": { "1K": "1264 x 848", "2K": "2528 x 1696", "4K": "5056 x 3392" },
  "3:4": { "1K": "896 x 1200", "2K": "1792 x 2400", "4K": "3584 x 4800" },
  "4:3": { "1K": "1200 x 896", "2K": "2400 x 1792", "4K": "4800 x 3584" },
  "4:5": { "1K": "928 x 1152", "2K": "1856 x 2304", "4K": "3712 x 4608" },
  "5:4": { "1K": "1152 x 928", "2K": "2304 x 1856", "4K": "4608 x 3712" },
  "9:16": { "1K": "768 x 1376", "2K": "1536 x 2752", "4K": "3072 x 5504" },
  "16:9": { "1K": "1376 x 768", "2K": "2752 x 1536", "4K": "5504 x 3072" },
  "21:9": { "1K": "1584 x 672", "2K": "3168 x 1344", "4K": "6336 x 2688" }
};

const GEMINI_3_PRO_RESOLUTIONS: Record<string, Record<ImageSize, string>> = {
  ...GEMINI_31_FLASH_RESOLUTIONS
};

const GEMINI_25_FLASH_RESOLUTIONS: Record<string, string> = {
  "1:1": "1024 x 1024",
  "2:3": "832 x 1248",
  "3:2": "1248 x 832",
  "3:4": "864 x 1184",
  "4:3": "1184 x 864",
  "4:5": "896 x 1152",
  "5:4": "1152 x 896",
  "9:16": "768 x 1344",
  "16:9": "1344 x 768",
  "21:9": "1536 x 672"
};

const IMAGE_PIXEL_AREA: Record<ImageSize, number> = {
  "1K": 1024 * 1024,
  "2K": 2048 * 2048,
  "4K": 4096 * 4096
};

const gcd = (left: number, right: number): number => {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
};

export const normalizeAspectRatio = (aspectRatio: string) => {
  const normalized = aspectRatio.trim().replace(/[xX*]/g, ":").replace(/\s+/g, "");
  if (YUNWU_ASPECT_RATIOS.includes(normalized)) {
    return normalized;
  }

  const matched = normalized.match(/^(\d+):(\d+)$/);
  if (!matched) {
    return normalized;
  }

  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return normalized;
  }

  const divisor = gcd(width, height);
  const reducedRatio = `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  const canonicalRatio = YUNWU_ASPECT_RATIOS.find(
    supportedRatio => {
      const supportedMatch = supportedRatio.match(/^(\d+):(\d+)$/);
      if (!supportedMatch) return false;
      const supportedWidth = Number(supportedMatch[1]);
      const supportedHeight = Number(supportedMatch[2]);
      const supportedDivisor = gcd(supportedWidth, supportedHeight);
      return `${Math.round(supportedWidth / supportedDivisor)}:${Math.round(supportedHeight / supportedDivisor)}` === reducedRatio;
    }
  );

  return canonicalRatio || reducedRatio;
};

export const isValidAspectRatio = (aspectRatio: string) => {
  return /^(\d+):(\d+)$/.test(normalizeAspectRatio(aspectRatio));
};

export const getAspectRatioParts = (aspectRatio: string): RatioParts | null => {
  const normalized = normalizeAspectRatio(aspectRatio);
  const matched = normalized.match(/^(\d+):(\d+)$/);
  if (!matched) return null;

  const width = Number(matched[1]);
  const height = Number(matched[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { width, height };
};

export const getAspectRatioValidationMessage = (aspectRatio: string) => {
  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  const parts = getAspectRatioParts(normalizedRatio);
  if (!parts) {
    return "请输入有效比例，例如 3:4";
  }

  if (!YUNWU_ASPECT_RATIOS.includes(normalizedRatio)) {
    return `云雾当前只支持 ${YUNWU_ASPECT_RATIOS.join('、')}，${normalizedRatio} 不在支持列表里。`;
  }

  return null;
};

const calculateCustomResolution = (aspectRatio: string, imageSize: ImageSize) => {
  const parts = getAspectRatioParts(aspectRatio);
  if (!parts) return null;

  const ratio = parts.width / parts.height;
  const area = IMAGE_PIXEL_AREA[imageSize];
  const rawWidth = Math.sqrt(area * ratio);
  const rawHeight = rawWidth / ratio;

  const width = Math.max(64, Math.round(rawWidth / 32) * 32);
  const height = Math.max(64, Math.round(rawHeight / 32) * 32);
  return `${width} x ${height}`;
};

export const getYunwuImageModelFamily = (modelName: string): YunwuImageModelFamily => {
  const normalizedModel = modelName.trim().toLowerCase();

  if (normalizedModel.includes("gemini-3-pro-image-preview")) {
    return "gemini-3-pro-image-preview";
  }

  if (normalizedModel.includes("gemini-3.1-flash-image-preview")) {
    return "gemini-3.1-flash-image-preview";
  }

  if (normalizedModel.includes("gemini-2.5-flash-image")) {
    return "gemini-2.5-flash-image";
  }

  return "unknown";
};

export const getSupportedYunwuAspectRatios = (_modelName: string): AspectRatio[] => {
  return YUNWU_ASPECT_RATIOS;
};

export const getAPIMartImageModelFamily = (modelName: string): APIMartImageModelFamily => {
  const normalizedModel = modelName.trim().toLowerCase();

  if (normalizedModel === "gemini-3.1-flash-image-preview-official") {
    return "gemini-3.1-flash-image-preview-official";
  }

  if (normalizedModel === "gpt-image-2-official") {
    return "gpt-image-2-official";
  }

  if (normalizedModel === "gpt-image-2") {
    return "gpt-image-2";
  }

  return "unknown";
};

export const getSupportedYunwuImageSizes = (modelName: string): ImageSize[] => {
  const yunwuFamily = getYunwuImageModelFamily(modelName);
  const apimartFamily = getAPIMartImageModelFamily(modelName);

  if (apimartFamily === "gpt-image-2" || apimartFamily === "gpt-image-2-official") {
    return ["1K", "2K"];
  }

  if (apimartFamily === "gemini-3.1-flash-image-preview-official") {
    return ["1K", "2K", "4K"];
  }

  const family = yunwuFamily;
  if (family === "gemini-3.1-flash-image-preview" || family === "gemini-3-pro-image-preview") {
    return ["1K", "2K", "4K"];
  }

  return ["1K"];
};

export const supportsYunwuImageSize = (modelName: string) => {
  return getSupportedYunwuImageSizes(modelName).length > 1;
};

export const getYunwuResolutionLabel = (
  modelName: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize
) => {
  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  const family = getYunwuImageModelFamily(modelName);
  const apimartFamily = getAPIMartImageModelFamily(modelName);

  if (apimartFamily === "gemini-3.1-flash-image-preview-official") {
    return GEMINI_31_FLASH_RESOLUTIONS[normalizedRatio]?.[imageSize] || calculateCustomResolution(normalizedRatio, imageSize);
  }

  if (apimartFamily === "gpt-image-2" || apimartFamily === "gpt-image-2-official") {
    const normalizedSize = imageSize === "4K" ? "2K" : imageSize;
    return GEMINI_31_FLASH_RESOLUTIONS[normalizedRatio]?.[normalizedSize] || calculateCustomResolution(normalizedRatio, normalizedSize);
  }

  if (family === "gemini-3.1-flash-image-preview") {
    return GEMINI_31_FLASH_RESOLUTIONS[normalizedRatio]?.[imageSize] || calculateCustomResolution(normalizedRatio, imageSize);
  }

  if (family === "gemini-3-pro-image-preview") {
    return GEMINI_3_PRO_RESOLUTIONS[normalizedRatio]?.[imageSize] || calculateCustomResolution(normalizedRatio, imageSize);
  }

  if (family === "gemini-2.5-flash-image") {
    return GEMINI_25_FLASH_RESOLUTIONS[normalizedRatio] || calculateCustomResolution(normalizedRatio, "1K");
  }

  return calculateCustomResolution(normalizedRatio, imageSize);
};

export const getYunwuImageConfig = (
  modelName: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize
) => {
  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  const family = getYunwuImageModelFamily(modelName);
  const apimartFamily = getAPIMartImageModelFamily(modelName);

  if (apimartFamily === "gpt-image-2" || apimartFamily === "gpt-image-2-official") {
    return {
      aspectRatio: normalizedRatio,
      imageSize: imageSize === "4K" ? "2K" : imageSize
    };
  }

  if (apimartFamily === "gemini-3.1-flash-image-preview-official") {
    return {
      aspectRatio: normalizedRatio,
      imageSize
    };
  }

  if (family === "gemini-3.1-flash-image-preview" || family === "gemini-3-pro-image-preview") {
    return {
      aspectRatio: normalizedRatio,
      imageSize
    };
  }

  return {
    aspectRatio: normalizedRatio
  };
};

export const getYunwuResolutionSummary = (modelName: string, aspectRatio: AspectRatio, imageSize: ImageSize) => {
  const normalizedRatio = normalizeAspectRatio(aspectRatio);
  const resolutionLabel = getYunwuResolutionLabel(modelName, normalizedRatio, imageSize);
  const family = getYunwuImageModelFamily(modelName);
  const apimartFamily = getAPIMartImageModelFamily(modelName);

  if (!resolutionLabel) {
    return "当前模型未公开精确像素表，请以实际输出尺寸为准";
  }

  if (apimartFamily === "gpt-image-2" || apimartFamily === "gpt-image-2-official") {
    return imageSize === "4K"
      ? `当前模型在 APIMart 下最高只到 2K，已自动按 2K 处理，比例 ${normalizedRatio} 约为 ${resolutionLabel}`
      : `当前比例 ${normalizedRatio} / ${imageSize} 约为 ${resolutionLabel}`;
  }

  if (family === "gemini-2.5-flash-image") {
    return `当前比例 ${normalizedRatio} 原生输出约 ${resolutionLabel}`;
  }

  return `当前比例 ${normalizedRatio} / ${imageSize} 约为 ${resolutionLabel}`;
};
