import { AspectRatio, ImageSize, ReferenceImageItem } from "../types";
import { getStoredApiKey } from "../utils/apiKeyStorage";
import { extractMentionNames } from "../utils/referenceMentions";
import { getYunwuImageConfig } from "../utils/yunwuImageCapabilities";

const YUNWU_LABEL = "云雾API";
const YUNWU_BASE_URL = (import.meta.env.VITE_YUNWU_BASE_URL || "https://yunwu.ai").replace(/\/$/, "");
const DEFAULT_YUNWU_API_KEY = import.meta.env.VITE_YUNWU_API_KEY?.trim() || "";
const DEFAULT_IMAGE_MODEL = import.meta.env.VITE_YUNWU_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image-preview";
const DEFAULT_TEXT_MODEL = import.meta.env.VITE_YUNWU_TEXT_MODEL?.trim() || "gemini-3-pro-preview";
const ENABLE_PROMPT_REWRITE = (import.meta.env.VITE_YUNWU_ENABLE_PROMPT_REWRITE || "true") !== "false";
const MIN_REQUEST_INTERVAL_MS = Number(import.meta.env.VITE_YUNWU_MIN_REQUEST_INTERVAL_MS || 15000);
const MAX_RATE_LIMIT_RETRIES = Number(import.meta.env.VITE_YUNWU_MAX_RATE_LIMIT_RETRIES || 6);
const RATE_LIMIT_COOLDOWN_MS = Number(import.meta.env.VITE_YUNWU_RATE_LIMIT_COOLDOWN_MS || 60000);
const REALISTIC_PROMPT_SUFFIX = "shot on iPhone 14 Pro, amateur photography, natural lighting, unedited, casual snapshot, slight motion blur, raw photo";

type GeminiNativeResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
        inline_data?: {
          data?: string;
          mime_type?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type ErrorShape = {
  error?: {
    message?: string;
  };
  message?: string;
};

const createError = (message: string, status?: number) => {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getApiKey = () => getStoredApiKey() || DEFAULT_YUNWU_API_KEY;

const getErrorMessage = (payload: ErrorShape | null, fallback: string) => {
  return payload?.error?.message || payload?.message || fallback;
};

const parsePayload = (rawText: string) => {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText) as ErrorShape;
  } catch {
    return { message: rawText };
  }
};

let requestQueue = Promise.resolve();
let lastRequestCompletedAt = 0;
let nextAllowedRequestAt = 0;

const withRequestSlot = async <T>(task: () => Promise<T>) => {
  const previous = requestQueue;
  let release!: () => void;
  requestQueue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  const waitUntil = Math.max(lastRequestCompletedAt + MIN_REQUEST_INTERVAL_MS, nextAllowedRequestAt);
  const waitMs = waitUntil - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  try {
    const result = await task();
    lastRequestCompletedAt = Date.now();
    return result;
  } finally {
    release();
  }
};

const getRetryDelayMs = (response: Response, attempt: number) => {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) {
      return Math.max(seconds * 1000, MIN_REQUEST_INTERVAL_MS);
    }

    const retryDate = new Date(retryAfter).getTime();
    if (!Number.isNaN(retryDate)) {
      return Math.max(retryDate - Date.now(), MIN_REQUEST_INTERVAL_MS);
    }
  }

  return Math.min(120000, Math.max(RATE_LIMIT_COOLDOWN_MS, MIN_REQUEST_INTERVAL_MS * Math.pow(2, attempt + 1)));
};

const requestJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw createError("API_KEY_MISSING");
  }

  return withRequestSlot(async () => {
    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(`${YUNWU_BASE_URL}${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(init.headers || {})
          }
        });
      } catch {
        throw createError(`网络请求失败，请检查 ${YUNWU_LABEL} 地址或本地网络。`);
      }

      const rawText = await response.text();
      const payload = parsePayload(rawText);

      if (response.ok) {
        lastRequestCompletedAt = Date.now();
        return (payload || {}) as T;
      }

      if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
        const delayMs = getRetryDelayMs(response, attempt);
        nextAllowedRequestAt = Math.max(nextAllowedRequestAt, Date.now() + delayMs);
        console.warn(`[${YUNWU_LABEL}] 触发 429，${Math.round(delayMs / 1000)} 秒后进行第 ${attempt + 1} 次重试`);
        await sleep(delayMs);
        continue;
      }

      throw createError(getErrorMessage(payload, `请求失败 (${response.status})`), response.status);
    }

    throw createError("API 频率达到上限 (429)，请稍后再试。", 429);
  });
};

const extractTextFromResponse = (response: GeminiNativeResponse) => {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part.text || "").join("\n").trim();
};

const extractImageFromResponse = (response: GeminiNativeResponse) => {
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inlineData = part.inlineData || part.inline_data;
    if (inlineData?.data) {
      const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
      return `data:${mimeType};base64,${inlineData.data}`;
    }
  }
  return "";
};

const toInlineImagePart = (referenceImageBase64: string) => {
  const matches = referenceImageBase64.match(/^data:([^;]+);base64,(.+)$/);
  if (!matches || matches.length !== 3) {
    return null;
  }

  return {
    inline_data: {
      mime_type: matches[1],
      data: matches[2]
    }
  };
};

const buildReferenceParts = (referenceImages: ReferenceImageItem[], prompt: string) => {
  if (!referenceImages.length) return [];
  const mentionNames = extractMentionNames(prompt);
  if (mentionNames.length === 0) return [];

  const orderedReferences: ReferenceImageItem[] = [];
  const seenIds = new Set<string>();

  mentionNames.forEach(name => {
    const matchedReference = referenceImages.find(reference => reference.name === name);
    if (matchedReference && !seenIds.has(matchedReference.id)) {
      orderedReferences.push(matchedReference);
      seenIds.add(matchedReference.id);
    }
  });

  const parts: Array<Record<string, unknown>> = [];
  orderedReferences.forEach(reference => {
    const imagePart = toInlineImagePart(reference.imageData);
    if (imagePart) {
      parts.push({ text: `参考图 @${reference.name}` });
      parts.push(imagePart);
    }
  });

  return parts;
};

export const getProviderLabel = () => YUNWU_LABEL;
export const getDefaultImageModel = () => DEFAULT_IMAGE_MODEL;
export const getDefaultTextModel = () => DEFAULT_TEXT_MODEL;
export const hasConfiguredApiKey = () => Boolean(getApiKey());

export const preparePromptForImage = async (
  prompt: string,
  useLanguageModel: boolean,
  textModelOverride?: string
): Promise<string> => {
  if (!useLanguageModel) {
    return prompt;
  }

  if (!ENABLE_PROMPT_REWRITE) {
    return `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  }

  const textModel = textModelOverride?.trim() || DEFAULT_TEXT_MODEL;

  try {
    const response = await requestJson<GeminiNativeResponse>(`/v1beta/models/${encodeURIComponent(textModel)}:generateContent`, {
      method: "POST",
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: "You rewrite image prompts for photorealistic image generation. Preserve the user's subject and intent, add camera, lighting, composition, material, and realism cues, avoid policy-risky details, and return only the final prompt."
            }
          ]
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `请把下面这段中文或英文提示词改写成更适合真实摄影风格出图的提示词，保持主体和语义不变，只返回改写后的提示词：\n${prompt}`
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.6
        }
      })
    });

    return extractTextFromResponse(response) || `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  } catch (error) {
    console.warn("Prompt rewrite failed, fallback to local suffix injection.", error);
    return `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  }
};

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize,
  referenceImages?: ReferenceImageItem[],
  imageModelOverride?: string
): Promise<string> => {
  const imageModel = imageModelOverride?.trim() || DEFAULT_IMAGE_MODEL;
  const parts: Array<Record<string, unknown>> = [...buildReferenceParts(referenceImages || [], prompt), { text: prompt }];

  try {
    const response = await requestJson<GeminiNativeResponse>(`/v1beta/models/${encodeURIComponent(imageModel)}:generateContent`, {
      method: "POST",
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: getYunwuImageConfig(imageModel, aspectRatio, imageSize)
        }
      })
    });

    if (response.candidates?.[0]?.finishReason === "SAFETY") {
      throw createError("内容安全拦截：您的 Prompt 可能包含违规词汇。");
    }

    const imageDataUrl = extractImageFromResponse(response);
    if (imageDataUrl) {
      return imageDataUrl;
    }

    const textMessage = extractTextFromResponse(response);
    throw createError(textMessage || "生成成功但未获取到图像数据。");
  } catch (error) {
    const serviceError = error as Error & { status?: number };
    const status = serviceError.status || 0;
    const message = serviceError.message || "未知故障";

    if (message === "API_KEY_MISSING") {
      throw serviceError;
    }

    if (status === 401 || message.includes("API_KEY_INVALID")) {
      throw createError("API_KEY_EXPIRED");
    }

    if (status === 403) {
      throw createError(`权限不足 (403)，请确认 ${YUNWU_LABEL} Key 对应账户已开通目标模型。`);
    }

    if (status === 429 || message.includes("429")) {
      throw createError("API 频率达到上限 (429)，请降低并发并稍后再试。");
    }

    if (message.includes("无可用渠道")) {
      throw createError(`${YUNWU_LABEL} 当前账号下模型 ${imageModel} 没有可用通道。请到后台检查该模型是否已开通，或改用供应商给你的可用模型名。`);
    }

    throw serviceError;
  }
};
