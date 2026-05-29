
import React, { useState, useEffect, useRef } from 'react';
import { GenerationTask, TaskStatus, AspectRatio, ImageSize, AppSettings, AntiAILevel, ReferenceImageItem, ServiceProvider } from './types';
import { TaskCard } from './components/TaskCard';
import { generateImage, getDefaultTextModel, getProviderLabel, hasConfiguredApiKey, preparePromptForImage } from './services/geminiService';
import { loadTasksFromDB, saveTasksToDB, loadSettingsFromDB, saveSettingsToDB } from './utils/db';
import { clearStoredApiKey, getStoredApiKey, saveStoredApiKey } from './utils/apiKeyStorage';
import { processAntiAI } from './utils/imageProcessor';
import { extractMentionNames, formatProtectedReferenceMention, formatReferenceMention, removeReferenceMention, replaceReferenceMention } from './utils/referenceMentions';
import { getAspectRatioValidationMessage, getSupportedYunwuAspectRatios, getSupportedYunwuImageSizes, getYunwuResolutionLabel, getYunwuResolutionSummary, normalizeAspectRatio, supportsYunwuImageSize } from './utils/yunwuImageCapabilities';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

const LEGACY_YUNWU_IMAGE_MODEL = 'gemini-3-pro-image-preview';
const DEFAULT_PROVIDER: ServiceProvider = 'yunwu';
const FIXED_PROVIDER_IMAGE_MODELS: Record<ServiceProvider, string> = {
  yunwu: 'gemini-3.1-flash-image-preview',
  apimart: 'gpt-image-2'
};
const MODEL_SLOGAN = '云雾用香蕉模型，APIMart 用 GPT-2 模型';

type ExternalImageJob = {
  id: string;
  name: string;
  source: string;
  processed?: string;
  mimeType: string;
  status: 'idle' | 'processing' | 'done' | 'failed';
  error?: string;
};

const createReferenceImageItem = (imageData: string, name: string): ReferenceImageItem => ({
  id: Math.random().toString(36).substr(2, 9),
  name,
  imageData
});

const normalizeReferenceName = (rawName: string, fallbackIndex: number) => {
  const trimmedName = rawName.trim();
  return trimmedName || `图${fallbackIndex + 1}`;
};

