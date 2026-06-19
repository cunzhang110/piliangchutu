
export enum TaskStatus {
  IDLE = 'IDLE',
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PAUSED = 'PAUSED'
}

export type AspectRatio = string;
export type ImageSize = "1K" | "2K" | "4K";
export type AntiAILevel = "off" | "low" | "medium" | "high";
export type ServiceProvider = "yunwu" | "apimart" | "muzhi";

export interface ReferenceImageItem {
  id: string;
  name: string;
  imageData: string;
}

export interface GenerationTask {
  id: string;
  prompt: string;
  referenceMentions?: string[];
  referenceImage?: string; // Base64 string
  referenceImages?: ReferenceImageItem[];
  status: TaskStatus;
  progress: number;
  resultUrl?: string;
  outputWidth?: number;
  outputHeight?: number;
  error?: string;
  statusMessage?: string;
  selected?: boolean; // For batch operations
  config: {
    aspectRatio: AspectRatio;
    imageSize: ImageSize;
  };
  createdAt: number;
}

export interface AppSettings {
  activeProvider: ServiceProvider;
  yunwuImageModel: string;
  yunwuTextModel: string;
  apimartImageModel: string;
  apimartTextModel: string;
  muzhiImageModel: string;
  muzhiTextModel: string;
  defaultAspectRatio: AspectRatio;
  defaultImageSize: ImageSize;
  globalReferenceImage?: string;
  referenceLibrary: ReferenceImageItem[];
  applyGlobalRefOnImport: boolean;
  concurrency: number;
  antiAILevel: AntiAILevel;
  forceRealisticPrompt: boolean;
}
