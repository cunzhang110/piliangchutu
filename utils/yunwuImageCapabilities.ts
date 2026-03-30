import { AspectRatio, ImageSize } from "../types";

export const YUNWU_ASPECT_RATIOS: AspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9"
];

type YunwuImageModelFamily = "gemini-3.1-flash-image-preview" | "gemini-3-pro-image-preview" | "gemini-2.5-flash-image" | "unknown";

const GEMINI_31_FLASH_RESOLUTIONS: Record<AspectRatio, Record<ImageSize, string>> = {
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

const GEMINI_3_PRO_RESOLUTIONS: Record<AspectRatio, Record<ImageSize, string>> = {
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

const GEMINI_25_FLASH_RESOLUTIONS: Record<AspectRatio, string> = {
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

export const getSupportedYunwuImageSizes = (modelName: string): ImageSize[] => {
  const family = getYunwuImageModelFamily(modelName);
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
  const family = getYunwuImageModelFamily(modelName);

  if (family === "gemini-3.1-flash-image-preview") {
    return GEMINI_31_FLASH_RESOLUTIONS[aspectRatio]?.[imageSize] || null;
  }

  if (family === "gemini-3-pro-image-preview") {
    return GEMINI_3_PRO_RESOLUTIONS[aspectRatio]?.[imageSize] || null;
  }

  if (family === "gemini-2.5-flash-image") {
    return GEMINI_25_FLASH_RESOLUTIONS[aspectRatio] || null;
  }

  return null;
};

export const getYunwuImageConfig = (
  modelName: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize
) => {
  const family = getYunwuImageModelFamily(modelName);

  if (family === "gemini-3.1-flash-image-preview" || family === "gemini-3-pro-image-preview") {
    return {
      aspectRatio,
      imageSize
    };
  }

  return {
    aspectRatio
  };
};

export const getYunwuResolutionSummary = (modelName: string, aspectRatio: AspectRatio, imageSize: ImageSize) => {
  const resolutionLabel = getYunwuResolutionLabel(modelName, aspectRatio, imageSize);
  const family = getYunwuImageModelFamily(modelName);

  if (!resolutionLabel) {
    return "当前模型未公开精确像素表，请以实际输出尺寸为准";
  }

  if (family === "gemini-2.5-flash-image") {
    return `当前比例原生输出约 ${resolutionLabel}`;
  }

  return `当前比例 ${aspectRatio} / ${imageSize} 约为 ${resolutionLabel}`;
};