const splitReferenceName = (rawName: string) => {
  const trimmedName = rawName.trim();
  const matched = trimmedName.match(/^(.*?)(?:\s+|[-_（(])?(\d+)$/);
  if (!matched) {
    return { baseName: trimmedName, order: null as number | null };
  }

  return {
    baseName: matched[1].trim() || "图",
    order: Number(matched[2])
  };
};

const ensureUniqueReferenceName = (
  rawName: string,
  existingNames: string[],
  fallbackIndex: number,
  currentName?: string
) => {
  const normalizedBaseName = normalizeReferenceName(rawName, fallbackIndex);
  const occupiedNames = new Set(
    existingNames
      .map(name => name.trim())
      .filter(name => name && name !== currentName)
  );

  if (!occupiedNames.has(normalizedBaseName)) {
    return normalizedBaseName;
  }

  const { baseName, order } = splitReferenceName(normalizedBaseName);
  let nextOrder = order ?? 2;
  let candidate = `${baseName}${nextOrder}`;

  while (occupiedNames.has(candidate)) {
    nextOrder += 1;
    candidate = `${baseName}${nextOrder}`;
  }

  return candidate;
};

const getDefaultReferenceName = (fileName: string, fallbackIndex: number) => {
  const baseName = fileName.replace(/\.[^/.]+$/, '').trim();
  return normalizeReferenceName(baseName, fallbackIndex);
};

const normalizeReferenceLibrary = (rawLibrary: any[] | undefined) => {
  const occupiedNames: string[] = [];
  return (Array.isArray(rawLibrary) ? rawLibrary : [])
    .map((reference: any, index: number) => {
      const uniqueName = ensureUniqueReferenceName(reference?.name || '', occupiedNames, index);
      occupiedNames.push(uniqueName);

      return {
        id: reference?.id || Math.random().toString(36).substr(2, 9),
        name: uniqueName,
        imageData: reference?.imageData || reference?.referenceImage || ''
      };
    })
    .filter((reference: ReferenceImageItem) => Boolean(reference.imageData));
};

const mergeReferenceLibraries = (...libraries: Array<ReferenceImageItem[] | undefined>) => {
  const merged: ReferenceImageItem[] = [];
  const seenImages = new Set<string>();
  const occupiedNames: string[] = [];

  libraries.forEach(library => {
    (library || []).forEach((reference, index) => {
      if (!reference?.imageData || seenImages.has(reference.imageData)) return;
      const uniqueName = ensureUniqueReferenceName(reference.name || '', occupiedNames, merged.length + index);
      merged.push({
        id: reference.id || Math.random().toString(36).substr(2, 9),
        name: uniqueName,
        imageData: reference.imageData
      });
      occupiedNames.push(uniqueName);
      seenImages.add(reference.imageData);
    });
  });

  return merged;
};

const normalizeTask = (task: any): GenerationTask => {
  const existingReferenceImages = Array.isArray(task?.referenceImages)
    ? task.referenceImages.map((reference: any, index: number) => ({
        id: reference?.id || Math.random().toString(36).substr(2, 9),
        name: normalizeReferenceName(reference?.name || '', index),
        imageData: reference?.imageData || reference?.referenceImage || ''
      })).filter((reference: ReferenceImageItem) => Boolean(reference.imageData))
    : [];

  if (!existingReferenceImages.length && task?.referenceImage) {
    existingReferenceImages.push(createReferenceImageItem(task.referenceImage, '图1'));
  }

  const legacyMentions = Array.isArray(task?.referenceMentions)
    ? task.referenceMentions.map((name: string) => name.trim()).filter(Boolean)
    : [];
  const uniqueMentions = Array.from(new Set(legacyMentions));
  const promptText = (task?.prompt || '').trim();
  const promptHasMentions = extractMentionNames(promptText).length > 0;
  const rebuiltPrompt = uniqueMentions.length > 0 && !promptHasMentions
    ? `${uniqueMentions.map(formatReferenceMention).join(' ')}${promptText ? ` ${promptText}` : ''}`.trim()
    : promptText;

  return {
    ...task,
    prompt: rebuiltPrompt,
    referenceMentions: undefined,
    referenceImages: existingReferenceImages
  };
};

const normalizeLoadedSettings = (rawSettings: any): Partial<AppSettings> => {
  const defaultYunwuTextModel = getDefaultTextModel('yunwu');
  const defaultAPIMartTextModel = getDefaultTextModel('apimart');

  const rawYunwuTextModel = rawSettings?.yunwuTextModel || rawSettings?.providerTextModels?.yunwu || defaultYunwuTextModel;
  const rawAPIMartTextModel = rawSettings?.apimartTextModel || rawSettings?.providerTextModels?.apimart || defaultAPIMartTextModel;

  return {
    ...rawSettings,
    activeProvider: rawSettings?.activeProvider === 'apimart' ? 'apimart' : DEFAULT_PROVIDER,
    referenceLibrary: normalizeReferenceLibrary(rawSettings?.referenceLibrary),
    defaultAspectRatio: normalizeAspectRatio(rawSettings?.defaultAspectRatio || "1:1"),
    yunwuImageModel: FIXED_PROVIDER_IMAGE_MODELS.yunwu,
    yunwuTextModel: rawYunwuTextModel || defaultYunwuTextModel,
    apimartImageModel: FIXED_PROVIDER_IMAGE_MODELS.apimart,
    apimartTextModel: rawAPIMartTextModel || defaultAPIMartTextModel
  };
};

const App: React.FC = () => {
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [isApiKeySelected, setIsApiKeySelected] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  
  const [settings, setSettings] = useState<AppSettings>({
    activeProvider: DEFAULT_PROVIDER,
    yunwuImageModel: FIXED_PROVIDER_IMAGE_MODELS.yunwu,
    yunwuTextModel: getDefaultTextModel('yunwu'),
    apimartImageModel: FIXED_PROVIDER_IMAGE_MODELS.apimart,
    apimartTextModel: getDefaultTextModel('apimart'),
    defaultAspectRatio: "1:1",
    defaultImageSize: "1K",
    referenceLibrary: [],
    applyGlobalRefOnImport: true,
    concurrency: 1,
    antiAILevel: 'off',
    forceRealisticPrompt: false
  });

  useEffect(() => {
    const loadData = async () => {
      const savedTasks = await loadTasksFromDB();
      const normalizedTasks = savedTasks && savedTasks.length > 0
        ? savedTasks.map(normalizeTask)
        : [];

      if (normalizedTasks.length > 0) {
        setTasks(normalizedTasks);
      }

      const savedSettings = await loadSettingsFromDB();
      if (savedSettings) {
        const { id, ...rest } = savedSettings;
        const normalizedSettings = normalizeLoadedSettings(rest);
        const legacyLibrary = normalizedTasks.flatMap(task => task.referenceImages || []);
        const migratedGlobalImage = rest?.globalReferenceImage
          ? [createReferenceImageItem(rest.globalReferenceImage, '全局图1')]
          : [];
        setSettings(prev => ({
          ...prev,
          ...normalizedSettings,
          referenceLibrary: mergeReferenceLibraries(
            normalizedSettings.referenceLibrary,
            migratedGlobalImage,
            legacyLibrary
          )
        }));
      }
      setIsLoaded(true);
    };
    loadData();
  }, []);

  useEffect(() => {
    if (isLoaded) {
      saveTasksToDB(tasks);
    }
  }, [tasks, isLoaded]);

  useEffect(() => {
    if (isLoaded) {
      saveSettingsToDB(settings);
    }
  }, [settings, isLoaded]);

  const [showImportModal, setShowImportModal] = useState<boolean>(false);
  const [showApiKeyEditor, setShowApiKeyEditor] = useState<boolean>(false);
  const [showReferenceLibrary, setShowReferenceLibrary] = useState<boolean>(false);
  const [showExternalImageProcessor, setShowExternalImageProcessor] = useState<boolean>(false);
  const [showApiKeyValue, setShowApiKeyValue] = useState<boolean>(false);
  const [batchReferenceId, setBatchReferenceId] = useState<string>('');
  const [showBatchReferencePicker, setShowBatchReferencePicker] = useState<boolean>(false);
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [importText, setImportText] = useState<string>('');
  const [externalImageJobs, setExternalImageJobs] = useState<ExternalImageJob[]>([]);
  const [externalAntiAILevel, setExternalAntiAILevel] = useState<AntiAILevel>('medium');
  const [isExternalImageProcessing, setIsExternalImageProcessing] = useState<boolean>(false);
  const [batchDraftConfig, setBatchDraftConfig] = useState<{ aspectRatio: AspectRatio | ''; imageSize: ImageSize | '' }>({
    aspectRatio: '',
    imageSize: ''
  });
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);
  
  const csvInputRef = useRef<HTMLInputElement>(null);
  const globalRefInputRef = useRef<HTMLInputElement>(null);
  const externalImageInputRef = useRef<HTMLInputElement>(null);
  
  // 队列控制引用
  const stopRef = useRef(false);
  const pausedRef = useRef(false);
  const currentIndexRef = useRef(0);
  const globalCooldownUntilRef = useRef(0);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const showToast = (message: string, type: 'info' | 'error' | 'success' = 'info') => {
    setToast({ message, type });
  };

  useEffect(() => {
    setApiKeyInput(getStoredApiKey(DEFAULT_PROVIDER));
    setIsApiKeySelected(hasConfiguredApiKey(DEFAULT_PROVIDER));
  }, []);

  useEffect(() => {
    if (!batchReferenceId) return;
    const stillExists = settings.referenceLibrary.some(reference => reference.id === batchReferenceId);
    if (!stillExists) {
      setBatchReferenceId('');
    }
  }, [batchReferenceId, settings.referenceLibrary]);

  useEffect(() => {
    setApiKeyInput(getStoredApiKey(settings.activeProvider));
    setIsApiKeySelected(hasConfiguredApiKey(settings.activeProvider));
  }, [settings.activeProvider]);

  useEffect(() => {
    const activeImageModel = FIXED_PROVIDER_IMAGE_MODELS[settings.activeProvider];
    const supportedAspectRatios = getSupportedYunwuAspectRatios(activeImageModel);
    const supportedImageSizes = getSupportedYunwuImageSizes(activeImageModel);
    const normalizedDefaultAspectRatio = normalizeAspectRatio(settings.defaultAspectRatio);
    const isSupportedAspectRatio = supportedAspectRatios.includes(normalizedDefaultAspectRatio);

    if (!isSupportedAspectRatio || !supportedImageSizes.includes(settings.defaultImageSize)) {
      setSettings(prev => ({
        ...prev,
        defaultAspectRatio: supportedAspectRatios.includes(normalizeAspectRatio(prev.defaultAspectRatio))
          ? normalizeAspectRatio(prev.defaultAspectRatio)
          : supportedAspectRatios[0],
        defaultImageSize: supportedImageSizes.includes(prev.defaultImageSize) ? prev.defaultImageSize : supportedImageSizes[0]
      }));
    }
  }, [settings.activeProvider, settings.defaultAspectRatio, settings.defaultImageSize]);

  const handleRecheckApiKey = () => {
    const providerLabel = getProviderLabel(settings.activeProvider);
    const hasKey = hasConfiguredApiKey(settings.activeProvider);
    setIsApiKeySelected(hasKey);
    showToast(hasKey ? `已检测到 ${providerLabel} API Key` : `未检测到 ${providerLabel} API Key，请填写后保存`, hasKey ? "success" : "error");
  };

  const handleSaveApiKey = () => {
    const normalizedKey = apiKeyInput.trim();
    const providerLabel = getProviderLabel(settings.activeProvider);
    if (!normalizedKey) {
      showToast(`请输入 ${providerLabel} API Key`, "error");
      return;
    }

    saveStoredApiKey(settings.activeProvider, normalizedKey);
    setApiKeyInput(normalizedKey);
    setIsApiKeySelected(true);
    setShowApiKeyEditor(false);
    showToast(`${providerLabel} API Key 已保存到本地`, "success");
  };

  const handleClearApiKey = () => {
    const providerLabel = getProviderLabel(settings.activeProvider);
    clearStoredApiKey(settings.activeProvider);
    setApiKeyInput('');
    setIsApiKeySelected(hasConfiguredApiKey(settings.activeProvider));
    setShowApiKeyEditor(false);
    setShowApiKeyValue(false);
    showToast(`已清除本地保存的 ${providerLabel} API Key`, "success");
  };

  const processImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          const MAX_SIZE = 1024; // 进一步压缩参考图，减小 Request Payload 降低 500 风险
          if (width > height) {
            if (width > MAX_SIZE) {
              height *= MAX_SIZE / width;
              width = MAX_SIZE;
            }
          } else {
            if (height > MAX_SIZE) {
              width *= MAX_SIZE / height;
              height = MAX_SIZE;
            }
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
    });
  };

  const readOriginalImage = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = event => resolve(String(event.target?.result || ''));
      reader.onerror = () => reject(new Error('外部图片读取失败'));
      reader.readAsDataURL(file);
    });
  };

  const getImageDimensions = (imageDataUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => reject(new Error('输出尺寸读取失败'));
      img.src = imageDataUrl;
    });
  };

  const handleGlobalRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []) as File[];
    if (files.length === 0) return;
    try {
      const processedReferences = await Promise.all(
        files.map(async (file, index) => ({
          imageData: await processImage(file),
          name: getDefaultReferenceName(file.name, index)
        }))
      );

      setSettings(prev => {
        const existingLibrary = prev.referenceLibrary || [];
        const occupiedNames = existingLibrary.map(reference => reference.name);
        const nextReferences = processedReferences.map((reference, index) => {
          const uniqueName = ensureUniqueReferenceName(reference.name, occupiedNames, existingLibrary.length + index);
          occupiedNames.push(uniqueName);
          return createReferenceImageItem(reference.imageData, uniqueName);
        });
        const nextLibrary = [
          ...existingLibrary,
          ...nextReferences
        ];

        return {
          ...prev,
          referenceLibrary: mergeReferenceLibraries(nextLibrary),
          globalReferenceImage: nextLibrary[0]?.imageData
        };
      });
      showToast(`已加入参考图库 ${files.length} 张图`, "success");
    } catch (err) {
      showToast("参考图处理失败", "error");
    } finally { e.target.value = ''; }
  };

  const handleExternalImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.currentTarget.files || []) as File[];
    if (files.length === 0) return;

    try {
      const nextJobs = await Promise.all(
        files.map(async (file) => ({
          id: Math.random().toString(36).substr(2, 9),
          name: file.name.replace(/\.[^/.]+$/, ''),
          source: await readOriginalImage(file),
          mimeType: file.type || 'image/jpeg',
          status: 'idle' as const
        }))
      );

      setExternalImageJobs(prev => [...prev, ...nextJobs]);
      setShowExternalImageProcessor(true);
      showToast(`已载入 ${nextJobs.length} 张外部图片，可以批量处理`, 'success');
    } catch {
      showToast('外部图片读取失败', 'error');
    } finally {
      e.target.value = '';
    }
  };

  const handleProcessExternalImages = async () => {
    if (externalImageJobs.length === 0) {
      showToast('请先上传图片', 'error');
      return;
    }

    setIsExternalImageProcessing(true);
    try {
      for (const job of externalImageJobs) {
        setExternalImageJobs(prev => prev.map(item => (
          item.id === job.id
            ? { ...item, status: 'processing', error: undefined }
            : item
        )));

        try {
          const processedImage = await processAntiAI(job.source, externalAntiAILevel);
          const nextMimeType = (processedImage.match(/^data:([^;]+);base64,/) || [])[1] || 'image/jpeg';
          setExternalImageJobs(prev => prev.map(item => (
            item.id === job.id
              ? { ...item, processed: processedImage, mimeType: nextMimeType, status: 'done' }
              : item
          )));
        } catch {
          setExternalImageJobs(prev => prev.map(item => (
            item.id === job.id
              ? { ...item, status: 'failed', error: '处理失败，请重试' }
              : item
          )));
        }
      }

      showToast('批量处理完成，可以一键打包下载', 'success');
    } finally {
      setIsExternalImageProcessing(false);
    }
  };

  const handleDownloadExternalImages = async () => {
    const completedJobs = externalImageJobs.filter(job => job.processed);
    if (completedJobs.length === 0) {
      showToast('当前没有已处理完成的图片可下载', 'error');
      return;
    }

    const zip = new JSZip();
    completedJobs.forEach(job => {
      const mimeType = (job.processed!.match(/^data:([^;]+);base64,/) || [])[1] || job.mimeType;
      const extension = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
      zip.file(`${job.name}-${externalAntiAILevel}.${extension}`, job.processed!.split(',')[1], { base64: true });
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `anti-ai-batch-${Date.now()}.zip`;
    link.click();
    showToast(`已打包导出 ${completedJobs.length} 张处理后的图片`, 'success');
  };

  const handleRemoveExternalImage = (jobId: string) => {
    setExternalImageJobs(prev => prev.filter(job => job.id !== jobId));
  };

  const handleClearExternalImages = () => {
    setExternalImageJobs([]);
  };

  const handleReferenceLibraryRename = (referenceId: string, nextName: string) => {
    const targetReference = settings.referenceLibrary.find(reference => reference.id === referenceId);
    if (!targetReference) return;

    const normalizedName = ensureUniqueReferenceName(
      nextName,
      settings.referenceLibrary.map(reference => reference.name),
      settings.referenceLibrary.findIndex(reference => reference.id === referenceId),
      targetReference.name
    );

    setSettings(prev => ({
      ...prev,
      referenceLibrary: (prev.referenceLibrary || []).map(reference => (
        reference.id === referenceId
          ? { ...reference, name: normalizedName }
          : reference
      ))
    }));

    if (normalizedName !== targetReference.name) {
      setTasks(prev => prev.map(task => ({
        ...task,
        prompt: replaceReferenceMention(task.prompt, targetReference.name, normalizedName)
      })));
    }
  };

  const handleReferenceLibraryRemove = (referenceId: string) => {
    setSettings(prev => {
      const nextLibrary = (prev.referenceLibrary || []).filter(reference => reference.id !== referenceId);
      return {
        ...prev,
        referenceLibrary: nextLibrary,
        globalReferenceImage: nextLibrary[0]?.imageData
      };
    });
  };

  const handleInsertReferenceMention = (taskId: string, referenceName: string) => {
    setTasks(prev => prev.map(task => {
      if (task.id !== taskId) return task;
      const mention = formatProtectedReferenceMention(referenceName);
      const hasMention = extractMentionNames(task.prompt).includes(referenceName);
      const prefixSpacer = task.prompt.trim() ? ' ' : '';
      const suffixSpacer = task.prompt.endsWith(' ') || task.prompt.length === 0 ? '' : ' ';
      return {
        ...task,
        prompt: hasMention ? task.prompt : `${task.prompt}${prefixSpacer}${mention}${suffixSpacer}`
      };
    }));
  };

  const handleBatchReferenceToggle = (reference: ReferenceImageItem) => {
    const selectedTaskCount = tasks.filter(task => task.selected).length;
    if (selectedTaskCount === 0) {
      showToast("请先选择要批量修改的任务", "error");
      return;
    }

    const selectedMention = formatProtectedReferenceMention(reference.name);
    const shouldRemove = batchReferenceId === reference.id;

    setTasks(prev => prev.map(task => {
      if (!task.selected) return task;

      if (shouldRemove) {
        return { ...task, prompt: removeReferenceMention(task.prompt, reference.name) };
      }

      const currentReferenceNames = extractMentionNames(task.prompt);
      if (currentReferenceNames.includes(reference.name)) {
        return task;
      }

      const nextPrompt = `${task.prompt.trim()}${task.prompt.trim() ? ' ' : ''}${selectedMention}`.trim();
      return { ...task, prompt: nextPrompt };
    }));

    setBatchReferenceId(shouldRemove ? '' : reference.id);
    showToast(shouldRemove ? `已从已选任务移除 ${selectedMention}` : `已把 ${selectedMention} 加入 ${selectedTaskCount} 个任务`, "success");
  };

  const handleBatchReferenceClear = () => {
    const selectedTaskCount = tasks.filter(task => task.selected).length;
    if (selectedTaskCount === 0) {
      showToast("请先选择要清除参考图的任务", "error");
      return;
    }

    setTasks(prev => prev.map(task => {
      if (!task.selected) return task;

      const nextPrompt = settings.referenceLibrary.reduce(
        (prompt, reference) => removeReferenceMention(prompt, reference.name),
        task.prompt
      );

      return { ...task, prompt: nextPrompt };
    }));
    setBatchReferenceId('');
    showToast(`已清除 ${selectedTaskCount} 个任务里的参考图标记`, "success");
  };

  const addTask = (prompt: string = '') => {
    const newTask: GenerationTask = {
      id: Math.random().toString(36).substr(2, 9),
      prompt,
      status: TaskStatus.IDLE,
      statusMessage: '等待开始',
      progress: 0,
      config: {
        aspectRatio: settings.defaultAspectRatio,
        imageSize: settings.defaultImageSize
      },
      createdAt: Date.now()
    };
    setTasks(prev => [newTask, ...prev]);
  };

  const applyBatchConfig = () => {
    const selectedTaskCount = tasks.filter(task => task.selected).length;
    if (selectedTaskCount === 0) {
      showToast('请先选择要批量修改的任务', 'error');
      return;
    }

    const configPatch: Partial<GenerationTask['config']> = {};
    if (batchDraftConfig.aspectRatio) {
      configPatch.aspectRatio = batchDraftConfig.aspectRatio;
    }
    if (batchDraftConfig.imageSize) {
      configPatch.imageSize = batchDraftConfig.imageSize;
    }

    if (Object.keys(configPatch).length === 0) {
      showToast('请先选择要应用的比例或分辨率', 'error');
      return;
    }

    setTasks(prev => prev.map(task => (
      task.selected
        ? { ...task, config: { ...task.config, ...configPatch } }
        : task
    )));
    setBatchDraftConfig({ aspectRatio: '', imageSize: '' });
    showToast(`已把设置应用到 ${selectedTaskCount} 个任务`, 'success');
  };

  const handleBatchDelete = () => {
    const deletedCount = tasks.filter(task => task.selected).length;
    setTasks(prev => prev.filter(task => !task.selected));
    setShowBatchDeleteConfirm(false);
    showToast(`已删除 ${deletedCount} 个任务`, 'success');
  };

  const handleBatchImport = () => {
    const lines = importText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const newTasks = lines.map(prompt => ({
      id: Math.random().toString(36).substr(2, 9),
      prompt,
      status: TaskStatus.IDLE,
      statusMessage: '等待开始',
      progress: 0,
      config: {
        aspectRatio: settings.defaultAspectRatio,
        imageSize: settings.defaultImageSize
      },
      createdAt: Date.now()
    }));
    setTasks(prev => [...newTasks, ...prev]);
    setShowImportModal(false);
    setImportText('');
  };

  const handleFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const extension = file.name.split('.').pop()?.toLowerCase();
      if (extension === 'xlsx' || extension === 'xls') {
        const workbook = XLSX.read(buffer, { type: 'array' });
        const jsonData = XLSX.utils.sheet_to_json<any[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
        setImportText(jsonData.map(row => String(row[0] || '').trim()).filter(p => p).join('\n'));
      } else {
        setImportText(new TextDecoder('utf-8').decode(buffer));
      }
      setShowImportModal(true);
    } catch (err) {
      showToast("读取失败", "error");
    } finally { e.target.value = ''; }
  };

  const updateTaskState = (taskId: string, updater: (task: GenerationTask) => GenerationTask) => {
    setTasks(prev => prev.map(task => (task.id === taskId ? updater(task) : task)));
  };

  const runSingleTask = async (task: GenerationTask) => {
    if (stopRef.current || pausedRef.current) return;
    const providerLabel = getProviderLabel(settings.activeProvider);
    if (!task.prompt.trim()) {
      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.FAILED,
        statusMessage: '缺少提示词',
        error: '请先输入提示词，或在批量参考图里选择参考图后再开始。'
      }));
      showToast('请先输入提示词，或选择参考图后再开始', 'error');
      return;
    }

    const aspectRatioValidationMessage = getAspectRatioValidationMessage(task.config.aspectRatio);
    if (aspectRatioValidationMessage) {
      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.FAILED,
        statusMessage: '比例设置不支持',
        error: aspectRatioValidationMessage
      }));
      return;
    }
    
    // 如果处于全局冷却中（刚报过 429），先等待
    const cooldownRemainingMs = globalCooldownUntilRef.current - Date.now();
    if (cooldownRemainingMs > 0) {
      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.PENDING,
        statusMessage: `${providerLabel} 限流冷却中，约 ${Math.ceil(cooldownRemainingMs / 1000)} 秒后继续`
      }));
      await new Promise(r => setTimeout(r, cooldownRemainingMs));
    }

    updateTaskState(task.id, currentTask => ({
      ...currentTask,
      status: TaskStatus.PROCESSING,
      statusMessage: settings.forceRealisticPrompt ? '正在改写提示词' : '正在准备生图请求',
      error: undefined,
      outputWidth: undefined,
      outputHeight: undefined
    }));
    
    try {
      const finalPrompt = await preparePromptForImage(
        task.prompt,
        settings.forceRealisticPrompt,
        settings.activeProvider,
        settings.activeProvider === 'apimart' ? settings.apimartTextModel : settings.yunwuTextModel
      );

      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.PROCESSING,
        statusMessage: `正在向 ${providerLabel} 提交生图请求`
      }));

      const rawResultUrl = await generateImage(
        finalPrompt,
        task.config.aspectRatio,
        task.config.imageSize,
        settings.activeProvider,
        settings.referenceLibrary,
        FIXED_PROVIDER_IMAGE_MODELS[settings.activeProvider],
        task.prompt
      );
      
      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.PROCESSING,
        statusMessage: settings.antiAILevel === 'off' ? '正在读取输出尺寸' : '正在进行后处理'
      }));

      const resultUrl = await processAntiAI(rawResultUrl, settings.antiAILevel);

      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.PROCESSING,
        statusMessage: '正在读取输出尺寸'
      }));

      const outputDimensions = await getImageDimensions(resultUrl);

      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.COMPLETED,
        statusMessage: '生成完成',
        resultUrl,
        outputWidth: outputDimensions.width,
        outputHeight: outputDimensions.height
      }));
    } catch (err: any) {
      let errorMsg = err.message || "未知故障";
      if (errorMsg === 'API_KEY_EXPIRED' || errorMsg === 'API_KEY_MISSING') {
        setIsApiKeySelected(false);
        stopRef.current = true; // 停止队列
        showToast(errorMsg === 'API_KEY_MISSING' ? `未检测到 ${providerLabel} API Key，请先填写并保存` : `${providerLabel} API Key 无效或无权限访问该模型，请重新配置`, "error");
      }
      
      const finalErrorMessage =
        errorMsg === 'API_KEY_EXPIRED'
          ? `${providerLabel} API Key 无效或无权限`
          : errorMsg === 'API_KEY_MISSING'
            ? `未配置 ${providerLabel} API Key`
            : errorMsg;

      updateTaskState(task.id, currentTask => ({
        ...currentTask,
        status: TaskStatus.FAILED,
        statusMessage: errorMsg.includes('429') ? `${providerLabel} 限流，请稍后重试` : '生成失败',
        error: finalErrorMessage
      }));
      
      // 如果报错 429，触发全局冷却，让后续任务慢一点
      if (errorMsg.includes('429')) {
        globalCooldownUntilRef.current = Date.now() + 30000;
        showToast("已触发限流冷却，系统会在 30 秒后再继续尝试后续任务", "info");
      }
    }
  };

  const runQueue = async (taskList: GenerationTask[]) => {
    if (taskList.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setIsPaused(false);
    pausedRef.current = false;
    stopRef.current = false;
    currentIndexRef.current = 0;

    const taskIds = new Set(taskList.map(task => task.id));
    setTasks(prev => prev.map(task => (
      taskIds.has(task.id)
        ? { ...task, status: TaskStatus.PENDING, statusMessage: '排队等待中', error: undefined }
        : task
    )));
    
    const maxConcurrency = Math.min(settings.concurrency, taskList.length);

    const worker = async () => {
      while (currentIndexRef.current < taskList.length && !stopRef.current && !pausedRef.current) {
        const index = currentIndexRef.current++;
        const task = taskList[index];
        if (task) await runSingleTask(task);
      }
    };

    const pool = Array.from({ length: maxConcurrency }).map(() => worker());
    await Promise.all(pool);
    
    setIsProcessing(false);
    if (!stopRef.current && !pausedRef.current) showToast("全部任务已处理完毕", "success");
  };

  const runAllPending = () => {
    const pending = tasks.filter(t => [TaskStatus.IDLE, TaskStatus.FAILED, TaskStatus.PAUSED].includes(t.status));
    if (pending.length > 0) runQueue(pending);
  };

  const runSelected = () => {
    const selected = tasks.filter(t => t.selected && [TaskStatus.IDLE, TaskStatus.FAILED, TaskStatus.PAUSED].includes(t.status));
    if (selected.length > 0) runQueue(selected);
  };

  const handleStop = () => {
    stopRef.current = true;
    setIsProcessing(false);
    setTasks(prev => prev.map(task => (
      task.status === TaskStatus.PROCESSING || task.status === TaskStatus.PENDING
        ? { ...task, status: TaskStatus.PAUSED, statusMessage: '已手动停止，可重新开始' }
        : task
    )));
  };

  const handleBulkExport = async () => {
    const completed = tasks.filter(t => t.status === TaskStatus.COMPLETED && t.resultUrl);
    if (completed.length === 0) return;
    showToast("正在导出...", "info");
    const zip = new JSZip();
    completed.forEach(t => zip.file(`img-${t.id}.png`, t.resultUrl!.split(',')[1], { base64: true }));
    const content = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `gemini-pro-images-${Date.now()}.zip`;
    link.click();
    showToast("导出成功", "success");
  };

  const selectedCount = tasks.filter(t => t.selected).length;
  const providerLabel = getProviderLabel(settings.activeProvider);
  const activeImageModel = FIXED_PROVIDER_IMAGE_MODELS[settings.activeProvider];
  const activeTextModel = settings.activeProvider === 'apimart'
    ? (settings.apimartTextModel || getDefaultTextModel('apimart'))
    : (settings.yunwuTextModel || getDefaultTextModel('yunwu'));
  const selectedBatchReference = settings.referenceLibrary.find(reference => reference.id === batchReferenceId);
  const supportedAspectRatios = getSupportedYunwuAspectRatios(activeImageModel);
  const supportedImageSizes = getSupportedYunwuImageSizes(activeImageModel);
  const supportsExplicitImageSize = supportsYunwuImageSize(activeImageModel);
  const defaultResolutionSummary = getYunwuResolutionSummary(activeImageModel, settings.defaultAspectRatio, settings.defaultImageSize);
  const currentDefaultAspectRatio = normalizeAspectRatio(settings.defaultAspectRatio);

  const applyDefaultAspectRatio = (aspectRatio: string) => {
    const normalizedRatio = normalizeAspectRatio(aspectRatio);
    const validationMessage = getAspectRatioValidationMessage(normalizedRatio);
    if (validationMessage) {
      showToast(validationMessage, "error");
      return;
    }

    setSettings(prev => ({
      ...prev,
      defaultAspectRatio: normalizedRatio
    }));
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      {!isApiKeySelected && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white p-10 rounded-3xl shadow-2xl text-center border border-slate-100">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-8 text-blue-600 text-3xl shadow-inner">
              <i className="fa-solid fa-wand-sparkles"></i>
            </div>
            <h1 className="text-2xl font-black text-slate-800 mb-4 tracking-tight">批量生图大师 Pro</h1>
            <p className="text-slate-500 text-sm mb-4 leading-relaxed">当前可切换 <b>云雾API</b> 和 <b>APIMart</b>。在这里填写当前服务商的 API Key 后会自动保存在当前浏览器。</p>
            <div className="flex justify-center gap-2 mb-5">
              {([
                { value: 'yunwu', label: '云雾API' },
                { value: 'apimart', label: 'APIMart' }
              ] as Array<{ value: ServiceProvider; label: string }>).map(provider => (
                <button
                  key={provider.value}
                  onClick={() => setSettings(prev => ({ ...prev, activeProvider: provider.value }))}
                  className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                    settings.activeProvider === provider.value
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {provider.label}
                </button>
              ))}
            </div>
            <div className="text-left mb-5">
              <label className="block text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">{providerLabel} API Key</label>
              <div className="flex gap-2">
                <input
                  type={showApiKeyValue ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={`请输入 ${providerLabel} 的 API Key`}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-medium outline-none focus:border-blue-400"
                />
                <button onClick={() => setShowApiKeyValue(v => !v)} className="px-4 rounded-2xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50">
                  {showApiKeyValue ? '隐藏' : '显示'}
                </button>
              </div>
            </div>
            <div className="text-left mb-4 rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3">
              <div className="text-[10px] font-black uppercase tracking-widest text-blue-500">固定生图模型</div>
              <div className="mt-1 text-sm font-black text-slate-800">{MODEL_SLOGAN}</div>
              <div className="mt-2 text-[11px] font-bold text-blue-700">{providerLabel}: <code>{activeImageModel}</code></div>
            </div>
            <div className="text-left mb-5">
              <label className="block text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">文本模型</label>
              <input
                value={activeTextModel}
                onChange={(e) => setSettings(prev => ({
                  ...prev,
                  [settings.activeProvider === 'apimart' ? 'apimartTextModel' : 'yunwuTextModel']: e.target.value
                }))}
                placeholder={settings.activeProvider === 'apimart' ? '例如 gemini-2.5-pro' : '例如 gemini-3-pro-preview'}
                className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-medium outline-none focus:border-blue-400"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={handleSaveApiKey} className="flex-1 bg-blue-600 text-white py-4 rounded-2xl font-black shadow-lg shadow-blue-500/20 hover:bg-blue-700 transition-all active:scale-95">保存并使用</button>
              <button onClick={handleRecheckApiKey} className="px-5 bg-slate-100 text-slate-600 py-4 rounded-2xl font-black hover:bg-slate-200 transition-all">检测</button>
            </div>
            {tasks.length > 0 && (
              <button onClick={() => setIsApiKeySelected(true)} className="mt-4 w-full py-3 text-slate-500 font-bold hover:bg-slate-50 rounded-xl transition-all">
                暂不连接，返回查看任务列表
              </button>
            )}
          </div>
        </div>
      )}

      <input type="file" ref={csvInputRef} accept=".txt,.csv,.xlsx,.xls" className="hidden" onChange={handleFileImport} />
      <input type="file" ref={globalRefInputRef} accept="image/*" multiple className="hidden" onChange={handleGlobalRefUpload} />
      <input type="file" ref={externalImageInputRef} accept="image/*" multiple className="hidden" onChange={handleExternalImageUpload} />

      {/* Toast */}
      {toast && (
        <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] animate-in fade-in slide-in-from-top-4">
          <div className={`px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 font-bold text-xs border backdrop-blur-xl ${
            toast.type === 'error' ? 'bg-red-500 text-white border-red-400' : toast.type === 'success' ? 'bg-green-500 text-white border-green-400' : 'bg-slate-900 text-white border-slate-800'
          }`}>
            <i className={`fa-solid ${toast.type === 'error' ? 'fa-triangle-exclamation' : toast.type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}`}></i>
            {toast.message}
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white/80 border-b border-slate-200 px-8 py-5 sticky top-0 z-40 flex items-center justify-between shadow-sm backdrop-blur-xl">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 bg-gradient-to-tr from-blue-600 to-indigo-600 rounded-2xl flex items-center justify-center text-white text-xl shadow-lg">
            <i className="fa-solid fa-palette"></i>
          </div>
          <h1 className="text-xl font-black tracking-tight">生图大师 <span className="text-blue-600 text-[10px] bg-blue-50 px-2 py-0.5 rounded-full ml-2 border border-blue-100 font-bold">V3.0</span></h1>
          <div className="hidden xl:flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-black text-amber-800">
            <i className="fa-solid fa-bolt text-amber-500"></i>
            {MODEL_SLOGAN}
          </div>
          <button onClick={() => setShowReferenceLibrary(true)} className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-xl text-[11px] font-black flex items-center gap-2 hover:bg-slate-50">
            <i className="fa-solid fa-images text-blue-600"></i> 参考图库
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">{settings.referenceLibrary.length}</span>
          </button>
        </div>
        <div className="flex gap-2">
          <div className="flex rounded-xl border border-slate-200 bg-white p-1">
            {([
              { value: 'yunwu', label: '云雾' },
              { value: 'apimart', label: 'APIMart' }
            ] as Array<{ value: ServiceProvider; label: string }>).map(provider => (
              <button
                key={provider.value}
                onClick={() => setSettings(prev => ({ ...prev, activeProvider: provider.value }))}
                className={`px-3 py-1.5 rounded-lg text-[11px] font-black transition-all ${
                  settings.activeProvider === provider.value
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                {provider.label}
              </button>
            ))}
          </div>
          <button onClick={() => setShowApiKeyEditor(true)} className="bg-white border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:bg-slate-50">
            <i className="fa-solid fa-key"></i> {providerLabel} Key
          </button>
          {isProcessing ? (
            <button onClick={handleStop} className="bg-red-600 text-white px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:opacity-90 shadow-lg shadow-red-500/20">
              <i className="fa-solid fa-stop-circle"></i> 紧急停止队列
            </button>
          ) : (
            <div className="flex gap-2">
              <button onClick={handleBulkExport} className="bg-slate-100 text-slate-700 px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:bg-slate-200">
                <i className="fa-solid fa-download"></i> 导出成功图
              </button>
              <button onClick={runAllPending} className="bg-blue-600 text-white px-6 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 shadow-xl shadow-blue-500/20 hover:bg-blue-700 active:scale-95">
                <i className="fa-solid fa-play"></i> 开始未生成
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Control Panel */}
      <div className="p-4 md:px-8 border-b border-slate-200 bg-white grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
        <div className="md:col-span-3 flex flex-col gap-1.5 group">
           <div className="flex justify-between items-center">
             <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">并发限制: {settings.concurrency}</span>
             {settings.concurrency > 1 && <i className="fa-solid fa-triangle-exclamation text-[8px] text-amber-500 animate-pulse"></i>}
           </div>
           <input type="range" min="1" max="5" value={settings.concurrency} onChange={(e) => setSettings(s => ({ ...s, concurrency: parseInt(e.target.value) }))} className="accent-blue-600 h-1.5" />
           <span className="text-[7px] font-bold text-slate-400 opacity-60 group-hover:opacity-100 transition-opacity">频繁 429 请调至 1-2</span>
        </div>

        <div className="md:col-span-2 flex flex-col gap-2">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">默认比例</span>
          <select value={supportedAspectRatios.includes(currentDefaultAspectRatio) ? currentDefaultAspectRatio : supportedAspectRatios[0]} onChange={(e) => {
            applyDefaultAspectRatio(e.target.value);
          }} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-black outline-none focus:border-blue-400">
            {supportedAspectRatios.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <span className="text-[8px] font-bold text-slate-400">当前默认比例：{currentDefaultAspectRatio}</span>
          <span className="text-[8px] font-bold text-slate-400">{providerLabel} 支持：{supportedAspectRatios.join(' / ')}</span>
        </div>

        <div className="md:col-span-3 flex flex-col gap-1.5">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">
            {supportsExplicitImageSize ? '云雾分辨率' : '云雾原生分辨率'}
          </span>
          <div className={`grid gap-2 ${supportsExplicitImageSize ? 'grid-cols-3' : 'grid-cols-1'}`}>
            {supportedImageSizes.map(sz => {
              const resolutionLabel = getYunwuResolutionLabel(activeImageModel, settings.defaultAspectRatio, sz);
              return (
                <button
                  key={sz}
                  onClick={() => setSettings(s => ({ ...s, defaultImageSize: sz as ImageSize }))}
                  className={`rounded-xl border px-2 py-2 text-left transition-all ${
                    settings.defaultImageSize === sz
                      ? 'border-blue-200 bg-blue-50 text-blue-700 shadow-sm'
                      : 'border-slate-200 bg-slate-50 text-slate-500 hover:border-blue-200 hover:bg-blue-50/60'
                  }`}
                >
                  <div className="text-[11px] font-black">{supportsExplicitImageSize ? sz : '原生'}</div>
                  <div className="mt-1 text-[9px] font-bold">{resolutionLabel || '以实际输出尺寸为准'}</div>
                </button>
              );
            })}
          </div>
          <span className="text-[9px] font-bold text-slate-500">{defaultResolutionSummary}</span>
        </div>

      </div>

      {/* Anti-AI Settings Panel */}
      <div className="p-4 md:px-8 border-b border-slate-200 bg-slate-50/50 flex flex-wrap gap-6 items-center">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">
            <i className="fa-solid fa-shield-halved"></i>
          </div>
          <span className="text-xs font-black text-slate-700">去 AI 标识设置</span>
        </div>

        <button
          onClick={() => {
            setExternalAntiAILevel(settings.antiAILevel);
            setShowExternalImageProcessor(true);
          }}
          className="bg-white border border-slate-200 px-4 py-2 rounded-xl text-[11px] font-black text-slate-700 flex items-center gap-2 hover:bg-slate-50 transition-all shadow-sm"
        >
          <i className="fa-solid fa-image text-blue-600"></i> 单独处理图片
        </button>
        
        <div className="flex items-center gap-4 bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm">
          <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">后处理强度</span>
          <div className="flex bg-slate-100 p-1 rounded-lg">
            {[
              { label: '关闭', value: 'off' },
              { label: '轻度', value: 'low' },
              { label: '中度', value: 'medium' },
              { label: '重度', value: 'high' }
            ].map(lvl => (
              <button 
                key={lvl.value} 
                onClick={() => setSettings(s => ({ ...s, antiAILevel: lvl.value as AntiAILevel }))} 
                className={`px-3 py-1 rounded text-[10px] font-black transition-all ${settings.antiAILevel === lvl.value ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                {lvl.label}
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 bg-white px-4 py-2 rounded-xl border border-slate-200 shadow-sm cursor-pointer hover:bg-slate-50 transition-all">
          <input 
            type="checkbox" 
            checked={settings.forceRealisticPrompt} 
            onChange={(e) => setSettings(s => ({ ...s, forceRealisticPrompt: e.target.checked }))} 
            className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500" 
          />
          <span className="text-xs font-bold text-slate-700">强制写实画风 (Gemini 3 提示词增强)</span>
        </label>
      </div>

      <main className="flex-1 p-6 md:p-10 overflow-y-auto no-scrollbar pb-40">
        {tasks.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center py-40">
            <div className="w-24 h-24 bg-white border-2 border-dashed border-slate-200 rounded-3xl flex items-center justify-center mb-6 shadow-sm animate-pulse">
              <i className="fa-solid fa-image-landscape text-4xl text-slate-200"></i>
            </div>
            <p className="text-sm font-black text-slate-300 uppercase tracking-widest">请导入提示词文件或手动添加任务</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <button onClick={() => addTask()} className="rounded-xl bg-blue-600 px-5 py-3 text-xs font-black text-white shadow-lg shadow-blue-500/20 hover:bg-blue-700 active:scale-95">
                <i className="fa-solid fa-plus-circle mr-2"></i>新增空任务
              </button>
              <button onClick={() => csvInputRef.current?.click()} className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-xs font-black text-slate-700 hover:bg-slate-50">
                <i className="fa-solid fa-file-excel text-green-600 mr-2"></i>导入文件
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={`sticky top-0 z-30 mb-6 rounded-2xl border shadow-sm backdrop-blur transition-all ${
              selectedCount > 0
                ? 'border-blue-300 bg-blue-50/95 shadow-blue-500/10 ring-1 ring-blue-200'
                : 'border-slate-200/70 bg-white/90'
            }`}>
              <div className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button onClick={() => addTask()} className="rounded-xl bg-blue-600 px-4 py-2 text-[11px] font-black text-white shadow-lg shadow-blue-500/15 hover:bg-blue-700 active:scale-95">
                    <i className="fa-solid fa-plus-circle mr-2"></i>新增空任务
                  </button>
                  <button onClick={() => csvInputRef.current?.click()} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[11px] font-black text-slate-700 hover:bg-slate-50">
                    <i className="fa-solid fa-file-excel text-green-600 mr-2"></i>导入文件
                  </button>
                  <div className="mx-2 hidden h-5 w-px bg-slate-200 sm:block"></div>
                  <button onClick={() => setTasks(prev => prev.map(t => ({ ...t, selected: true })))} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[10px] font-black text-blue-600 transition-all hover:bg-blue-50">全选</button>
                  <button
                    onClick={() => {
                      setTasks(prev => prev.map(t => ({ ...t, selected: false })));
                      setBatchReferenceId('');
                      setShowBatchReferencePicker(false);
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-[10px] font-black text-slate-500 hover:bg-slate-50"
                  >
                    清空选择
                  </button>
                  <button onClick={() => setTasks(prev => prev.map(t => t.status === TaskStatus.FAILED ? { ...t, selected: true } : t))} className="rounded-xl bg-red-50 px-4 py-2 text-[10px] font-black text-red-700 transition-all hover:bg-red-100">选中失败项</button>
                </div>
                <div className="flex items-center gap-3 pr-2">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">任务总数: <span className="text-slate-800">{tasks.length}</span></span>
                  <span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase tracking-widest transition-all ${
                    selectedCount > 0
                      ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                      : 'bg-slate-100 text-slate-400'
                  }`}>
                    批量编辑: {selectedCount}
                  </span>
                </div>
              </div>

              {selectedCount > 0 && (
                <div className="border-t border-blue-200 bg-blue-100/70 px-3 py-3">
                  <div className="flex flex-wrap items-end gap-4">
                    <div className="flex min-w-[220px] flex-col gap-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">批量比例</span>
                      <select
                        value={batchDraftConfig.aspectRatio}
                        onChange={(e) => setBatchDraftConfig(prev => ({ ...prev, aspectRatio: e.target.value as AspectRatio }))}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 outline-none focus:border-blue-400"
                      >
                        <option value="">不修改比例</option>
                        {supportedAspectRatios.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div className="flex min-w-[220px] flex-col gap-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">批量分辨率</span>
                      <select
                        value={batchDraftConfig.imageSize}
                        onChange={(e) => setBatchDraftConfig(prev => ({ ...prev, imageSize: e.target.value as ImageSize }))}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 outline-none focus:border-blue-400"
                      >
                        <option value="">不修改分辨率</option>
                        {supportedImageSizes.map(sz => (
                          <option key={sz} value={sz}>
                            {supportsExplicitImageSize ? sz : '原生'} · {getYunwuResolutionLabel(activeImageModel, settings.defaultAspectRatio, sz) || '以实际输出尺寸为准'}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      onClick={applyBatchConfig}
                      className="rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-black text-white shadow-lg shadow-blue-500/15 hover:bg-blue-700 active:scale-95"
                    >
                      应用到已选 {selectedCount} 个任务
                    </button>

                    <div className="h-8 w-px bg-blue-200"></div>

                    <div className="relative flex min-w-[280px] flex-col gap-2">
                      <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">批量参考图</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => setShowBatchReferencePicker(prev => !prev)}
                          className={`min-w-0 flex-1 rounded-xl border px-3 py-2 text-left text-xs font-black outline-none transition-all ${
                            selectedBatchReference
                              ? 'border-blue-400 bg-white text-blue-700 shadow-sm'
                              : 'border-slate-200 bg-white text-slate-600 hover:border-blue-300'
                          }`}
                        >
                          <i className="fa-solid fa-images mr-2 text-blue-600"></i>
                          {selectedBatchReference ? formatReferenceMention(selectedBatchReference.name) : '选择参考图'}
                        </button>
                        <button
                          onClick={handleBatchReferenceClear}
                          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-[10px] font-black text-slate-600 hover:bg-slate-50"
                        >
                          清除
                        </button>
                      </div>
                      {showBatchReferencePicker && (
                        <div className="absolute left-0 top-[66px] z-40 w-[420px] max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl border border-blue-200 bg-white shadow-2xl shadow-blue-950/15">
                          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                            <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">选择后直接加入提示词</span>
                            <button onClick={() => setShowBatchReferencePicker(false)} className="text-slate-300 hover:text-slate-600">
                              <i className="fa-solid fa-xmark"></i>
                            </button>
                          </div>
                          {settings.referenceLibrary.length === 0 ? (
                            <div className="p-6 text-center text-xs font-black text-slate-400">参考图库为空</div>
                          ) : (
                            <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto p-3">
                              {settings.referenceLibrary.map(reference => {
                                const isActive = batchReferenceId === reference.id;
                                return (
                                  <button
                                    key={reference.id}
                                    onClick={() => handleBatchReferenceToggle(reference)}
                                    className={`group overflow-hidden rounded-xl border text-left transition-all ${
                                      isActive
                                        ? 'border-blue-600 bg-blue-50 shadow-lg shadow-blue-500/20'
                                        : 'border-slate-200 bg-white hover:border-blue-300 hover:bg-blue-50/50'
                                    }`}
                                    title={formatReferenceMention(reference.name)}
                                  >
                                    <div className="relative aspect-square bg-slate-100">
                                      <img src={reference.imageData} alt={reference.name} className="h-full w-full object-cover" />
                                      {isActive && (
                                        <div className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg">
                                          <i className="fa-solid fa-check text-[10px]"></i>
                                        </div>
                                      )}
                                    </div>
                                    <div className="truncate px-2 py-2 text-[10px] font-black text-slate-700">
                                      {formatReferenceMention(reference.name)}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="ml-auto flex items-end gap-2">
                      <button onClick={runSelected} className="rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-black text-white shadow-lg shadow-blue-500/15 hover:bg-blue-700 active:scale-95">
                        <i className="fa-solid fa-play mr-2"></i>生成选中
                      </button>
                      <button onClick={() => setShowBatchDeleteConfirm(true)} className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-xs font-black text-red-600 hover:bg-red-50">
                        删除选中
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 gap-6">
              {tasks.map(task => (
                <TaskCard 
                  key={task.id} 
                  task={task} 
                  activeImageModel={activeImageModel}
                  referenceLibrary={settings.referenceLibrary}
                  onDelete={(id) => setTasks(prev => prev.filter(t => t.id !== id))} 
                  onCopy={() => setTasks(prev => [{
                    ...task,
                    id: Math.random().toString(36).substr(2, 9),
                    status: TaskStatus.IDLE,
                    statusMessage: '等待开始',
                    resultUrl: undefined,
                    outputWidth: undefined,
                    outputHeight: undefined,
                    selected: false,
                    error: undefined
                  }, ...prev])}
                  onEdit={(t) => setTasks(prev => prev.map(x => x.id === t.id ? t : x))}
                  onGenerate={() => runSingleTask(task)}
                  onToggleSelect={(id) => setTasks(prev => prev.map(t => t.id === id ? { ...t, selected: !t.selected } : t))}
                  onInsertReferenceMention={(referenceName) => handleInsertReferenceMention(task.id, referenceName)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {showBatchDeleteConfirm && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/50 p-6 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md rounded-3xl border border-slate-100 bg-white p-6 shadow-2xl">
            <div className="flex items-start gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-50 text-red-600">
                <i className="fa-solid fa-triangle-exclamation"></i>
              </div>
              <div>
                <h2 className="text-base font-black text-slate-900">确认删除已选任务？</h2>
                <p className="mt-2 text-sm font-medium leading-relaxed text-slate-500">
                  将删除已选 {selectedCount} 个任务，此操作不会影响已经导出的图片，但任务卡会从列表中移除。
                </p>
              </div>
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="flex-1 rounded-2xl bg-slate-100 px-4 py-3 text-xs font-black text-slate-600 transition-all hover:bg-slate-200"
              >
                取消
              </button>
              <button
                onClick={handleBatchDelete}
                className="flex-1 rounded-2xl bg-red-600 px-4 py-3 text-xs font-black text-white shadow-lg shadow-red-500/20 transition-all hover:bg-red-700 active:scale-95"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-slate-950/70 backdrop-blur-md animate-in fade-in">
          <div className="bg-white w-full max-w-3xl rounded-[2.5rem] shadow-2xl overflow-hidden border border-slate-100">
            <div className="p-8 border-b flex items-center justify-between bg-slate-50/50">
              <h2 className="text-xl font-black flex items-center gap-3"><i className="fa-solid fa-clipboard-list text-blue-600"></i> 任务导入预览</h2>
              <button onClick={() => setShowImportModal(false)} className="text-slate-300 hover:text-slate-600"><i className="fa-solid fa-times text-xl"></i></button>
            </div>
            <div className="p-8">
              <textarea value={importText} onChange={(e) => setImportText(e.target.value)} className="w-full h-72 p-6 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-4 focus:ring-blue-500/10 outline-none font-mono text-xs leading-loose text-slate-700 shadow-inner" spellCheck={false} />
            </div>
            <div className="p-8 bg-slate-50/80 border-t border-slate-100 flex gap-4">
              <button onClick={() => setShowImportModal(false)} className="flex-1 py-4 text-slate-500 font-black text-xs uppercase hover:bg-slate-200 rounded-2xl transition-all">放弃</button>
              <button onClick={handleBatchImport} className="flex-[2] py-4 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase shadow-xl shadow-blue-500/20 hover:bg-blue-700 active:scale-95">导入任务列表</button>
            </div>
          </div>
        </div>
      )}

      {showReferenceLibrary && (
        <div className="fixed inset-0 z-[105] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white w-full max-w-6xl rounded-[2rem] shadow-2xl overflow-hidden border border-slate-100">
            <div className="p-6 border-b flex items-center justify-between bg-slate-50/70">
              <div>
                <h2 className="text-lg font-black flex items-center gap-3">
                  <i className="fa-solid fa-images text-blue-600"></i> 参考图库
                </h2>
                <p className="mt-1 text-[11px] font-medium text-slate-500">统一预览、统一命名，在任务卡片里输入 <code>@</code> 即可调用。每张图下方的名称输入框都可以直接修改。</p>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => globalRefInputRef.current?.click()} className="rounded-xl bg-blue-600 px-4 py-2.5 text-[11px] font-black text-white shadow-lg shadow-blue-500/20 hover:bg-blue-700">
                  <i className="fa-solid fa-plus mr-2"></i>上传图片
                </button>
                <button onClick={() => setShowReferenceLibrary(false)} className="text-slate-300 hover:text-slate-600">
                  <i className="fa-solid fa-times text-xl"></i>
                </button>
              </div>
            </div>

            <div className="p-6">
              {settings.referenceLibrary.length === 0 ? (
                <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 px-6 py-12 text-center">
                  <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-slate-300 shadow-sm">
                    <i className="fa-solid fa-image text-2xl"></i>
                  </div>
                  <div className="text-sm font-black text-slate-500">还没有参考图</div>
                  <div className="mt-1 text-[11px] font-medium text-slate-400">上传后就能在卡片里通过 <code>@名称</code> 直接引用。</div>
                </div>
              ) : (
                <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto pr-1 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
                  {settings.referenceLibrary.map((reference, index) => (
                    <div key={reference.id} className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 shadow-sm">
                      <img src={reference.imageData} alt={reference.name} className="h-28 w-full object-cover" />
                      <div className="space-y-2 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] font-black uppercase tracking-widest text-slate-400">名称</span>
                          <span className="text-[9px] font-black text-blue-600">可编辑</span>
                        </div>
                        <input
                          value={reference.name}
                          onChange={(e) => handleReferenceLibraryRename(reference.id, e.target.value)}
                          className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-black text-slate-700 outline-none focus:border-blue-400"
                          placeholder={`图${index + 1}`}
                        />
                        <div className="rounded-lg border border-blue-100 bg-blue-50 px-2 py-1.5 text-[9px] font-black text-blue-700">
                          可引用：{formatReferenceMention(reference.name)}
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => navigator.clipboard?.writeText(formatReferenceMention(reference.name))}
                            className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[9px] font-black text-slate-600 hover:bg-slate-100"
                          >
                            复制
                          </button>
                          <button
                            onClick={() => handleReferenceLibraryRemove(reference.id)}
                            className="rounded-lg border border-red-100 bg-red-50 px-2 py-1.5 text-[9px] font-black text-red-600 hover:bg-red-100"
                            title="删除参考图"
                          >
                            <i className="fa-solid fa-trash-can"></i>
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showApiKeyEditor && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white w-full max-w-xl rounded-[2rem] shadow-2xl overflow-hidden border border-slate-100">
            <div className="p-6 border-b flex items-center justify-between bg-slate-50/70">
              <h2 className="text-lg font-black flex items-center gap-3"><i className="fa-solid fa-key text-blue-600"></i> {providerLabel} Key</h2>
              <button onClick={() => setShowApiKeyEditor(false)} className="text-slate-300 hover:text-slate-600"><i className="fa-solid fa-times text-xl"></i></button>
            </div>
            <div className="p-6">
              <div className="flex gap-2 mb-4">
                {([
                  { value: 'yunwu', label: '云雾API' },
                  { value: 'apimart', label: 'APIMart' }
                ] as Array<{ value: ServiceProvider; label: string }>).map(provider => (
                  <button
                    key={provider.value}
                    onClick={() => setSettings(prev => ({ ...prev, activeProvider: provider.value }))}
                    className={`px-4 py-2 rounded-xl text-xs font-black transition-all ${
                      settings.activeProvider === provider.value
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {provider.label}
                  </button>
                ))}
              </div>
              <p className="text-sm text-slate-500 leading-relaxed mb-4">当前正在编辑 <b>{providerLabel}</b>。填写后会保存在当前浏览器本地，下次打开页面会自动使用。若同时配置了 <code>.env.local</code>，这里保存的 Key 会优先生效。</p>
              <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-amber-600">当前固定模型</div>
                <div className="mt-1 text-sm font-black text-amber-950">{MODEL_SLOGAN}</div>
                <div className="mt-2 text-[11px] font-bold text-amber-700">{providerLabel}: <code>{activeImageModel}</code></div>
              </div>
              <label className="block text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">Key 内容</label>
              <div className="flex gap-2">
                <input
                  type={showApiKeyValue ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={`请输入你的 ${providerLabel} API Key`}
                  className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-medium outline-none focus:border-blue-400"
                />
                <button onClick={() => setShowApiKeyValue(v => !v)} className="px-4 rounded-2xl border border-slate-200 text-slate-600 font-bold hover:bg-slate-50">
                  {showApiKeyValue ? '隐藏' : '显示'}
                </button>
              </div>
              <p className="text-[11px] text-slate-400 mt-3">当前图像模型：<code>{activeImageModel}</code></p>
              <p className="text-[11px] text-slate-400 mt-1">当前文本模型：<code>{activeTextModel}</code></p>
              <p className="text-[11px] text-amber-600 mt-3 leading-relaxed">
                {settings.activeProvider === 'yunwu'
                  ? '云雾当前固定使用 gemini-3.1-flash-image-preview，也就是香蕉模型。'
                  : 'APIMart 当前固定使用 gpt-image-2 模型。'}
              </p>
            </div>
            <div className="p-6 bg-slate-50/80 border-t border-slate-100 flex gap-3">
              <button onClick={handleClearApiKey} className="px-5 py-3 text-red-600 font-black text-xs uppercase hover:bg-red-50 rounded-2xl transition-all">清除本地 Key</button>
              <button onClick={() => setShowApiKeyEditor(false)} className="flex-1 py-3 text-slate-500 font-black text-xs uppercase hover:bg-slate-200 rounded-2xl transition-all">关闭</button>
              <button onClick={handleSaveApiKey} className="flex-1 py-3 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase shadow-xl shadow-blue-500/20 hover:bg-blue-700 active:scale-95">保存</button>
            </div>
          </div>
        </div>
      )}

      {showExternalImageProcessor && (
        <div className="fixed inset-0 z-[115] flex items-center justify-center p-6 bg-slate-950/60 backdrop-blur-md animate-in fade-in">
          <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-[2rem] shadow-2xl overflow-hidden border border-slate-100 flex flex-col">
            <div className="p-6 border-b flex items-center justify-between bg-slate-50/70">
              <div>
                <h2 className="text-lg font-black flex items-center gap-3">
                  <i className="fa-solid fa-wand-magic-sparkles text-blue-600"></i> 单独处理图片
                </h2>
                <p className="mt-1 text-[11px] font-medium text-slate-500">
                  上传外部图片后，单独执行“去 AI 标识”处理，再直接导出，不走生图流程。
                </p>
              </div>
              <button onClick={() => setShowExternalImageProcessor(false)} className="text-slate-300 hover:text-slate-600">
                <i className="fa-solid fa-times text-xl"></i>
              </button>
            </div>

            <div className="p-6 space-y-5 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => externalImageInputRef.current?.click()}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-[11px] font-black text-white shadow-lg shadow-blue-500/20 hover:bg-blue-700"
                >
                  <i className="fa-solid fa-upload mr-2"></i>批量上传图片
                </button>

                <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                  <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">处理强度</span>
                  <div className="flex bg-white p-1 rounded-lg border border-slate-200">
                    {[
                      { label: '关闭', value: 'off' },
                      { label: '轻度', value: 'low' },
                      { label: '中度', value: 'medium' },
                      { label: '重度', value: 'high' }
                    ].map(level => (
                      <button
                        key={level.value}
                        onClick={() => setExternalAntiAILevel(level.value as AntiAILevel)}
                        className={`px-3 py-1 rounded text-[10px] font-black transition-all ${
                          externalAntiAILevel === level.value
                            ? 'bg-indigo-600 text-white shadow-sm'
                            : 'text-slate-500 hover:text-slate-700'
                        }`}
                      >
                        {level.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  onClick={handleProcessExternalImages}
                  disabled={externalImageJobs.length === 0 || isExternalImageProcessing}
                  className="rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-[11px] font-black text-indigo-700 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isExternalImageProcessing ? '批量处理中...' : '批量处理'}
                </button>

                <button
                  onClick={handleDownloadExternalImages}
                  disabled={!externalImageJobs.some(job => job.processed)}
                  className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-[11px] font-black text-emerald-700 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <i className="fa-solid fa-file-zipper mr-2"></i>批量下载 ZIP
                </button>

                <button
                  onClick={handleClearExternalImages}
                  disabled={externalImageJobs.length === 0}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[11px] font-black text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  清空列表
                </button>

                <span className="text-[11px] font-bold text-slate-400 truncate">
                  当前共 {externalImageJobs.length} 张，已处理 {externalImageJobs.filter(job => job.processed).length} 张
                </span>
              </div>

              {externalImageJobs.length === 0 ? (
                <div className="rounded-[1.5rem] border-2 border-dashed border-slate-200 bg-slate-50 px-6 py-16 text-center">
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-white text-slate-300 shadow-sm">
                    <i className="fa-solid fa-layer-group text-2xl"></i>
                  </div>
                  <div className="text-sm font-black text-slate-500">还没有待处理图片</div>
                  <div className="mt-1 text-[11px] font-medium text-slate-400">点击上面的“批量上传图片”后，就能统一处理再打包导出。</div>
                </div>
              ) : (
                <div className="rounded-[1.5rem] border border-slate-200 bg-slate-50 overflow-hidden">
                  <div className="grid grid-cols-[52px_minmax(0,1.5fr)_110px_110px_64px] gap-3 border-b border-slate-200 bg-white px-4 py-3 text-[10px] font-black uppercase tracking-widest text-slate-400">
                    <span>预览</span>
                    <span>文件名</span>
                    <span>处理状态</span>
                    <span>导出状态</span>
                    <span className="text-right">操作</span>
                  </div>
                  <div className="max-h-[52vh] overflow-y-auto divide-y divide-slate-200">
                    {externalImageJobs.map(job => {
                      const statusText =
                        job.status === 'idle'
                          ? '等待处理'
                          : job.status === 'processing'
                            ? '处理中'
                            : job.status === 'done'
                              ? '处理完成'
                              : (job.error || '处理失败');
                      const statusTone =
                        job.status === 'processing'
                          ? 'text-indigo-600'
                          : job.status === 'done'
                            ? 'text-emerald-600'
                            : job.status === 'failed'
                              ? 'text-red-600'
                              : 'text-slate-500';

                      return (
                        <div key={job.id} className="grid grid-cols-[52px_minmax(0,1.5fr)_110px_110px_64px] gap-3 px-4 py-3 items-center bg-slate-50 text-[11px]">
                          <div className="h-10 w-10 overflow-hidden rounded-lg border border-slate-200 bg-white">
                            <img src={job.processed || job.source} alt={`${job.name}-预览`} className="h-full w-full object-cover" />
                          </div>
                          <div className="min-w-0">
                            <div className="truncate font-black text-slate-700">{job.name}</div>
                            <div className="mt-1 truncate text-[10px] font-bold text-slate-400">
                              {job.processed ? '已生成处理结果，可打包下载' : '原图已载入'}
                            </div>
                          </div>
                          <div className={`font-black ${statusTone}`}>
                            <div className="flex items-center gap-2">
                              {job.status === 'processing' && <span className="inline-flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse" />}
                              {job.status === 'done' && <span className="inline-flex h-2 w-2 rounded-full bg-emerald-500" />}
                              {job.status === 'failed' && <span className="inline-flex h-2 w-2 rounded-full bg-red-500" />}
                              {job.status === 'idle' && <span className="inline-flex h-2 w-2 rounded-full bg-slate-300" />}
                              <span>{statusText}</span>
                            </div>
                          </div>
                          <div className={`font-black ${job.processed ? 'text-emerald-600' : 'text-slate-400'}`}>
                            {job.processed ? '可导出' : '未就绪'}
                          </div>
                          <div className="flex justify-end">
                            <button
                              onClick={() => handleRemoveExternalImage(job.id)}
                              className="rounded-lg border border-red-100 bg-red-50 px-2.5 py-1.5 text-[10px] font-black text-red-600 hover:bg-red-100"
                              title="移除这张图片"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] font-medium text-slate-500 leading-relaxed">
                当前这个工具只处理图片后期，不会调用云雾生图接口。你可以一次上传多张图、统一处理，再批量打包下载 zip。
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
