import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GenerationTask, ReferenceImageItem, TaskStatus } from '../types';
import {
  extractMentionNames,
  formatReferenceMention,
  normalizePromptReferenceMentions
} from '../utils/referenceMentions';
import { getYunwuResolutionLabel, supportsYunwuImageSize } from '../utils/yunwuImageCapabilities';

interface TaskCardProps {
  task: GenerationTask;
  activeImageModel: string;
  referenceLibrary: ReferenceImageItem[];
  onDelete: (id: string) => void;
  onCopy: (id: string) => void;
  onEdit: (task: GenerationTask) => void;
  onGenerate: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onInsertReferenceMention: (referenceName: string) => void;
}

type ActiveMention = {
  query: string;
  start: number;
  end: number;
};

const getTaskStatusMeta = (task: GenerationTask) => {
  switch (task.status) {
    case TaskStatus.PENDING:
      return {
        label: '排队中',
        tone: 'border-amber-100 bg-amber-50 text-amber-700',
        detail: task.statusMessage || '任务已进入队列，等待执行'
      };
    case TaskStatus.PROCESSING:
      return {
        label: '处理中',
        tone: 'border-blue-100 bg-blue-50 text-blue-700',
        detail: task.statusMessage || '正在处理当前任务'
      };
    case TaskStatus.COMPLETED:
      return {
        label: '已完成',
        tone: 'border-emerald-100 bg-emerald-50 text-emerald-700',
        detail: task.statusMessage || '生成完成，可下载或重试'
      };
    case TaskStatus.FAILED:
      return {
        label: '失败',
        tone: 'border-red-100 bg-red-50 text-red-700',
        detail: task.error || task.statusMessage || '生成失败，请检查原因'
      };
    case TaskStatus.PAUSED:
      return {
        label: '已停止',
        tone: 'border-slate-200 bg-slate-50 text-slate-600',
        detail: task.statusMessage || '任务已手动停止'
      };
    case TaskStatus.IDLE:
    default:
      return {
        label: '待生成',
        tone: 'border-slate-200 bg-slate-50 text-slate-600',
        detail: task.statusMessage || '等待开始'
      };
  }
};

const getActiveMentionAtCursor = (prompt: string, cursor: number): ActiveMention | null => {
  const beforeCursor = prompt.slice(0, cursor);
  const lastAtIndex = beforeCursor.lastIndexOf('@');
  if (lastAtIndex === -1) return null;

  const mentionSlice = beforeCursor.slice(lastAtIndex);
  if (mentionSlice.startsWith('@{')) {
    const closingBraceIndex = mentionSlice.indexOf('}');
    if (closingBraceIndex !== -1) {
      return null;
    }

    return {
      query: mentionSlice.slice(2).trim(),
      start: lastAtIndex,
      end: cursor
    };
  }

  if (/[,\s，。.!！?？;；:：]/.test(mentionSlice)) {
    return null;
  }

  return {
    query: mentionSlice.slice(1).trim(),
    start: lastAtIndex,
    end: cursor
  };
};

