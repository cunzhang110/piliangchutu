
import React, { useState, useEffect, useRef } from 'react';
import { GenerationTask, TaskStatus, AspectRatio, ImageSize, AppSettings, AntiAILevel, ReferenceImageItem } from './types';
import { TaskCard } from './components/TaskCard';
import { generateImage, getDefaultImageModel, getDefaultTextModel, getProviderLabel, hasConfiguredApiKey, preparePromptForImage } from './services/geminiService';
import { loadTasksFromDB, saveTasksToDB, loadSettingsFromDB, saveSettingsToDB } from './utils/db';
import { clearStoredApiKey, getStoredApiKey, saveStoredApiKey } from './utils/apiKeyStorage';
import { processAntiAI } from './utils/imageProcessor';
import { extractMentionNames, formatProtectedReferenceMention, formatReferenceMention, replaceReferenceMention } from './utils/referenceMentions';
import { getSupportedYunwuAspectRatios, getSupportedYunwuImageSizes, getYunwuResolutionLabel, getYunwuResolutionSummary, supportsYunwuImageSize } from './utils/yunwuImageCapabilities';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

const LEGACY_YUNWU_IMAGE_MODEL = 'gemini-3-pro-image-preview';

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
  const defaultImageModel = getDefaultImageModel();
  const defaultTextModel = getDefaultTextModel();

  const rawImageModel = rawSettings?.yunwuImageModel || rawSettings?.providerImageModels?.yunwu || defaultImageModel;
  const rawTextModel = rawSettings?.yunwuTextModel || rawSettings?.providerTextModels?.yunwu || defaultTextModel;

  return {
    ...rawSettings,
    referenceLibrary: normalizeReferenceLibrary(rawSettings?.referenceLibrary),
    yunwuImageModel: rawImageModel === LEGACY_YUNWU_IMAGE_MODEL ? defaultImageModel : rawImageModel,
    yunwuTextModel: rawTextModel || defaultTextModel
  };
};

