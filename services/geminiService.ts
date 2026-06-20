import { AspectRatio, ImageSize, ReferenceImageItem, ServiceProvider } from "../types";
import { getStoredApiKey } from "../utils/apiKeyStorage";
import { extractMentionNames } from "../utils/referenceMentions";
import { getYunwuImageConfig, getYunwuResolutionLabel } from "../utils/yunwuImageCapabilities";

const REALISTIC_PROMPT_SUFFIX = "shot on iPhone 14 Pro, amateur photography, natural lighting, unedited, casual snapshot, slight motion blur, raw photo";

const PROVIDER_LABELS: Record<ServiceProvider, string> = {
  yunwu: "云雾API",
  apimart: "APIMart",
  muzhi: "Muzhi"
};

const YUNWU_BASE_URL = (import.meta.env.VITE_YUNWU_BASE_URL || "https://yunwu.ai").replace(/\/$/, "");
const YUNWU_DEFAULT_API_KEY = import.meta.env.VITE_YUNWU_API_KEY?.trim() || "";
const YUNWU_DEFAULT_IMAGE_MODEL = import.meta.env.VITE_YUNWU_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image-preview";
const YUNWU_DEFAULT_TEXT_MODEL = import.meta.env.VITE_YUNWU_TEXT_MODEL?.trim() || "gemini-3-pro-preview";
const YUNWU_ENABLE_PROMPT_REWRITE = (import.meta.env.VITE_YUNWU_ENABLE_PROMPT_REWRITE || "true") !== "false";
const YUNWU_MIN_REQUEST_INTERVAL_MS = Number(import.meta.env.VITE_YUNWU_MIN_REQUEST_INTERVAL_MS || 15000);
const YUNWU_MAX_RATE_LIMIT_RETRIES = Number(import.meta.env.VITE_YUNWU_MAX_RATE_LIMIT_RETRIES || 6);
const YUNWU_RATE_LIMIT_COOLDOWN_MS = Number(import.meta.env.VITE_YUNWU_RATE_LIMIT_COOLDOWN_MS || 60000);

const APIMART_BASE_URL = (import.meta.env.VITE_APIMART_BASE_URL || "https://api.apimart.ai").replace(/\/$/, "");
const APIMART_DEFAULT_API_KEY = import.meta.env.VITE_APIMART_API_KEY?.trim() || "";
const APIMART_DEFAULT_IMAGE_MODEL = import.meta.env.VITE_APIMART_IMAGE_MODEL?.trim() || "gpt-image-2";
const APIMART_DEFAULT_TEXT_MODEL = import.meta.env.VITE_APIMART_TEXT_MODEL?.trim() || "gemini-2.5-pro";
const APIMART_ENABLE_PROMPT_REWRITE = (import.meta.env.VITE_APIMART_ENABLE_PROMPT_REWRITE || "true") !== "false";
const APIMART_MIN_REQUEST_INTERVAL_MS = Number(import.meta.env.VITE_APIMART_MIN_REQUEST_INTERVAL_MS || 5000);
const APIMART_MAX_RATE_LIMIT_RETRIES = Number(import.meta.env.VITE_APIMART_MAX_RATE_LIMIT_RETRIES || 4);
const APIMART_RATE_LIMIT_COOLDOWN_MS = Number(import.meta.env.VITE_APIMART_RATE_LIMIT_COOLDOWN_MS || 30000);
const APIMART_TASK_POLL_INTERVAL_MS = Number(import.meta.env.VITE_APIMART_TASK_POLL_INTERVAL_MS || 2500);
const APIMART_TASK_POLL_TIMEOUT_MS = Number(import.meta.env.VITE_APIMART_TASK_POLL_TIMEOUT_MS || 120000);