export const TaskCard: React.FC<TaskCardProps> = ({
  task,
  activeImageModel,
  referenceLibrary,
  onDelete,
  onCopy,
  onEdit,
  onGenerate,
  onToggleSelect,
  onInsertReferenceMention
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draftPrompt, setDraftPrompt] = useState(task.prompt);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [activeMention, setActiveMention] = useState<ActiveMention | null>(null);
  const [isPromptFocused, setIsPromptFocused] = useState(false);
  const [hoveredReferenceId, setHoveredReferenceId] = useState<string | null>(null);
  const isProcessing = task.status === TaskStatus.PROCESSING;
  const supportsExplicitImageSize = supportsYunwuImageSize(activeImageModel);
  const targetResolutionLabel = getYunwuResolutionLabel(activeImageModel, task.config.aspectRatio, task.config.imageSize);
  const referenceNames = referenceLibrary.map(reference => reference.name);
  const mentionNames = extractMentionNames(draftPrompt);
  const mentionedReferences = mentionNames
    .map(name => referenceLibrary.find(reference => reference.name === name))
    .filter((reference): reference is ReferenceImageItem => Boolean(reference))
    .filter((reference, index, list) => list.findIndex(item => item.id === reference.id) === index);
  const previewReferences = mentionedReferences.slice(0, 6);
  const hiddenPreviewCount = Math.max(mentionedReferences.length - previewReferences.length, 0);
  const activePreviewReference = previewReferences.find(reference => reference.id === hoveredReferenceId) || previewReferences[previewReferences.length - 1] || null;
  const unmatchedMentions = mentionNames.filter(name => !referenceLibrary.some(reference => reference.name === name));
  const statusMeta = getTaskStatusMeta(task);

  const mentionSuggestions = useMemo(() => {
    if (!activeMention) return [];
    const normalizedQuery = activeMention.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return referenceLibrary;
    }
    return referenceLibrary.filter(reference => reference.name.toLowerCase().includes(normalizedQuery));
  }, [activeMention, referenceLibrary]);

  useEffect(() => {
    if (isPromptFocused || task.prompt === draftPrompt) {
      return;
    }

    const nextCursorPosition = Math.min(cursorPosition, task.prompt.length);
    setDraftPrompt(task.prompt);
    setCursorPosition(nextCursorPosition);
    setActiveMention(getActiveMentionAtCursor(task.prompt, nextCursorPosition));
  }, [task.prompt, draftPrompt, cursorPosition, isPromptFocused]);

  useEffect(() => {
    if (!previewReferences.length) {
      setHoveredReferenceId(null);
      return;
    }

    setHoveredReferenceId(current => (
      current && previewReferences.some(reference => reference.id === current)
        ? current
        : previewReferences[previewReferences.length - 1].id
    ));
  }, [previewReferences]);

  const syncCursorPosition = () => {
    if (!textareaRef.current) return;
    const currentValue = textareaRef.current.value;
    const currentSelectionStart = textareaRef.current.selectionStart || 0;
    setDraftPrompt(currentValue);
    setCursorPosition(currentSelectionStart);
    setActiveMention(getActiveMentionAtCursor(currentValue, currentSelectionStart));
  };

  const insertMentionIntoPrompt = (referenceName: string) => {
    const mentionText = formatReferenceMention(referenceName);

    if (activeMention) {
      const before = draftPrompt.slice(0, activeMention.start);
      const after = draftPrompt.slice(activeMention.end);
      const suffixSpacer = after.length === 0 || !/^[\s,，。.!！?？;；:：]/.test(after) ? ' ' : '';
      const nextPrompt = `${before}${mentionText}${suffixSpacer}${after}`.replace(/\s{2,}/g, ' ');
      setDraftPrompt(nextPrompt);
      setActiveMention(null);
      onEdit({ ...task, prompt: nextPrompt });
      requestAnimationFrame(() => {
        if (!textareaRef.current) return;
        const nextCursorPosition = before.length + mentionText.length + suffixSpacer.length;
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(nextCursorPosition, nextCursorPosition);
        setCursorPosition(nextCursorPosition);
      });
      return;
    }
  };

  const handlePromptChange = (value: string, selectionStart: number) => {
    const normalizedPrompt = normalizePromptReferenceMentions(
      value,
      referenceLibrary.map(reference => reference.name)
    );
    setDraftPrompt(normalizedPrompt);
    setCursorPosition(selectionStart);
    setActiveMention(getActiveMentionAtCursor(normalizedPrompt, selectionStart));
    onEdit({ ...task, prompt: normalizedPrompt });
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task.resultUrl) return;
    const link = document.createElement('a');
    link.href = task.resultUrl;
    link.download = `image-${task.id}.png`;
    link.click();
  };

  return (
    <div className={`group relative ${activeMention ? 'z-30' : 'z-0'} bg-white border ${task.selected ? 'border-blue-500 ring-2 ring-blue-500/10' : 'border-slate-200'} rounded-xl shadow-sm hover:shadow-md transition-all`}>
      <div className="absolute top-2 left-2 z-10">
        <input
          type="checkbox"
          checked={!!task.selected}
          onChange={() => onToggleSelect(task.id)}
          className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
        />
      </div>

      <div className="relative aspect-square bg-slate-50 flex items-center justify-center overflow-hidden">
        {task.resultUrl ? (
          <img src={task.resultUrl} alt={task.prompt} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
        ) : mentionedReferences.length > 0 ? (
          <div className="flex h-full w-full flex-col bg-gradient-to-br from-slate-100 to-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="rounded-full bg-blue-50 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-blue-700">
                本次引用
              </span>
              <span className="text-[8px] font-black text-slate-400">{mentionedReferences.length} 张</span>
            </div>
            <div className="relative flex-1 overflow-hidden rounded-[1.75rem] bg-white/60 ring-1 ring-white/70">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(59,130,246,0.08),_transparent_55%)]" />
              <div className="absolute inset-x-0 top-3 z-20 flex justify-center px-3">
                <div className="max-w-[82%] truncate rounded-full bg-slate-950/78 px-3 py-1.5 text-center text-[9px] font-black text-white shadow-lg">
                  {activePreviewReference ? formatReferenceMention(activePreviewReference.name) : '参考图预览'}
                </div>
              </div>
              <div className="absolute inset-0 flex items-center justify-center px-5 pb-8 pt-10">
                {previewReferences.map((reference, index) => {
                  const baseOffset = (index - (previewReferences.length - 1) / 2) * 22;
                  const baseRotation = (index - (previewReferences.length - 1) / 2) * -4.5;
                  const isActive = activePreviewReference?.id === reference.id;

                  return (
                    <button
                      key={reference.id}
                      type="button"
                      onMouseEnter={() => setHoveredReferenceId(reference.id)}
                      onFocus={() => setHoveredReferenceId(reference.id)}
                      className="absolute h-[60%] w-[42%] overflow-hidden rounded-[1.4rem] border-2 border-white/90 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.22)] transition-all duration-200 ease-out"
                      style={{
                        transform: `translateX(${baseOffset}px) translateY(${isActive ? -10 : Math.abs(baseOffset) * 0.08}px) rotate(${baseRotation + (isActive ? 0 : index % 2 === 0 ? -1 : 1)}deg) scale(${isActive ? 1.05 : 0.95})`,
                        zIndex: isActive ? 30 : 10 + index
                      }}
                      title={formatReferenceMention(reference.name)}
                    >
                      <img src={reference.imageData} alt={reference.name} className="h-full w-full object-cover" />
                      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pb-2 pt-6 text-left">
                        <div className="truncate text-[8px] font-black text-white">{formatReferenceMention(reference.name)}</div>
                      </div>
                    </button>
                  );
                })}
                {hiddenPreviewCount > 0 && (
                  <div className="absolute bottom-3 right-3 z-40 rounded-full bg-blue-600 px-3 py-1 text-[10px] font-black text-white shadow-lg">
                    +{hiddenPreviewCount} 张
                  </div>
                )}
              </div>
            </div>
            <div className="mt-2 text-center text-[9px] font-bold text-slate-400">
              鼠标移到层叠图上，可突出预览对应参考图
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-5 text-center text-slate-300">
            <i className="fa-solid fa-wand-magic-sparkles text-4xl"></i>
            <div className="text-[10px] font-black uppercase tracking-widest">在下方写提示词并引用参考图库</div>
            <div className="text-[10px] font-bold text-slate-400">输入 <code>@</code> 会从参考图库联想</div>
          </div>
        )}

        {isProcessing && (
          <div className="absolute inset-0 bg-white/80 backdrop-blur-[2px] flex items-center justify-center z-20">
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="text-[10px] font-black text-blue-600 uppercase">生成中</span>
              <span className="max-w-[80%] text-center text-[9px] font-bold text-slate-500">{task.statusMessage || '正在处理当前任务'}</span>
            </div>
          </div>
        )}

        <div className="absolute top-2 right-2 flex flex-col items-end gap-1 z-10">
          {task.status === TaskStatus.COMPLETED && (
            <button
              onClick={handleDownload}
              className="bg-green-500 hover:bg-green-600 text-white w-6 h-6 flex items-center justify-center rounded-lg text-[10px] shadow-lg"
            >
              <i className="fa-solid fa-download"></i>
            </button>
          )}
          <div className="flex gap-1">
            <span className="bg-slate-800/80 text-white px-1 py-0.5 rounded text-[8px] font-mono">{task.config.aspectRatio}</span>
            <span className="bg-blue-600/80 text-white px-1 py-0.5 rounded text-[8px] font-mono">{supportsExplicitImageSize ? task.config.imageSize : '原生'}</span>
          </div>
        </div>
      </div>

      <div className="p-3">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={draftPrompt}
            onChange={(e) => handlePromptChange(e.target.value, e.target.selectionStart || 0)}
            onFocus={() => {
              setIsPromptFocused(true);
              syncCursorPosition();
            }}
            onBlur={() => {
              setIsPromptFocused(false);
            }}
            onClick={syncCursorPosition}
            onKeyUp={syncCursorPosition}
            onSelect={syncCursorPosition}
            spellCheck={false}
            className="relative z-10 w-full resize-none rounded bg-slate-50 p-1.5 text-xs font-medium leading-tight text-slate-700 border-none focus:ring-1 focus:ring-blue-500 h-16"
            placeholder="提示词里直接输入 @参考图..."
          />

          {activeMention && mentionSuggestions.length > 0 && (
            <div className="mt-2 rounded-xl border border-slate-200 bg-white p-2 shadow-lg">
              <div className="mb-1 text-[9px] font-black uppercase tracking-widest text-slate-400">参考图库联想</div>
              <div className="max-h-44 overflow-y-auto space-y-1">
                {mentionSuggestions.map(reference => (
                  <button
                    key={reference.id}
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertMentionIntoPrompt(reference.name)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-blue-50 transition-colors"
                  >
                    <img src={reference.imageData} alt={reference.name} className="w-8 h-8 rounded-lg object-cover shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[10px] font-black text-slate-700 truncate">{formatReferenceMention(reference.name)}</div>
                      <div className="text-[9px] text-slate-400 truncate">来自参考图库</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 text-[9px] font-bold text-slate-400">
          当前任务只负责执行。参考图请在页面左上角的参考图库中管理，输入 <code>@</code> 会自动弹出。
        </div>

        <div className={`mt-2 rounded-lg border px-2 py-1.5 ${statusMeta.tone}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[9px] font-black uppercase tracking-widest">{statusMeta.label}</span>
            {task.status === TaskStatus.PROCESSING && (
              <span className="inline-flex h-2 w-2 rounded-full bg-current animate-pulse" />
            )}
          </div>
          <div className="mt-1 text-[9px] font-bold leading-relaxed">{statusMeta.detail}</div>
        </div>

        {mentionedReferences.length > 0 && (
          <div className="mt-2">
            <div className="text-[9px] font-black uppercase tracking-widest text-slate-400 mb-1">本次引用</div>
            <div className="flex flex-wrap gap-1.5">
              {mentionedReferences.map(reference => (
                <button
                  key={reference.id}
                  onClick={() => insertMentionIntoPrompt(reference.name)}
                  className="flex items-center gap-1.5 rounded-full border border-blue-100 bg-blue-50 px-2 py-1 text-[9px] font-black text-blue-700"
                >
                  <img src={reference.imageData} alt={reference.name} className="w-4 h-4 rounded-full object-cover" />
                  <span>{formatReferenceMention(reference.name)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {unmatchedMentions.length > 0 && (
          <div className="mt-2 rounded-lg border border-amber-100 bg-amber-50 px-2 py-1.5 text-[9px] font-bold text-amber-700">
            未匹配参考图：{unmatchedMentions.map(name => `@${name}`).join('、')}
          </div>
        )}

        {task.outputWidth && task.outputHeight && (
          <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-[9px] font-bold text-slate-600">
            实际输出尺寸：{task.outputWidth} x {task.outputHeight}
          </div>
        )}

        {targetResolutionLabel && (
          <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 px-2 py-1.5 text-[9px] font-bold text-blue-700">
            目标分辨率：{targetResolutionLabel}
          </div>
        )}

        <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5 text-[9px] font-bold text-slate-500">
          参考图库：{referenceLibrary.length} 张
        </div>

        <div className="flex items-center justify-between border-t border-slate-100 pt-2 mt-3">
          <div className="flex gap-3 text-slate-400">
            <button onClick={() => onCopy(task.id)} className="hover:text-blue-600 transition-colors">
              <i className="fa-regular fa-copy text-xs"></i>
            </button>
            <button onClick={() => onDelete(task.id)} className="hover:text-red-600 transition-colors">
              <i className="fa-regular fa-trash-can text-xs"></i>
            </button>
          </div>
          <button
            disabled={isProcessing}
            onClick={() => onGenerate(task.id)}
            className={`px-3 py-1 rounded-lg text-[10px] font-black transition-all disabled:cursor-not-allowed disabled:opacity-50 ${
              isProcessing
                ? 'bg-slate-200 text-slate-400'
                : task.status === TaskStatus.COMPLETED
                ? 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {task.status === TaskStatus.COMPLETED ? '重试' : '开始'}
          </button>
        </div>

        {task.error && (
          <div className="mt-2 text-[8px] text-red-500 bg-red-50 p-1 rounded border border-red-100 truncate" title={task.error}>
            {task.error}
          </div>
        )}
      </div>
    </div>
  );
};