const App: React.FC = () => {
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [isApiKeySelected, setIsApiKeySelected] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [isLoaded, setIsLoaded] = useState<boolean>(false);
  
  const [settings, setSettings] = useState<AppSettings>({
    yunwuImageModel: getDefaultImageModel(),
    yunwuTextModel: getDefaultTextModel(),
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
  const [showApiKeyValue, setShowApiKeyValue] = useState<boolean>(false);
  const [batchReferenceId, setBatchReferenceId] = useState<string>('');
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [importText, setImportText] = useState<string>('');
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'success' } | null>(null);
  
  const csvInputRef = useRef<HTMLInputElement>(null);
  const globalRefInputRef = useRef<HTMLInputElement>(null);
  
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
    setApiKeyInput(getStoredApiKey());
    setIsApiKeySelected(hasConfiguredApiKey());
  }, []);

  useEffect(() => {
    if (!batchReferenceId) return;
    const stillExists = settings.referenceLibrary.some(reference => reference.id === batchReferenceId);
    if (!stillExists) {
      setBatchReferenceId(settings.referenceLibrary[0]?.id || '');
    }
  }, [batchReferenceId, settings.referenceLibrary]);

  useEffect(() => {
    const supportedAspectRatios = getSupportedYunwuAspectRatios(settings.yunwuImageModel);
    const supportedImageSizes = getSupportedYunwuImageSizes(settings.yunwuImageModel);

    if (!supportedAspectRatios.includes(settings.defaultAspectRatio) || !supportedImageSizes.includes(settings.defaultImageSize)) {
      setSettings(prev => ({
        ...prev,
        defaultAspectRatio: supportedAspectRatios.includes(prev.defaultAspectRatio) ? prev.defaultAspectRatio : supportedAspectRatios[0],
        defaultImageSize: supportedImageSizes.includes(prev.defaultImageSize) ? prev.defaultImageSize : supportedImageSizes[0]
      }));
    }
  }, [settings.defaultAspectRatio, settings.defaultImageSize, settings.yunwuImageModel]);

  const handleRecheckApiKey = () => {
    const providerLabel = getProviderLabel();
    const hasKey = hasConfiguredApiKey();
    setIsApiKeySelected(hasKey);
    showToast(hasKey ? `已检测到 ${providerLabel} API Key` : `未检测到 ${providerLabel} API Key，请填写后保存`, hasKey ? "success" : "error");
  };

  const handleSaveApiKey = () => {
    const normalizedKey = apiKeyInput.trim();
    const providerLabel = getProviderLabel();
    if (!normalizedKey) {
      showToast(`请输入 ${providerLabel} API Key`, "error");
      return;
    }

    saveStoredApiKey(normalizedKey);
    setApiKeyInput(normalizedKey);
    setIsApiKeySelected(true);
    setShowApiKeyEditor(false);
    showToast(`${providerLabel} API Key 已保存到本地`, "success");
  };

  const handleClearApiKey = () => {
    const providerLabel = getProviderLabel();
    clearStoredApiKey();
    setApiKeyInput('');
    setIsApiKeySelected(hasConfiguredApiKey());
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

  const getImageDimensions = (imageDataUrl: string): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => reject(new Error('输出尺寸读取失败'));
      img.src = imageDataUrl;
    });
  };

  const handleGlobalRefUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
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

  const handleBatchReferenceApply = (mode: 'append' | 'replace') => {
    const selectedReference = settings.referenceLibrary.find(reference => reference.id === batchReferenceId) || settings.referenceLibrary[0];
    if (!selectedReference) {
      showToast("参考图库里还没有可用图片", "error");
      return;
    }

    const selectedMention = formatProtectedReferenceMention(selectedReference.name);

    setTasks(prev => prev.map(task => {
      if (!task.selected) return task;

      let nextPrompt = task.prompt.trim();
      const currentReferenceNames = Array.from(
        new Set(
          extractMentionNames(nextPrompt).filter(name =>
            settings.referenceLibrary.some(reference => reference.name === name)
          )
        )
      );

      if (mode === 'append') {
        if (!currentReferenceNames.includes(selectedReference.name)) {
          nextPrompt = `${nextPrompt}${nextPrompt ? ' ' : ''}${selectedMention}`.trim();
        }
        return { ...task, prompt: nextPrompt };
      }

      if (currentReferenceNames.length === 0) {
        nextPrompt = `${nextPrompt}${nextPrompt ? ' ' : ''}${selectedMention}`.trim();
        return { ...task, prompt: nextPrompt };
      }

      currentReferenceNames.forEach(referenceName => {
        nextPrompt = replaceReferenceMention(nextPrompt, referenceName, selectedReference.name);
      });

      return { ...task, prompt: nextPrompt };
    }));

    showToast(mode === 'append' ? `已把 ${selectedMention} 批量加入所选任务` : `已把所选任务的参考图批量替换为 ${selectedMention}`, "success");
  };

  const addTask = (prompt: string = '') => {
    const newTask: GenerationTask = {
      id: Math.random().toString(36).substr(2, 9),
      prompt,
      status: TaskStatus.IDLE,
      progress: 0,
      config: {
        aspectRatio: settings.defaultAspectRatio,
        imageSize: settings.defaultImageSize
      },
      createdAt: Date.now()
    };
    setTasks(prev => [newTask, ...prev]);
  };

  const updateBatchConfig = (config: Partial<GenerationTask['config']>) => {
    setTasks(prev => prev.map(t => {
      if (t.selected) {
        const newConfig = { ...t.config, ...config };
        return { ...t, config: newConfig as any };
      }
      return t;
    }));
  };

  const handleBatchImport = () => {
    const lines = importText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const newTasks = lines.map(prompt => ({
      id: Math.random().toString(36).substr(2, 9),
      prompt,
      status: TaskStatus.IDLE,
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

  const runSingleTask = async (task: GenerationTask) => {
    if (stopRef.current || pausedRef.current) return;
    
    // 如果处于全局冷却中（刚报过 429），先等待
    const cooldownRemainingMs = globalCooldownUntilRef.current - Date.now();
    if (cooldownRemainingMs > 0) {
      await new Promise(r => setTimeout(r, cooldownRemainingMs));
    }

    setTasks(prev => prev.map(t => t.id === task.id ? {
      ...t,
      status: TaskStatus.PROCESSING,
      error: undefined,
      outputWidth: undefined,
      outputHeight: undefined
    } : t));
    
    try {
      const finalPrompt = await preparePromptForImage(
        task.prompt,
        settings.forceRealisticPrompt,
        settings.yunwuTextModel
      );

      const rawResultUrl = await generateImage(
        finalPrompt,
        task.config.aspectRatio,
        task.config.imageSize,
        settings.referenceLibrary,
        settings.yunwuImageModel
      );
      
      const resultUrl = await processAntiAI(rawResultUrl, settings.antiAILevel);
      const outputDimensions = await getImageDimensions(resultUrl);

      setTasks(prev => prev.map(t => t.id === task.id ? {
        ...t,
        status: TaskStatus.COMPLETED,
        resultUrl,
        outputWidth: outputDimensions.width,
        outputHeight: outputDimensions.height
      } : t));
    } catch (err: any) {
      let errorMsg = err.message || "未知故障";
      const providerLabel = getProviderLabel();
      if (errorMsg === 'API_KEY_EXPIRED' || errorMsg === 'API_KEY_MISSING') {
        setIsApiKeySelected(false);
        stopRef.current = true; // 停止队列
        showToast(errorMsg === 'API_KEY_MISSING' ? `未检测到 ${providerLabel} API Key，请先填写并保存` : `${providerLabel} API Key 无效或无权限访问该模型，请重新配置`, "error");
      }
      
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, status: TaskStatus.FAILED, error: errorMsg === 'API_KEY_EXPIRED' ? `${providerLabel} API Key 无效或无权限` : errorMsg === 'API_KEY_MISSING' ? `未配置 ${providerLabel} API Key` : errorMsg } : t));
      
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
    setTasks(prev => prev.map(t => t.status === TaskStatus.PROCESSING ? { ...t, status: TaskStatus.IDLE } : t));
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
  const providerLabel = getProviderLabel();
  const activeImageModel = settings.yunwuImageModel || getDefaultImageModel();
  const activeTextModel = settings.yunwuTextModel || getDefaultTextModel();
  const selectedBatchReference = settings.referenceLibrary.find(reference => reference.id === batchReferenceId);
  const supportedAspectRatios = getSupportedYunwuAspectRatios(activeImageModel);
  const supportedImageSizes = getSupportedYunwuImageSizes(activeImageModel);
  const supportsExplicitImageSize = supportsYunwuImageSize(activeImageModel);
  const defaultResolutionSummary = getYunwuResolutionSummary(activeImageModel, settings.defaultAspectRatio, settings.defaultImageSize);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      {!isApiKeySelected && (
        <div className="fixed inset-0 z-[200] bg-slate-900/40 backdrop-blur-md flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white p-10 rounded-3xl shadow-2xl text-center border border-slate-100">
            <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-8 text-blue-600 text-3xl shadow-inner">
              <i className="fa-solid fa-wand-sparkles"></i>
            </div>
            <h1 className="text-2xl font-black text-slate-800 mb-4 tracking-tight">批量生图大师 Pro</h1>
            <p className="text-slate-500 text-sm mb-4 leading-relaxed">当前仅使用 <b>{providerLabel}</b>。在这里填写一次 API Key 后会自动保存在当前浏览器。</p>
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
            <div className="text-left mb-4">
              <label className="block text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">图像模型</label>
              <input
                value={activeImageModel}
                onChange={(e) => setSettings(prev => ({
                  ...prev,
                  yunwuImageModel: e.target.value
                }))}
                placeholder="例如 gemini-3.1-flash-image-preview"
                className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-sm font-medium outline-none focus:border-blue-400"
              />
            </div>
            <div className="text-left mb-5">
              <label className="block text-[11px] font-black uppercase tracking-widest text-slate-400 mb-2">文本模型</label>
              <input
                value={activeTextModel}
                onChange={(e) => setSettings(prev => ({
                  ...prev,
                  yunwuTextModel: e.target.value
                }))}
                placeholder="例如 gemini-3-pro-preview"
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
          <h1 className="text-xl font-black tracking-tight">生图大师 <span className="text-blue-600 text-[10px] bg-blue-50 px-2 py-0.5 rounded-full ml-2 border border-blue-100 font-bold">V3.5 PRO</span></h1>
          <button onClick={() => setShowReferenceLibrary(true)} className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-xl text-[11px] font-black flex items-center gap-2 hover:bg-slate-50">
            <i className="fa-solid fa-images text-blue-600"></i> 参考图库
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">{settings.referenceLibrary.length}</span>
          </button>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowApiKeyEditor(true)} className="bg-white border border-slate-200 text-slate-600 px-4 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:bg-slate-50">
            <i className="fa-solid fa-key"></i> 云雾API Key
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
        <div className="md:col-span-4 flex flex-col gap-1.5">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">当前图像模型</span>
          <input
            value={activeImageModel}
            onChange={(e) => setSettings(prev => ({
              ...prev,
              yunwuImageModel: e.target.value
            }))}
            className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs font-black outline-none focus:border-blue-400"
          />
        </div>

        <div className="md:col-span-3 flex flex-col gap-1.5 group">
           <div className="flex justify-between items-center">
             <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">并发限制: {settings.concurrency}</span>
             {settings.concurrency > 1 && <i className="fa-solid fa-triangle-exclamation text-[8px] text-amber-500 animate-pulse"></i>}
           </div>
           <input type="range" min="1" max="5" value={settings.concurrency} onChange={(e) => setSettings(s => ({ ...s, concurrency: parseInt(e.target.value) }))} className="accent-blue-600 h-1.5" />
           <span className="text-[7px] font-bold text-slate-400 opacity-60 group-hover:opacity-100 transition-opacity">频繁 429 请调至 1-2</span>
        </div>

        <div className="md:col-span-2 flex flex-col gap-1.5">
          <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">默认比例</span>
          <select value={settings.defaultAspectRatio} onChange={(e) => setSettings(s => ({ ...s, defaultAspectRatio: e.target.value as AspectRatio }))} className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 text-xs font-black outline-none focus:border-blue-400">
            {supportedAspectRatios.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
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

        <div className="md:col-span-3 flex justify-end gap-2">
          <button onClick={() => csvInputRef.current?.click()} className="bg-white border border-slate-200 px-4 py-2.5 rounded-xl text-xs font-black flex items-center gap-2 hover:bg-slate-50 transition-all"><i className="fa-solid fa-file-excel text-green-600"></i> 导入文件</button>
          <button onClick={() => addTask()} className="bg-blue-50 text-blue-700 px-4 py-2.5 rounded-xl text-xs font-black hover:bg-blue-100 active:scale-95"><i className="fa-solid fa-plus-circle"></i> 新增任务</button>
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
          </div>
        ) : (
          <>
            <div className="mb-6 flex items-center justify-between bg-white/50 backdrop-blur p-3 rounded-2xl border border-slate-200/60 sticky top-0 z-30 shadow-sm">
              <div className="flex items-center gap-2">
                <button onClick={() => setTasks(prev => prev.map(t => ({ ...t, selected: true })))} className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black text-blue-600 hover:bg-blue-50 transition-all">全选</button>
                <button onClick={() => setTasks(prev => prev.map(t => ({ ...t, selected: false })))} className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-[10px] font-black text-slate-500 hover:bg-slate-50">清空选择</button>
                <div className="h-4 w-px bg-slate-200 mx-2"></div>
                <button onClick={() => setTasks(prev => prev.map(t => t.status === TaskStatus.FAILED ? { ...t, selected: true } : t))} className="px-4 py-2 bg-red-50 text-red-700 rounded-xl text-[10px] font-black hover:bg-red-100 transition-all">选中失败项</button>
              </div>
              <div className="flex items-center gap-3 pr-4">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">任务总数: <span className="text-slate-800">{tasks.length}</span></span>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-l border-slate-200 pl-3">已选: <span className="text-blue-600">{selectedCount}</span></span>
              </div>
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

      {/* Batch Floating Bar */}
      {selectedCount > 0 && (
        <div className="fixed bottom-10 left-1/2 -translate-x-1/2 z-50 w-full max-w-6xl px-6 animate-in slide-in-from-bottom-10">
          <div className="bg-slate-900/95 text-white px-8 py-5 rounded-[2.5rem] flex items-center gap-6 shadow-2xl backdrop-blur-2xl border border-white/5 overflow-x-auto no-scrollbar">
             <div className="flex items-center gap-4 pr-6 border-r border-white/10 shrink-0">
                <div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center font-black text-lg shadow-lg">{selectedCount}</div>
                <div className="flex flex-col">
                  <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">批量编辑</span>
                  <span className="text-[9px] text-slate-500 font-bold">已选任务</span>
                </div>
             </div>
             
             <div className="flex-1 flex flex-wrap gap-6 items-start min-w-0">
                <div className="flex flex-col gap-2">
                  <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">比例</span>
                  <div className="flex gap-1">
                    {supportedAspectRatios.map(r => (
                      <button key={r} onClick={() => updateBatchConfig({ aspectRatio: r as AspectRatio })} className="text-[10px] font-black px-3 py-1.5 rounded-lg bg-white/5 hover:bg-blue-600 transition-all border border-white/10">{r}</button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">
                    {supportsExplicitImageSize ? '云雾分辨率' : '云雾原生分辨率'}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {supportedImageSizes.map(sz => (
                      <button
                        key={sz}
                        onClick={() => updateBatchConfig({ imageSize: sz as ImageSize })}
                        className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-left transition-all hover:bg-blue-600"
                      >
                        <div className="text-[10px] font-black">{supportsExplicitImageSize ? sz : '原生'}</div>
                        <div className="text-[8px] font-bold text-slate-300">
                          {getYunwuResolutionLabel(activeImageModel, settings.defaultAspectRatio, sz) || '以实际输出尺寸为准'}
                        </div>
                      </button>
                    ))}
                  </div>
                  <span className="text-[8px] font-bold text-slate-400">{defaultResolutionSummary}</span>
                </div>

                <div className="flex flex-col gap-2 min-w-0 max-w-[320px]">
                  <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">参考图</span>
                  <div className="flex gap-2 items-center min-w-0">
                    <select
                      value={batchReferenceId}
                      onChange={(e) => setBatchReferenceId(e.target.value)}
                      title={selectedBatchReference ? formatReferenceMention(selectedBatchReference.name) : '选择参考图库图片'}
                      className="w-[220px] max-w-[220px] rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 pr-8 text-[10px] font-black text-white outline-none overflow-hidden text-ellipsis whitespace-nowrap"
                    >
                      <option value="" className="text-slate-900">选择参考图库图片</option>
                      {settings.referenceLibrary.map(reference => (
                        <option key={reference.id} value={reference.id} className="text-slate-900">
                          {formatReferenceMention(reference.name)}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleBatchReferenceApply('append')}
                      className="text-[10px] font-black px-4 py-1.5 rounded-lg bg-white/5 hover:bg-blue-600 transition-all border border-white/10"
                    >
                      插入
                    </button>
                    <button
                      onClick={() => handleBatchReferenceApply('replace')}
                      className="text-[10px] font-black px-4 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500 transition-all border border-amber-400/20"
                    >
                      替换
                    </button>
                  </div>
                  {selectedBatchReference && (
                    <div
                      className="max-w-[220px] truncate rounded-lg bg-white/5 px-2 py-1 text-[9px] font-bold text-slate-300"
                      title={formatReferenceMention(selectedBatchReference.name)}
                    >
                      当前: {formatReferenceMention(selectedBatchReference.name)}
                    </div>
                  )}
                </div>

                <div className="flex flex-col gap-2 ml-auto">
                  <span className="text-[8px] text-slate-500 font-black uppercase tracking-widest">操作</span>
                  <div className="flex gap-2">
                    <button onClick={runSelected} className="text-[10px] font-black px-6 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 transition-all shadow-lg active:scale-95"><i className="fa-solid fa-play mr-2"></i>生成已选</button>
                    <button onClick={() => setTasks(prev => prev.filter(t => !t.selected))} className="text-[10px] font-black px-6 py-1.5 rounded-xl bg-red-600/80 hover:bg-red-600 transition-all border border-red-500/20"><i className="fa-solid fa-trash mr-2"></i>批量删除</button>
                  </div>
                </div>
             </div>

             <button onClick={() => setTasks(prev => prev.map(t => ({ ...t, selected: false })))} className="text-slate-500 hover:text-white transition-all transform hover:scale-110 shrink-0"><i className="fa-solid fa-circle-xmark text-2xl"></i></button>
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
              <h2 className="text-lg font-black flex items-center gap-3"><i className="fa-solid fa-key text-blue-600"></i> 云雾API Key</h2>
              <button onClick={() => setShowApiKeyEditor(false)} className="text-slate-300 hover:text-slate-600"><i className="fa-solid fa-times text-xl"></i></button>
            </div>
            <div className="p-6">
              <p className="text-sm text-slate-500 leading-relaxed mb-4">当前正在编辑 <b>{providerLabel}</b>。填写后会保存在当前浏览器本地，下次打开页面会自动使用。若同时配置了 <code>.env.local</code>，这里保存的 Key 会优先生效。</p>
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
              <p className="text-[11px] text-amber-600 mt-3 leading-relaxed">如果报“分组 default 下模型无可用渠道”，通常不是前端错误，而是云雾账号没有为这个模型开通通道。你可以先在这里换供应商给你的可用模型名再试。</p>
            </div>
            <div className="p-6 bg-slate-50/80 border-t border-slate-100 flex gap-3">
              <button onClick={handleClearApiKey} className="px-5 py-3 text-red-600 font-black text-xs uppercase hover:bg-red-50 rounded-2xl transition-all">清除本地 Key</button>
              <button onClick={() => setShowApiKeyEditor(false)} className="flex-1 py-3 text-slate-500 font-black text-xs uppercase hover:bg-slate-200 rounded-2xl transition-all">关闭</button>
              <button onClick={handleSaveApiKey} className="flex-1 py-3 bg-blue-600 text-white rounded-2xl font-black text-xs uppercase shadow-xl shadow-blue-500/20 hover:bg-blue-700 active:scale-95">保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