const MUZHI_BASE_URL = (import.meta.env.VITE_MUZHI_BASE_URL || "/api/muzhi").replace(/\/$/, "");
const MUZHI_DEFAULT_API_KEY = import.meta.env.VITE_MUZHI_API_KEY?.trim() || "";
const MUZHI_DEFAULT_IMAGE_MODEL = import.meta.env.VITE_MUZHI_IMAGE_MODEL?.trim() || "gpt-image-2";
const MUZHI_DEFAULT_TEXT_MODEL = import.meta.env.VITE_MUZHI_TEXT_MODEL?.trim() || "gemini-2.5-pro";
const MUZHI_ENABLE_PROMPT_REWRITE = (import.meta.env.VITE_MUZHI_ENABLE_PROMPT_REWRITE || "false") === "true";
const MUZHI_MIN_REQUEST_INTERVAL_MS = Number(import.meta.env.VITE_MUZHI_MIN_REQUEST_INTERVAL_MS || 5000);
const MUZHI_MAX_RATE_LIMIT_RETRIES = Number(import.meta.env.VITE_MUZHI_MAX_RATE_LIMIT_RETRIES || 4);
const MUZHI_RATE_LIMIT_COOLDOWN_MS = Number(import.meta.env.VITE_MUZHI_RATE_LIMIT_COOLDOWN_MS || 30000);
const MUZHI_TASK_POLL_INTERVAL_MS = Number(import.meta.env.VITE_MUZHI_TASK_POLL_INTERVAL_MS || 2500);
const MUZHI_TASK_POLL_TIMEOUT_MS = Number(import.meta.env.VITE_MUZHI_TASK_POLL_TIMEOUT_MS || 120000);

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
  detail?: string;
};

type OpenAICompatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type APIMartImageTaskCreateResponse = {
  task_id?: string;
  id?: string;
  code?: number;
  data?: Array<{
    task_id?: string;
    id?: string;
    status?: string;
  }> | {
    task_id?: string;
    id?: string;
  };
  error?: {
    message?: string;
  };
};

type APIMartTaskStatusResponse = {
  code?: number;
  status?: string;
  task_status?: string;
  state?: string;
  output?: {
    image_urls?: string[];
    images?: Array<{ url?: string }>;
  };
  result?: {
    image_urls?: string[];
    images?: Array<{ url?: string }>;
  };
  data?: {
    status?: string;
    task_status?: string;
    state?: string;
    id?: string;
    progress?: number;
    output?: {
      image_urls?: string[];
      images?: Array<{ url?: string }>;
    };
    result?: {
      image_urls?: string[];
      images?: Array<{ url?: string[] | string }>;
    };
  };
  error?: {
    message?: string;
  };
  message?: string;
};

type MuzhiImageGenerationResponse = APIMartImageTaskCreateResponse & {
  data?: Array<{
    url?: string;
    b64_json?: string;
    image_url?: string;
    task_id?: string;
    id?: string;
  }> | {
    url?: string;
    b64_json?: string;
    image_url?: string;
    task_id?: string;
    id?: string;
  };
  url?: string;
  image_url?: string;
  b64_json?: string;
};

type RequestSlotState = {
  queue: Promise<void>;
  lastRequestCompletedAt: number;
  nextAllowedRequestAt: number;
};

const requestSlotStates: Record<ServiceProvider, RequestSlotState> = {
  yunwu: {
    queue: Promise.resolve(),
    lastRequestCompletedAt: 0,
    nextAllowedRequestAt: 0
  },
  apimart: {
    queue: Promise.resolve(),
    lastRequestCompletedAt: 0,
    nextAllowedRequestAt: 0
  },
  muzhi: {
    queue: Promise.resolve(),
    lastRequestCompletedAt: 0,
    nextAllowedRequestAt: 0
  }
};

const createError = (message: string, status?: number) => {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const getProviderConfig = (provider: ServiceProvider) => {
  if (provider === "apimart") {
    return {
      label: PROVIDER_LABELS.apimart,
      baseUrl: APIMART_BASE_URL,
      defaultApiKey: APIMART_DEFAULT_API_KEY,
      defaultImageModel: APIMART_DEFAULT_IMAGE_MODEL,
      defaultTextModel: APIMART_DEFAULT_TEXT_MODEL,
      enablePromptRewrite: APIMART_ENABLE_PROMPT_REWRITE,
      minRequestIntervalMs: APIMART_MIN_REQUEST_INTERVAL_MS,
      maxRateLimitRetries: APIMART_MAX_RATE_LIMIT_RETRIES,
      rateLimitCooldownMs: APIMART_RATE_LIMIT_COOLDOWN_MS
    };
  }

  if (provider === "muzhi") {
    return {
      label: PROVIDER_LABELS.muzhi,
      baseUrl: MUZHI_BASE_URL,
      defaultApiKey: MUZHI_DEFAULT_API_KEY,
      defaultImageModel: MUZHI_DEFAULT_IMAGE_MODEL,
      defaultTextModel: MUZHI_DEFAULT_TEXT_MODEL,
      enablePromptRewrite: MUZHI_ENABLE_PROMPT_REWRITE,
      minRequestIntervalMs: MUZHI_MIN_REQUEST_INTERVAL_MS,
      maxRateLimitRetries: MUZHI_MAX_RATE_LIMIT_RETRIES,
      rateLimitCooldownMs: MUZHI_RATE_LIMIT_COOLDOWN_MS
    };
  }

  return {
    label: PROVIDER_LABELS.yunwu,
    baseUrl: YUNWU_BASE_URL,
    defaultApiKey: YUNWU_DEFAULT_API_KEY,
    defaultImageModel: YUNWU_DEFAULT_IMAGE_MODEL,
    defaultTextModel: YUNWU_DEFAULT_TEXT_MODEL,
    enablePromptRewrite: YUNWU_ENABLE_PROMPT_REWRITE,
    minRequestIntervalMs: YUNWU_MIN_REQUEST_INTERVAL_MS,
    maxRateLimitRetries: YUNWU_MAX_RATE_LIMIT_RETRIES,
    rateLimitCooldownMs: YUNWU_RATE_LIMIT_COOLDOWN_MS
  };
};

const getTaskPollConfig = (provider: ServiceProvider) => {
  if (provider === "muzhi") {
    return {
      intervalMs: MUZHI_TASK_POLL_INTERVAL_MS,
      timeoutMs: MUZHI_TASK_POLL_TIMEOUT_MS
    };
  }

  return {
    intervalMs: APIMART_TASK_POLL_INTERVAL_MS,
    timeoutMs: APIMART_TASK_POLL_TIMEOUT_MS
  };
};

const getApiKey = (provider: ServiceProvider) => {
  const providerConfig = getProviderConfig(provider);
  return getStoredApiKey(provider) || providerConfig.defaultApiKey;
};

const getErrorMessage = (payload: ErrorShape | null, fallback: string) => {
  return payload?.error?.message || payload?.message || payload?.detail || fallback;
};

const parsePayload = (rawText: string) => {
  if (!rawText) return null;
  try {
    return JSON.parse(rawText) as ErrorShape;
  } catch {
    return { message: rawText };
  }
};

const withRequestSlot = async <T>(provider: ServiceProvider, task: () => Promise<T>) => {
  const state = requestSlotStates[provider];
  const providerConfig = getProviderConfig(provider);
  const previous = state.queue;
  let release!: () => void;

  state.queue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  const waitUntil = Math.max(
    state.lastRequestCompletedAt + providerConfig.minRequestIntervalMs,
    state.nextAllowedRequestAt
  );
  const waitMs = waitUntil - Date.now();
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  try {
    const result = await task();
    state.lastRequestCompletedAt = Date.now();
    return result;
  } finally {
    release();
  }
};

const getRetryDelayMs = (provider: ServiceProvider, response: Response, attempt: number) => {
  const providerConfig = getProviderConfig(provider);
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) {
      return Math.max(seconds * 1000, providerConfig.minRequestIntervalMs);
    }

    const retryDate = new Date(retryAfter).getTime();
    if (!Number.isNaN(retryDate)) {
      return Math.max(retryDate - Date.now(), providerConfig.minRequestIntervalMs);
    }
  }

  return Math.min(
    120000,
    Math.max(providerConfig.rateLimitCooldownMs, providerConfig.minRequestIntervalMs * Math.pow(2, attempt + 1))
  );
};

const requestJson = async <T>(provider: ServiceProvider, path: string, init: RequestInit): Promise<T> => {
  const providerConfig = getProviderConfig(provider);
  const apiKey = getApiKey(provider);
  const usesServerProxy = provider === "muzhi" && providerConfig.baseUrl.startsWith("/api/");
  if (!apiKey && !usesServerProxy) {
    throw createError("API_KEY_MISSING");
  }

  return withRequestSlot(provider, async () => {
    for (let attempt = 0; attempt <= providerConfig.maxRateLimitRetries; attempt += 1) {
      let response: Response;

      try {
        response = await fetch(`${providerConfig.baseUrl}${path}`, {
          ...init,
          headers: {
            ...(apiKey && !usesServerProxy ? { Authorization: `Bearer ${apiKey}` } : {}),
            "Content-Type": "application/json",
            ...(init.headers || {})
          }
        });
      } catch {
        throw createError(`网络请求失败，请检查 ${providerConfig.label} 地址或本地网络。`);
      }

      const rawText = await response.text();
      const payload = parsePayload(rawText);
      const errorMessage = getErrorMessage(payload, `请求失败 (${response.status})`);

      if (response.ok) {
        requestSlotStates[provider].lastRequestCompletedAt = Date.now();
        return (payload || {}) as T;
      }

      if (
        response.status === 401
        || errorMessage.includes("API_KEY_INVALID")
        || errorMessage.includes("无效令牌")
        || errorMessage.toLowerCase().includes("invalid token")
      ) {
        throw createError("API_KEY_EXPIRED", response.status);
      }

      if (response.status === 429 && attempt < providerConfig.maxRateLimitRetries) {
        const delayMs = getRetryDelayMs(provider, response, attempt);
        requestSlotStates[provider].nextAllowedRequestAt = Math.max(
          requestSlotStates[provider].nextAllowedRequestAt,
          Date.now() + delayMs
        );
        console.warn(`[${providerConfig.label}] 触发 429，${Math.round(delayMs / 1000)} 秒后进行第 ${attempt + 1} 次重试`);
        await sleep(delayMs);
        continue;
      }

      throw createError(errorMessage, response.status);
    }

    throw createError("API 频率达到上限 (429)，请稍后再试。", 429);
  });
};

const extractTextFromGeminiResponse = (response: GeminiNativeResponse) => {
  const parts = response.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part.text || "").join("\n").trim();
};

const extractImageFromGeminiResponse = (response: GeminiNativeResponse) => {
  const parts = response.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inlineData = part.inlineData
      ? { data: part.inlineData.data, mimeType: part.inlineData.mimeType }
      : part.inline_data
        ? { data: part.inline_data.data, mimeType: part.inline_data.mime_type }
        : undefined;
    if (inlineData?.data) {
      const mimeType = inlineData.mimeType || "image/png";
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

const buildYunwuReferenceParts = (referenceImages: ReferenceImageItem[], prompt: string) => {
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

const buildAPIMartReferenceImageUrls = (referenceImages: ReferenceImageItem[], prompt: string) => {
  if (!referenceImages.length) return [];
  const mentionNames = extractMentionNames(prompt);
  if (mentionNames.length === 0) return [];

  const urls: string[] = [];
  const seenIds = new Set<string>();

  mentionNames.forEach(name => {
    const matchedReference = referenceImages.find(reference => reference.name === name);
    if (matchedReference && !seenIds.has(matchedReference.id)) {
      urls.push(matchedReference.imageData);
      seenIds.add(matchedReference.id);
    }
  });

  return urls;
};

const fetchImageAsDataUrl = async (imageUrl: string) => {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw createError(`下载结果图片失败 (${response.status})`);
  }

  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(createError("结果图片转码失败"));
    reader.readAsDataURL(blob);
  });
};

const normalizeResolutionSize = (resolutionLabel: string | null) => {
  return resolutionLabel?.replace(/\s*x\s*/i, "x").trim() || "";
};

const getMuzhiImageSize = (imageModel: string, aspectRatio: AspectRatio, imageSize: ImageSize) => {
  return normalizeResolutionSize(getYunwuResolutionLabel(imageModel, aspectRatio, imageSize)) || "1024x1024";
};

const extractDirectImageUrl = (response: MuzhiImageGenerationResponse) => {
  const firstDataItem = (Array.isArray(response.data) ? response.data[0] : response.data) as Record<string, unknown> | undefined;
  return response.url || response.image_url || String(firstDataItem?.url || firstDataItem?.image_url || "");
};

const extractDirectImageBase64 = (response: MuzhiImageGenerationResponse) => {
  const firstDataItem = (Array.isArray(response.data) ? response.data[0] : response.data) as Record<string, unknown> | undefined;
  return response.b64_json || String(firstDataItem?.b64_json || "");
};

const generateMuzhiImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize,
  imageModel: string,
  referenceImages?: ReferenceImageItem[],
  referencePrompt?: string
) => {
  const imageUrls = buildAPIMartReferenceImageUrls(referenceImages || [], referencePrompt || prompt);
  const payload: Record<string, unknown> = {
    model: imageModel,
    prompt,
    size: getMuzhiImageSize(imageModel, aspectRatio, imageSize),
    n: 1
  };

  if (imageUrls.length > 0) {
    payload.image_urls = imageUrls;
  }

  const response = await requestJson<MuzhiImageGenerationResponse>("muzhi", "/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const imageBase64 = extractDirectImageBase64(response);
  if (imageBase64) {
    return imageBase64.startsWith("data:") ? imageBase64 : `data:image/png;base64,${imageBase64}`;
  }

  const imageUrl = extractDirectImageUrl(response);
  if (imageUrl) {
    return await fetchImageAsDataUrl(imageUrl);
  }

  const taskId = response.task_id
    || response.id
    || (Array.isArray(response.data) ? response.data[0]?.task_id || response.data[0]?.id : response.data?.task_id || response.data?.id);
  if (taskId) {
    const polledImageUrl = await pollOpenAICompatibleImageTask("muzhi", taskId);
    return await fetchImageAsDataUrl(polledImageUrl);
  }

  throw createError("Muzhi 已接收请求，但没有返回图片或任务 ID。");
};

const createOpenAICompatibleImageTask = async (
  provider: ServiceProvider,
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize,
  imageModel: string,
  referenceImages?: ReferenceImageItem[],
  referencePrompt?: string
) => {
  const imageUrls = buildAPIMartReferenceImageUrls(referenceImages || [], referencePrompt || prompt);
  const normalizedModel = imageModel.trim().toLowerCase();
  const isGPTImage2 = normalizedModel === "gpt-image-2";
  const isGPTImage2Official = normalizedModel === "gpt-image-2-official";
  const isGeminiOfficial = normalizedModel === "gemini-3.1-flash-image-preview-official";

  const payload: Record<string, unknown> = {
    model: imageModel,
    prompt,
    size: aspectRatio,
    n: 1
  };

  if (imageUrls.length > 0) {
    payload.image_urls = imageUrls;
  }

  if (isGeminiOfficial || isGPTImage2Official) {
    payload.resolution = imageSize.toLowerCase();
  }

  if (!isGPTImage2) {
    payload.return_base64 = false;
  }

  const response = await requestJson<APIMartImageTaskCreateResponse>(provider, "/v1/images/generations", {
    method: "POST",
    body: JSON.stringify(payload)
  });

  const taskId = response.task_id
    || response.id
    || (Array.isArray(response.data) ? response.data[0]?.task_id || response.data[0]?.id : response.data?.task_id || response.data?.id);
  if (!taskId) {
    throw createError(`${getProviderConfig(provider).label} 已接收请求，但没有返回任务 ID。`);
  }

  return taskId;
};

const pollOpenAICompatibleImageTask = async (provider: ServiceProvider, taskId: string) => {
  const startedAt = Date.now();
  const pollConfig = getTaskPollConfig(provider);
  const providerLabel = getProviderConfig(provider).label;

  while (Date.now() - startedAt < pollConfig.timeoutMs) {
    const response = await requestJson<APIMartTaskStatusResponse>(provider, `/v1/tasks/${encodeURIComponent(taskId)}?language=zh`, {
      method: "GET"
    });

    const status = response.status || response.task_status || response.state || response.data?.status || response.data?.task_status || response.data?.state || "";
    const normalizedStatus = status.toLowerCase();
    const output = response.output || response.result || response.data?.output || response.data?.result;
    const imageUrl =
      output?.image_urls?.[0]
      || (Array.isArray(output?.images?.[0]?.url) ? output?.images?.[0]?.url?.[0] : output?.images?.[0]?.url);

    if (["succeeded", "success", "completed", "done"].includes(normalizedStatus) && imageUrl) {
      return imageUrl;
    }

    if (["failed", "error", "cancelled"].includes(normalizedStatus)) {
      throw createError(response.error?.message || response.message || `${providerLabel} 任务执行失败。`);
    }

    await sleep(pollConfig.intervalMs);
  }

  throw createError(`${providerLabel} 任务轮询超时，请稍后重试。`);
};

export const getProviderLabel = (provider: ServiceProvider) => PROVIDER_LABELS[provider];
export const getDefaultImageModel = (provider: ServiceProvider) => getProviderConfig(provider).defaultImageModel;
export const getDefaultTextModel = (provider: ServiceProvider) => getProviderConfig(provider).defaultTextModel;
export const hasConfiguredApiKey = (provider: ServiceProvider) => Boolean(getApiKey(provider));

export const preparePromptForImage = async (
  prompt: string,
  useLanguageModel: boolean,
  provider: ServiceProvider,
  textModelOverride?: string
): Promise<string> => {
  if (!useLanguageModel) {
    return prompt;
  }

  const providerConfig = getProviderConfig(provider);
  if (!providerConfig.enablePromptRewrite) {
    return `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  }

  const textModel = textModelOverride?.trim() || providerConfig.defaultTextModel;

  try {
    if (provider === "apimart" || provider === "muzhi") {
      const response = await requestJson<OpenAICompatResponse>(provider, "/api/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: textModel,
          temperature: 0.6,
          messages: [
            {
              role: "system",
              content: "You rewrite image prompts for photorealistic image generation. Preserve the user's subject and intent, add camera, lighting, composition, material, and realism cues, avoid policy-risky details, and return only the final prompt."
            },
            {
              role: "user",
              content: `请把下面这段中文或英文提示词改写成更适合真实摄影风格出图的提示词，保持主体和语义不变，只返回改写后的提示词：\n${prompt}`
            }
          ]
        })
      });

      return response.choices?.[0]?.message?.content?.trim() || `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
    }

    const response = await requestJson<GeminiNativeResponse>("yunwu", `/v1beta/models/${encodeURIComponent(textModel)}:generateContent`, {
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

    return extractTextFromGeminiResponse(response) || `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  } catch (error) {
    console.warn(`[${providerConfig.label}] Prompt rewrite failed, fallback to local suffix injection.`, error);
    return `${prompt}, ${REALISTIC_PROMPT_SUFFIX}`;
  }
};

export const generateImage = async (
  prompt: string,
  aspectRatio: AspectRatio,
  imageSize: ImageSize,
  provider: ServiceProvider,
  referenceImages?: ReferenceImageItem[],
  imageModelOverride?: string,
  referencePrompt?: string
): Promise<string> => {
  const providerConfig = getProviderConfig(provider);
  const imageModel = imageModelOverride?.trim() || providerConfig.defaultImageModel;

  try {
    if (provider === "muzhi") {
      return await generateMuzhiImage(
        prompt,
        aspectRatio,
        imageSize,
        imageModel,
        referenceImages,
        referencePrompt
      );
    }

    if (provider === "apimart") {
      const taskId = await createOpenAICompatibleImageTask(
        provider,
        prompt,
        aspectRatio,
        imageSize,
        imageModel,
        referenceImages,
        referencePrompt
      );
      const imageUrl = await pollOpenAICompatibleImageTask(provider, taskId);
      return await fetchImageAsDataUrl(imageUrl);
    }

    const parts: Array<Record<string, unknown>> = [
      ...buildYunwuReferenceParts(referenceImages || [], referencePrompt || prompt),
      { text: prompt }
    ];

    const response = await requestJson<GeminiNativeResponse>("yunwu", `/v1beta/models/${encodeURIComponent(imageModel)}:generateContent`, {
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

    const imageDataUrl = extractImageFromGeminiResponse(response);
    if (imageDataUrl) {
      return imageDataUrl;
    }

    const textMessage = extractTextFromGeminiResponse(response);
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
      throw createError(`权限不足 (403)，请确认 ${providerConfig.label} Key 对应账户已开通目标模型。`);
    }

    if (status === 429 || message.includes("429")) {
      throw createError("API 频率达到上限 (429)，请降低并发并稍后再试。");
    }

    if (message.includes("无可用渠道")) {
      throw createError(`${providerConfig.label} 当前账号下模型 ${imageModel} 没有可用通道。请到后台检查该模型是否已开通，或改用供应商给你的可用模型名。`);
    }

    if ((provider === "apimart" || provider === "muzhi") && (message.includes("all channels failed") || message.includes("Multi-channel task failure"))) {
      throw createError(`${providerConfig.label} 的 ${imageModel} 当前多通道执行失败。请稍后重试，或检查该模型在服务商后台是否可用。原始反馈：${message}`);
    }

    throw serviceError;
  }
};
