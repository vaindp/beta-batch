import './index.css';
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { BatchPanel } from './batch/BatchPanel';
import { BatchSidebarTab } from './batch/BatchSidebarTab';
import { BATCH_MODEL, importDisposition, type BatchRun } from './batch/batch-core';
import {
  checkAIConnectionInBrowser, generateAIContentInBrowser, getAIConfigurationError, restoreAPIKeyConfig,
  modelMapping, GLOBAL_VERTEX_MODELS, resolveVertexRegion,
  type AIConnectionConfig, type AIProvider,
} from './ai/ai-browser';
import {
  calculateTranslationUsage, describeChapterCache, formatVnd, restoreTranslationStatistics,
  type CacheObservation,
} from './ai/translation-statistics';
import { clearAllContextCaches, isExplicitCacheEligible } from './ai/context-cache';
import { inspectVertexArgonCache, type VertexArgonCacheDiagnostic } from './ai/vertex-browser';
import * as Diff from 'diff';
import saveAs from 'file-saver';
import {
  BookOpen,
  Sparkles,
  Upload,
  Download,
  Settings,
  HelpCircle,
  Sun,
  Moon,
  Search,
  Check,
  RotateCcw,
  Trash2,
  Copy,
  FileText,
  FileDown,
  Play,
  X,
  RefreshCw,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  MessageSquareQuote,
  UserCheck,
  Languages,
  PanelLeftClose,
  PanelLeft,
  PanelRightClose,
  PanelRight,
  Maximize,
  Minimize
} from 'lucide-react';

// --- TYPES ---
export interface Chapter {
  id: string;
  title: string;
  originalContent: string;
  editedContent: string;
  status: 'ready' | 'editing' | 'done';
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  translationCostUsd?: number;
  cacheObservation?: CacheObservation;
  batchResultId?: string;
}

export interface Project {
  title: string;
  pronounRules: string;
  addressingRules: string;
  chapters: Chapter[];
}

interface AppLog {
  id: string;
  timestamp: string;
  type: 'info' | 'error' | 'success';
  message: string;
}

interface PromptLog {
  id: string;
  timestamp: string;
  chapterTitle?: string;
  prompt: string;
  systemInstruction?: string;
  model: string;
}

interface Notification {
  message: string;
  type: 'success' | 'error';
}

interface CompletionStats {
  totalChapters: number;
  totalRequests: number;
}

interface ChapterEditResult {
  success: boolean;
  message?: string;
  retryable?: boolean;
  fatal?: boolean;
  retryAfterMs?: number;
}

// --- CONSTANTS ---
const LOCAL_STORAGE_KEY = 'beta-batch-novel-project-v1';
const EXCHANGE_RATE_KEY = 'translation-usd-vnd-rate';
const DEFAULT_EXCHANGE_RATE = 26_000;
const SOUND_ENABLED_KEY = 'sound-notification-enabled';
const EDITOR_FONT_FAMILY_KEY = 'editor-font-family';
const EDITOR_FONT_SIZE_KEY = 'editor-font-size';
const EDITOR_FONT_WEIGHT_KEY = 'editor-font-weight';
const AI_CONNECTION_CONFIG_KEY = 'beta-batch-ai-config-v1';
const CONNECTION_CHECK_TIMEOUT_MS = 120_000;
const BULK_EDIT_RETRY_DELAYS_MS = [10_000, 20_000, 40_000];

const waitFor = (durationMs: number): Promise<void> => new Promise(resolve => {
  window.setTimeout(resolve, durationMs);
});

const formatAIErrorMessage = (error: any, fallback = 'Dịch vụ AI không thể tạo nội dung.'): string => {
  const message = error?.message
    || error?.response?.data?.error?.message
    || error?.response?.data?.message
    || fallback;
  const numericStatus = Number(error?.status ?? error?.code ?? error?.response?.status);
  const status = Number.isFinite(numericStatus) && numericStatus > 0 ? numericStatus : null;
  const apiStatus = error?.response?.data?.error?.status;
  const labels = [
    status ? `HTTP ${status}` : '',
    typeof apiStatus === 'string' ? apiStatus : '',
  ].filter(Boolean);
  const prefix = labels.length > 0 ? `[${labels.join(' · ')}] ` : '';
  return `${prefix}${String(message)}`;
};

const getChapterEditErrorDetails = (error: any): Omit<ChapterEditResult, 'success'> => {
  const message = formatAIErrorMessage(error);
  const numericStatus = Number(error?.status ?? error?.code ?? error?.response?.status);
  const status = Number.isFinite(numericStatus) ? numericStatus : 0;
  const normalizedMessage = String(message).toLocaleLowerCase('vi');
  const retryable = status === 429
    || status >= 500
    || normalizedMessage.includes('resource exhausted')
    || normalizedMessage.includes('please try again later')
    || normalizedMessage.includes('temporarily unavailable')
    || normalizedMessage.includes('timeout')
    || normalizedMessage.includes('network')
    || normalizedMessage.includes('failed to fetch');
  const fatal = !retryable && (
    status === 401
    || status === 403
    || normalizedMessage.includes('service account')
    || normalizedMessage.includes('phân quyền')
    || normalizedMessage.includes('permission denied')
    || normalizedMessage.includes('unauthenticated')
    || normalizedMessage.includes('api key')
    || normalizedMessage.includes('api_key_invalid')
  );
  const parsedRetryAfterMs = Number(error?.retryAfterMs);
  return {
    message,
    retryable,
    fatal,
    retryAfterMs: Number.isFinite(parsedRetryAfterMs) && parsedRetryAfterMs >= 0
      ? Math.min(parsedRetryAfterMs, 120_000)
      : undefined,
  };
};

const VERTEX_REGION_OPTIONS = [
  { value: 'us-central1', label: 'us-central1 (mặc định)' },
  { value: 'global', label: 'global (Gemini 3.x / 4)' },
  { value: 'us-east1', label: 'us-east1' },
  { value: 'us-east4', label: 'us-east4' },
  { value: 'us-west1', label: 'us-west1' },
  { value: 'europe-west1', label: 'europe-west1' },
  { value: 'europe-west4', label: 'europe-west4' },
  { value: 'asia-southeast1', label: 'asia-southeast1' },
  { value: 'asia-northeast1', label: 'asia-northeast1' },
];

const defaultProject: Project = {
  title: 'Dự án mới',
  pronounRules: `Hạ Ngôn: cô\nHùng Hùng: anh`,
  addressingRules: `1. Hạ Ngôn ↔ Hùng Hùng: tôi - cậu; tôi - cô.\n2. Hạ Ngôn ↔ Tướng quân Chử: tôi - tướng quân; tôi - cô nương.`,
  chapters: [],
};

const SAMPLE_PROJECT_TITLE = 'Kỷ Nguyên Bỏ Rơi';
const SAMPLE_CHAPTER_CONTENT = `Chương 1: Trở Về Thành Phố Bị Bỏ Rơi
Gió lạnh gào thét qua từng dãy nhà đổ nát. Hạ Ngôn bước xuống xe tải bọc thép, ánh mắt lạnh lùng quét qua xung quanh.
Hùng Hùng vẻ mặt nghiêm túc, vội vàng tiến tới chào hỏi: “Bà chủ Hạ, ngài đã trở lại rồi!”
Cô ta vốn dĩ là một chiến binh dạn dày sương gió, nhưng trong mắt lại không giấu nổi vẻ cung kính.
“Tình hình thế nào rồi?” Hạ Ngôn nhìn xung quanh hỏi.
Hùng Hùng thấp giọng đáp: “Báo cáo bà chủ, khu vực ngoại vi có dị biến bất thường. Toàn thể phân đội đang nghiêm陣以待.”
Hắn ngẩng đầu nhìn bầu trời âm u, sau đó nói thêm: “Tướng quân Chử cũng đang ở bên trong phòng chỉ huy đợi ngài.”
Hạ Ngôn gật đầu, cất bước đi thẳng vào căn cứ ngầm.`;

const modelDisplayNames = Object.keys(modelMapping);

const fontOptions = [
  { label: 'Mặc định (Be Vietnam Pro)', value: 'var(--font-family)' },
  { label: 'Lora (Tiểu thuyết)', value: "'Lora', Georgia, serif" },
  { label: 'Merriweather (Cổ điển)', value: "'Merriweather', serif" },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'JetBrains Mono', value: "'JetBrains Mono', monospace" },
];

const fontSizeOptions = Array.from({ length: 13 }, (_, i) => 12 + i);

const fontWeightOptions = [
  { label: 'Bình thường (400)', value: '400' },
  { label: 'Vừa (500)', value: '500' },
  { label: 'Đậm (700)', value: '700' },
];

const countWords = (str: string) => {
  if (!str) return 0;
  const plainText = str.replace(/<[^>]*>?/gm, '');
  return plainText.trim().split(/\s+/).filter(Boolean).length;
};

const escapeHtmlText = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

const htmlToPlainText = (html: string): string => {
  const container = document.createElement('div');
  container.innerHTML = html;
  container.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
  container.querySelectorAll('p, div').forEach(element => element.append('\n'));
  return (container.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const getChapterPlainText = (chapter: Chapter): string => {
  if (chapter.status === 'done' || chapter.editedContent) {
    return htmlToPlainText(chapter.editedContent);
  }
  return chapter.originalContent;
};

const replaceChapterText = (
  chapter: Chapter,
  findText: string,
  replaceText: string,
): { content: string; replacements: number } => {
  const container = document.createElement('div');
  if (chapter.status === 'done' || chapter.editedContent) {
    container.innerHTML = chapter.editedContent;
  } else {
    container.textContent = chapter.originalContent;
  }

  let replacements = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }
  textNodes.forEach(textNode => {
    const occurrences = textNode.data.split(findText).length - 1;
    if (occurrences > 0) {
      replacements += occurrences;
      textNode.data = textNode.data.split(findText).join(replaceText);
    }
  });
  return { content: container.innerHTML, replacements };
};

const getPromptForChapter = (chapterContent: string, project: Pick<Project, 'pronounRules' | 'addressingRules'>): string => {
  return `
Bạn là một trợ lý biên tập tiểu thuyết chuyên nghiệp.
Nhiệm vụ của bạn là dựa vào các quy tắc được cung cấp để sửa bản dịch.

---

## ⚙️ **BỘ QUY TẮC CHUẨN BIÊN TẬP TRUNG–VIỆT**

### 1️⃣ Trau chuốt & Thuần Việt
* ✅ **Trau chuốt câu từ cho mượt mà, thuần Việt** nhưng vẫn phải **giữ nguyên đúng ý gốc**.
* ✅ Chỉ sửa cấu trúc câu cho thật sự thuần Việt, dễ hiểu, trôi chảy, **không sửa nghĩa**.
* ❌ Tuyệt đối không làm thay đổi ý nghĩa của tác giả.
* ❌ Không thêm thắt tình tiết hoặc thay đổi tính cách nhân vật thông qua cách dùng từ.

### 2️⃣ Tên riêng & Ngôi xưng (QUY TẮC NGHIÊM NGẶT)
* ❌ **CẤM TUYỆT ĐỐI:** Không đổi tên riêng thành đại từ (Ví dụ: "Hạ Ngôn" → "cô").
* ❌ **CẤM TUYỆT ĐỐI:** Không đổi đại từ thành tên riêng (Ví dụ: "cô" → "Hạ Ngôn").
* ✅ **CHỈ SỬA:** Đại từ sai (so với quy tắc đại từ/xưng hô đã cung cấp) thành đại từ đúng theo quy tắc đã cung cấp.
* ✅ Giữ nguyên biệt danh, chức danh, tên riêng.
* ✅ Chỉ sửa lỗi chính tả rõ ràng.

### 3️⃣ BẮT BUỘC DỊCH CÁC TỪ NGOẠI LAI SÓT CONVERT
Nếu trong câu có bất kỳ từ/đoạn tiếng Trung, Anh... chưa dịch, BẮT BUỘC phải dịch nghĩa ra tiếng Việt thuần thục.
Ví dụ:
❌ "nghiêm陣以待" → ✅ "đang nghiêm chỉnh giằng trận".

--- QUY TẮC ĐẠI TỪ CỤ THỂ ---
${project.pronounRules}
--- HẾT QUY TẮC ĐẠI TỪ CỤ THỂ ---

--- BẢNG QUY TẮC XƯNG HÔ CỤ THỂ ---
${project.addressingRules}
--- HẾT BẢNG QUY TẮC XƯNG HÔ CỤ THỂ ---

--- VĂN BẢN GỐC CẦN BIÊN TẬP ---
${chapterContent}
--- HẾT VĂN BẢN GỐC ---

Hãy trả về duy nhất nội dung đã được biên tập thuần túy (plain text).
`;
};

const capitalizeSentences = (text: string) => {
  if (!text) return text;

  text = text.replace(/\.{3}([A-Za-zÀ-ỹ])/g, (m, p1) => `... ${p1.toUpperCase()}`);

  text = text.replace(
    /([.!?])\s+([a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳỵỷỹđ])/g,
    (match, p1, p2) => p1 + " " + p2.toUpperCase()
  );

  text = text.replace(/"([^"]+)"/g, (match, inner) => {
    if (!/[.!?…]$/.test(inner.trim())) return match;
    return `"${inner.charAt(0).toUpperCase() + inner.slice(1)}"`;
  });

  text = text.replace(/\[([^\]]+)\]/g, (match, inner) => {
    if (!/[.!?…]$/.test(inner.trim())) return match;
    return `[${inner.charAt(0).toUpperCase() + inner.slice(1)}]`;
  });

  text = text.replace(
    /(^|\n)([a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳỵỷỹđ])/g,
    (match, p1, p2) => p1 + p2.toUpperCase()
  );

  text = text.replace(/,"/g, '..."');
  text = text.replace(/,]/g, '...]');

  text = text.replace(
    /,(\s+)"([^"]*[.!?…])"/g,
    (match, space, inner) =>
      `:${space}"${inner.charAt(0).toUpperCase() + inner.slice(1)}"`
  );

  text = text.replace(
    /,(\s+)\[([^\]]*[.!?…])\]/g,
    (match, space, inner) =>
      `:${space}[${inner.charAt(0).toUpperCase() + inner.slice(1)}]`
  );

  return text;
};

const highlightDiffs = (original: string, edited: string): string => {
  const changes = Diff.diffWordsWithSpace(original, edited);

  const findSentenceContextAtIndex = (text: string, index: number): { sentence: string; offset: number; start: number } => {
    const safeIndex = Math.max(0, Math.min(index, text.length));
    const terminators = ['.', '!', '?', '\n', '…'];
    let start = -1;

    for (const t of terminators) {
      const lastIdx = text.lastIndexOf(t, safeIndex - 1);
      if (lastIdx > start) start = lastIdx;
    }
    start = (start === -1) ? 0 : start + 1;

    let end = text.length;
    for (const t of terminators) {
      const firstIdx = text.indexOf(t, safeIndex);
      if (firstIdx !== -1 && firstIdx < end) end = firstIdx;
    }
    end = (end === -1) ? text.length : end + 1;

    const rawSentence = text.substring(start, end);
    const leadingWhitespaceLength = rawSentence.length - rawSentence.trimStart().length;
    const sentence = rawSentence.trim();
    const sentenceStart = start + leadingWhitespaceLength;
    return {
      sentence,
      offset: Math.max(0, Math.min(safeIndex - sentenceStart, sentence.length)),
      start: sentenceStart,
    };
  };

  type ChangeKind = 'replacement' | 'insertion' | 'deletion';
  interface DiffOperation {
    kind: 'plain' | ChangeKind;
    text: string;
    originalText: string;
    sentence: string;
    originalOffset: number;
    editedSentence: string;
    editedOffset: number;
    groupId: string;
  }

  const operations: DiffOperation[] = [];
  let originalIndex = 0;
  let editedIndex = 0;

  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const part = changes[changeIndex];

    if (part.removed) {
      let removedText = part.value;
      while (changes[changeIndex + 1]?.removed) {
        changeIndex += 1;
        removedText += changes[changeIndex].value;
      }

      const originalContext = findSentenceContextAtIndex(original, originalIndex);
      const editedContext = findSentenceContextAtIndex(edited, editedIndex);
      let addedText = '';
      while (changes[changeIndex + 1]?.added) {
        changeIndex += 1;
        addedText += changes[changeIndex].value;
      }

      operations.push({
        kind: addedText ? 'replacement' : 'deletion',
        text: addedText,
        originalText: removedText,
        sentence: originalContext.sentence,
        originalOffset: originalContext.offset,
        editedSentence: editedContext.sentence,
        editedOffset: editedContext.offset,
        groupId: `sentence-${originalContext.start}`,
      });
      originalIndex += removedText.length;
      editedIndex += addedText.length;
      continue;
    }

    if (part.added) {
      const originalContext = findSentenceContextAtIndex(original, originalIndex);
      const editedContext = findSentenceContextAtIndex(edited, editedIndex);
      operations.push({
        kind: 'insertion',
        text: part.value,
        originalText: '',
        sentence: originalContext.sentence,
        originalOffset: originalContext.offset,
        editedSentence: editedContext.sentence,
        editedOffset: editedContext.offset,
        groupId: `sentence-${originalContext.start}`,
      });
      editedIndex += part.value.length;
      continue;
    }

    operations.push({
      kind: 'plain',
      text: part.value,
      originalText: '',
      sentence: '',
      originalOffset: 0,
      editedSentence: '',
      editedOffset: 0,
      groupId: '',
    });
    originalIndex += part.value.length;
    editedIndex += part.value.length;
  }

  const createChangeMark = (
    kind: ChangeKind,
    visibleText: string,
    originalText: string,
    sentence: string,
    originalOffset: number,
    editedSentence: string,
    editedOffset: number,
    groupId: string,
  ): string => (
    `<mark class="diff-change diff-${kind}" data-change-group="${groupId}" data-change-kind="${kind}" data-original="${escapeHtmlText(originalText)}" data-sentence="${escapeHtmlText(sentence)}" data-original-offset="${originalOffset}" data-edited-sentence="${escapeHtmlText(editedSentence)}" data-edited-offset="${editedOffset}" tabindex="0">${escapeHtmlText(visibleText)}</mark>`
  );

  const deletionTargets = new Map<number, { operation: DiffOperation; edge: 'start' | 'end' }>();
  operations.forEach((operation, operationIndex) => {
    if (operation.kind !== 'deletion') return;

    const nextPlainIndex = operations.findIndex((candidate, candidateIndex) => (
      candidateIndex > operationIndex
      && candidate.kind === 'plain'
      && /\S/.test(candidate.text)
    ));
    if (nextPlainIndex >= 0 && !deletionTargets.has(nextPlainIndex)) {
      deletionTargets.set(nextPlainIndex, { operation, edge: 'start' });
      return;
    }

    for (let candidateIndex = operationIndex - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = operations[candidateIndex];
      if (candidate.kind === 'plain' && /\S/.test(candidate.text) && !deletionTargets.has(candidateIndex)) {
        deletionTargets.set(candidateIndex, { operation, edge: 'end' });
        return;
      }
    }
  });

  return operations.map((operation, operationIndex) => {
    if (operation.kind === 'deletion') return '';
    if (operation.kind !== 'plain') {
      return createChangeMark(
        operation.kind,
        operation.text,
        operation.originalText,
        operation.sentence,
        operation.originalOffset,
        operation.editedSentence,
        operation.editedOffset,
        operation.groupId,
      );
    }

    const deletionTarget = deletionTargets.get(operationIndex);
    if (!deletionTarget) return escapeHtmlText(operation.text);

    const words = Array.from(operation.text.matchAll(/\S+/g));
    const contextWord = deletionTarget.edge === 'start' ? words[0] : words[words.length - 1];
    if (!contextWord || contextWord.index === undefined) return escapeHtmlText(operation.text);

    const wordStart = contextWord.index;
    const wordEnd = wordStart + contextWord[0].length;
    const deletion = deletionTarget.operation;
    return [
      escapeHtmlText(operation.text.slice(0, wordStart)),
      createChangeMark(
        'deletion',
        contextWord[0],
        deletion.originalText,
        deletion.sentence,
        deletion.originalOffset,
        deletion.editedSentence,
        deletion.editedOffset,
        deletion.groupId,
      ),
      escapeHtmlText(operation.text.slice(wordEnd)),
    ].join('');
  }).join('');
};

export default function App() {
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isAppLogsModalOpen, setIsAppLogsModalOpen] = useState(false);
  const [isPromptLogsModalOpen, setIsPromptLogsModalOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [project, setProject] = useState<Project>({ title: '', pronounRules: '', addressingRules: '', chapters: [] });
  const [exchangeRate, setExchangeRate] = useState(() => {
    const saved = Number(localStorage.getItem(EXCHANGE_RATE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_EXCHANGE_RATE;
  });
  const [argonCacheDiagnostic, setArgonCacheDiagnostic] = useState<VertexArgonCacheDiagnostic | null>(null);
  const [isCheckingArgonCache, setIsCheckingArgonCache] = useState(false);
  const argonCacheCheckRef = useRef<AbortController | null>(null);

function formatDateTime(dateStr?: string): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${hours}:${minutes}:${seconds} ${day}/${month}/${year}`;
}

  const [selectedModelName, setSelectedModelName] = useState('Gemini 4 Argon');
  const [provider, setProvider] = useState<AIProvider>('vertex-ai'); // Default to Vertex AI Service Account
  const [isGoogleDetailsOpen, setIsGoogleDetailsOpen] = useState(true);
  const [vertexProjectId, setVertexProjectId] = useState('');
  const [vertexRegion, setVertexRegion] = useState('us-central1');
  const [vertexServiceAccountJson, setVertexServiceAccountJson] = useState('');
  const [vertexServiceAccountEmail, setVertexServiceAccountEmail] = useState('');
  const [vertexKeyFileName, setVertexKeyFileName] = useState('');
  const [vertexKeyError, setVertexKeyError] = useState('');
  const [enableExplicitCache, setEnableExplicitCache] = useState(true);
  const [isAIConfigLoaded, setIsAIConfigLoaded] = useState(false);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{ status: 'success' | 'error'; message: string } | null>(null);
  const [isSoundEnabled, setIsSoundEnabled] = useState(false);
  const [isCompletionModalOpen, setIsCompletionModalOpen] = useState(false);
  const [completionStats, setCompletionStats] = useState<CompletionStats | null>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState<'rules' | 'stats' | 'batch'>('rules');
  const [appLogs, setAppLogs] = useState<AppLog[]>([]);
  const [promptLogs, setPromptLogs] = useState<PromptLog[]>([]);
  const [theme, setTheme] = useState('dark');
  const [chapterFilter, setChapterFilter] = useState('all');
  const [chapterSearch, setChapterSearch] = useState('');
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [deletingChapterId, setDeletingChapterId] = useState<string | null>(null);
  const [isReplaceVisible, setIsReplaceVisible] = useState(false);
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [replaceScope, setReplaceScope] = useState('current');
  const [isLoading, setIsLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const vertexFileInputRef = useRef<HTMLInputElement>(null);
  const connectionCheckRef = useRef<AbortController | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const readingPageScrollRef = useRef<HTMLDivElement>(null);
  const notificationTimeoutRef = useRef<number | null>(null);
  const lastInputHtml = useRef<string>('');

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(300);

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [lastSaveTime, setLastSaveTime] = useState<string | null>(null);
  const [editorFont, setEditorFont] = useState('var(--font-family)');
  const [editorFontSize, setEditorFontSize] = useState(16);
  const [editorFontWeight, setEditorFontWeight] = useState('400');

  useEffect(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      try {
        const savedProject = JSON.parse(saved) as Project & { fileName?: string };
        setProject({
          title: savedProject.title || '',
          pronounRules: savedProject.pronounRules || '',
          addressingRules: savedProject.addressingRules || '',
          chapters: Array.isArray(savedProject.chapters)
            ? savedProject.chapters.map(chapter => restoreTranslationStatistics(
                chapter.status === 'editing' ? { ...chapter, status: 'ready' as const } : chapter,
              ))
            : [],
        });
        setFileName(savedProject.fileName || '');
        if (savedProject.chapters?.length) {
          setActiveChapterId(savedProject.chapters[0].id);
        }
      } catch (e) {
        console.error('Không thể khôi phục dự án đã lưu:', e);
      }
    }
    const savedTheme = localStorage.getItem('app-theme');
    if (savedTheme) {
      setTheme(savedTheme);
    }
    setEditorFont(localStorage.getItem(EDITOR_FONT_FAMILY_KEY) || 'var(--font-family)');
    const savedFontSize = Number(localStorage.getItem(EDITOR_FONT_SIZE_KEY));
    if (Number.isFinite(savedFontSize) && savedFontSize >= 12 && savedFontSize <= 24) {
      setEditorFontSize(savedFontSize);
    }
    setEditorFontWeight(localStorage.getItem(EDITOR_FONT_WEIGHT_KEY) || '400');
    setIsSoundEnabled(localStorage.getItem(SOUND_ENABLED_KEY) === 'true');

    try {
      const savedAIConfig = sessionStorage.getItem(AI_CONNECTION_CONFIG_KEY);
      if (savedAIConfig) {
        const config: Partial<AIConnectionConfig> & Record<string, unknown> = JSON.parse(savedAIConfig);
        const keyConfig = restoreAPIKeyConfig(config);
        setProvider(keyConfig.provider);
        if (typeof config.enableExplicitCache === 'boolean') {
          setEnableExplicitCache(config.enableExplicitCache);
        }
        if (config.selectedModelName && Object.hasOwn(modelMapping, config.selectedModelName)) {
          setSelectedModelName(config.selectedModelName);
        }
        setVertexRegion(config.vertexRegion || 'us-central1');
        const savedServiceAccountJson = typeof config.vertexServiceAccountJson === 'string'
          ? config.vertexServiceAccountJson
          : '';
        if (savedServiceAccountJson) {
          const credentials = JSON.parse(savedServiceAccountJson);
          if (credentials?.type === 'service_account' && credentials.project_id) {
            setVertexProjectId(credentials.project_id);
            setVertexServiceAccountEmail(credentials.client_email);
            setVertexServiceAccountJson(savedServiceAccountJson);
            setVertexKeyFileName(config.vertexKeyFileName || 'service-account.json');
          }
        }
      }
    } catch (error) {
      console.error('Không thể khôi phục cấu hình AI:', error);
    } finally {
      setIsAIConfigLoaded(true);
    }
  }, []);

  useEffect(() => {
    setSaveStatus('saving');
    const timeoutId = window.setTimeout(() => {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({ ...project, fileName }));
      setLastSaveTime(new Date().toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }));
      setSaveStatus('saved');
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [project, fileName]);

  useEffect(() => {
    localStorage.setItem(EXCHANGE_RATE_KEY, String(exchangeRate));
  }, [exchangeRate]);

  useEffect(() => {
    argonCacheCheckRef.current?.abort();
    argonCacheCheckRef.current = null;
    setIsCheckingArgonCache(false);
    setArgonCacheDiagnostic(null);
    return () => argonCacheCheckRef.current?.abort();
  }, [project.pronounRules, project.addressingRules, provider, selectedModelName, vertexProjectId, vertexServiceAccountJson]);

  useEffect(() => {
    document.body.className = theme === 'light' ? 'light-mode' : 'dark-mode';
    localStorage.setItem('app-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SOUND_ENABLED_KEY, String(isSoundEnabled));
  }, [isSoundEnabled]);

  useEffect(() => {
    if (!isAIConfigLoaded) return;
    const config: AIConnectionConfig = {
      provider,
      selectedModelName,
      vertexProjectId,
      vertexRegion: vertexRegion || 'us-central1',
      vertexServiceAccountEmail,
      vertexKeyFileName,
      vertexServiceAccountJson,
      enableExplicitCache,
    };
    sessionStorage.setItem(AI_CONNECTION_CONFIG_KEY, JSON.stringify(config));
  }, [
    isAIConfigLoaded,
    provider,
    selectedModelName,
    vertexProjectId,
    vertexRegion,
    vertexServiceAccountEmail,
    vertexKeyFileName,
    vertexServiceAccountJson,
    enableExplicitCache,
  ]);

  useEffect(() => {
    setConnectionTestResult(null);
    setIsCheckingConnection(false);
    return () => {
      connectionCheckRef.current?.abort();
      connectionCheckRef.current = null;
    };
  }, [provider, selectedModelName, vertexProjectId, vertexRegion, vertexServiceAccountJson]);

  useEffect(() => {
    const modelId = modelMapping[selectedModelName];
    if (provider === 'vertex-ai' && GLOBAL_VERTEX_MODELS.has(modelId) && vertexRegion !== 'global') {
      setVertexRegion('global');
    }
  }, [provider, selectedModelName, vertexRegion]);

  const aiConnectionConfig: AIConnectionConfig = {
    provider, selectedModelName, vertexProjectId, vertexRegion,
    vertexServiceAccountEmail, vertexKeyFileName, vertexServiceAccountJson,
    enableExplicitCache,
  };
  const providerLabel = provider === 'server-gemini'
    ? 'Gemini AI (Máy chủ)'
    : 'Vertex AI (file JSON)';

  const aiConfigurationError = getAIConfigurationError(aiConnectionConfig);
  const isAIConfigured = isAIConfigLoaded && !aiConfigurationError;

  const handleImportBatch = (run: BatchRun) => {
    setProject(previous => ({
      ...previous,
      chapters: previous.chapters.map(chapter => {
        const row = run.rows.find(item => item.chapter.id === chapter.id);
        const result = run.results?.find(item => item.chapterId === chapter.id);
        if (!row || !result?.text || result.error || importDisposition(run, row, chapter, previous) !== 'ready') return chapter;
        const usage = result.usage;
        return {
          ...chapter,
          editedContent: highlightDiffs(chapter.originalContent, result.text),
          status: 'done' as const,
          batchResultId: `${run.id}/${chapter.id}`,
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
          cachedTokens: usage?.cachedContentTokenCount,
          translationCostUsd: undefined,
          cacheObservation: {
            model: BATCH_MODEL,
            mode: (usage?.cachedContentTokenCount ? 'implicit' : 'none') as CacheObservation['mode'],
            recordedAt: new Date().toISOString(),
            usageMetadata: usage ?? null,
            warning: 'Kết quả Batch API. Xem chi phí trong Google Cloud Billing.',
          },
        };
      }),
    }));
  };

  const insertSampleRules = () => {
    setProject(prev => ({
      ...prev,
      pronounRules: defaultProject.pronounRules,
      addressingRules: defaultProject.addressingRules,
    }));
    showNotification('Đã nạp bộ quy tắc mẫu!', 'success');
  };

  const handleClearRules = () => {
    setProject(prev => ({ ...prev, pronounRules: '', addressingRules: '' }));
    showNotification('Đã xóa trắng quy tắc.', 'success');
  };

  const handlePronounRulesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setProject(prev => ({ ...prev, pronounRules: event.target.value }));
  };

  const handleAddressingRulesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setProject(prev => ({ ...prev, addressingRules: event.target.value }));
  };

  const activeChapter = project.chapters.find(c => c.id === activeChapterId);

  const handleCopyContent = async () => {
    if (!activeChapter) return;
    const plainText = getChapterPlainText(activeChapter);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(plainText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = plainText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      showNotification('Đã sao chép nội dung chương!', 'success');
    } catch {
      showNotification('Không thể sao chép. Hãy cấp quyền Clipboard cho website.', 'error');
    }
  };

  const handleRevertToOriginal = () => {
    if (!activeChapter) return;
    setProject(prev => ({
      ...prev,
      chapters: prev.chapters.map(chapter => chapter.id === activeChapter.id
        ? { ...chapter, editedContent: '', status: 'ready', inputTokens: 0, outputTokens: 0,
            cachedTokens: undefined, translationCostUsd: undefined, cacheObservation: undefined }
        : chapter),
    }));
    showNotification('Đã khôi phục chương về nội dung gốc.', 'success');
  };

  const handleFontChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setEditorFont(event.target.value);
    localStorage.setItem(EDITOR_FONT_FAMILY_KEY, event.target.value);
  };

  const handleFontSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    setEditorFontSize(value);
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(value));
  };

  const handleFontWeightChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setEditorFontWeight(event.target.value);
    localStorage.setItem(EDITOR_FONT_WEIGHT_KEY, event.target.value);
  };

  const addAppLog = (message: string, type: 'success' | 'error' | 'info') => {
    setAppLogs(prev => [{ id: Math.random().toString(), timestamp: new Date().toISOString(), type, message }, ...prev]);
  };

  const showNotification = (
    message: string,
    type: 'success' | 'error',
    durationMs = 3000,
    syncErrorToLog = true,
  ) => {
    if (notificationTimeoutRef.current !== null) {
      window.clearTimeout(notificationTimeoutRef.current);
    }
    setNotification({ message, type });
    if (type === 'error' && syncErrorToLog) {
      addAppLog(message, 'error');
    }
    notificationTimeoutRef.current = window.setTimeout(() => {
      setNotification(null);
      notificationTimeoutRef.current = null;
    }, durationMs);
  };

  const playCompletionSound = () => {
    if (!isSoundEnabled) return;
    try {
      const AudioContextClass = window.AudioContext
        || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextClass) return;
      const audioContext = new AudioContextClass();
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const now = audioContext.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(523.25, now);
      gain.gain.setValueAtTime(0.3, now);
      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.2);
      oscillator.addEventListener('ended', () => void audioContext.close());
    } catch {
      // Audio playback ignore
    }
  };

  const handleClearVertexKey = () => {
    setVertexProjectId('');
    setVertexServiceAccountEmail('');
    setVertexServiceAccountJson('');
    setVertexKeyFileName('');
    setVertexKeyError('');
    setConnectionTestResult(null);
    if (vertexFileInputRef.current) {
      vertexFileInputRef.current.value = '';
    }
  };

  const handleVertexKeyFileSelect = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const json = JSON.parse(text);
        if (
          json?.type !== 'service_account'
          || !json.project_id
          || !json.client_email
          || !json.private_key
        ) {
          throw new Error('Tệp không phải Service Account Key hợp lệ.');
        }
        setVertexProjectId(json.project_id);
        setVertexServiceAccountEmail(json.client_email);
        setVertexServiceAccountJson(text);
        setVertexKeyFileName(file.name);
        setVertexKeyError('');
        setConnectionTestResult(null);
        addAppLog(`Đã nạp Service Account Key "${file.name}" cho Project ID ${json.project_id}.`, 'success');
        showNotification(`Đã nạp cấu hình Vertex AI: ${json.project_id}`, 'success');
      } catch (err: any) {
        setVertexProjectId('');
        setVertexServiceAccountEmail('');
        setVertexServiceAccountJson('');
        setVertexKeyFileName('');
        setConnectionTestResult(null);
        setVertexKeyError(err.message || 'Lỗi khi đọc tệp JSON.');
        addAppLog(`Không thể nạp Service Account Key: ${err.message}`, 'error');
      }
    };
    reader.readAsText(file);
    if (vertexFileInputRef.current) {
      vertexFileInputRef.current.value = '';
    }
  };

  const handleInspectArgonCache = async () => {
    if (argonCacheCheckRef.current || !vertexServiceAccountJson) return;
    const controller = new AbortController();
    argonCacheCheckRef.current = controller;
    setIsCheckingArgonCache(true);
    setArgonCacheDiagnostic(null);
    try {
      const diagnostic = await inspectVertexArgonCache({
        projectId: vertexProjectId,
        serviceAccountJson: vertexServiceAccountJson,
        prompt: getPromptForChapter('Kiểm tra tiền tố chung.', project),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setArgonCacheDiagnostic(diagnostic);
    } catch (error: any) {
      if (controller.signal.aborted) return;
      addAppLog(`Không kiểm tra được Cache Argon: ${error?.message || String(error)}`, 'error');
      showNotification('Không kiểm tra được Cache Argon.', 'error');
    } finally {
      if (argonCacheCheckRef.current === controller) {
        argonCacheCheckRef.current = null;
        setIsCheckingArgonCache(false);
      }
    }
  };

  const handleTestConnection = async () => {
    if (connectionCheckRef.current) return;
    if (aiConfigurationError) {
      setConnectionTestResult({ status: 'error', message: aiConfigurationError });
      showNotification(aiConfigurationError, 'error');
      return;
    }
    const modelId = modelMapping[selectedModelName] || 'gemini-3.8-flash';
    const controller = new AbortController();
    connectionCheckRef.current = controller;
    setIsCheckingConnection(true);
    setConnectionTestResult(null);
    try {
      await checkAIConnectionInBrowser(aiConnectionConfig, modelId, controller.signal);
      if (connectionCheckRef.current !== controller) return;
      const message = `Kết nối ${providerLabel} thành công (${modelId}).`;
      setConnectionTestResult({ status: 'success', message });
      addAppLog(message, 'success');
      showNotification(`Kết nối ${providerLabel} thành công!`, 'success');
    } catch (err: any) {
      if (connectionCheckRef.current !== controller) return;
      const message = formatAIErrorMessage(err, 'Kết nối thất bại.');
      setConnectionTestResult({ status: 'error', message });
      addAppLog(`Kiểm tra ${providerLabel} thất bại: ${message}`, 'error');
      showNotification(`Kết nối thất bại: ${message}`, 'error', 8000, false);
    } finally {
      if (connectionCheckRef.current === controller) {
        connectionCheckRef.current = null;
        setIsCheckingConnection(false);
      }
    }
  };

  const parseContentAndSetChapters = (content: string, sourceFileName = fileName): boolean => {
    const normalizedContent = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
    if (!normalizedContent) {
      setProject(prev => ({ ...prev, chapters: [] }));
      setActiveChapterId(null);
      return false;
    }

    const headingRegex = /^\s*(Chương\s+\d+[^\n]*)\s*$/gim;
    const headings = Array.from(normalizedContent.matchAll(headingRegex));
    const timestamp = Date.now();
    const newChapters: Chapter[] = [];

    if (headings.length === 0) {
      newChapters.push({
        id: `chapter-${timestamp}`,
        title: 'Chương 1',
        originalContent: normalizedContent,
        editedContent: '',
        status: 'ready',
      });
    } else {
      const preface = normalizedContent.slice(0, headings[0].index || 0).trim();
      if (preface) {
        newChapters.push({
          id: `chapter-${timestamp}-preface`,
          title: 'Mở đầu',
          originalContent: preface,
          editedContent: '',
          status: 'ready',
        });
      }

      headings.forEach((heading, index) => {
        const contentStart = (heading.index || 0) + heading[0].length;
        const contentEnd = headings[index + 1]?.index ?? normalizedContent.length;
        const chapterContent = normalizedContent.slice(contentStart, contentEnd).trim();
        if (!chapterContent) return;
        newChapters.push({
          id: `chapter-${timestamp}-${index}`,
          title: heading[1].trim(),
          originalContent: chapterContent,
          editedContent: '',
          status: 'ready',
        });
      });
    }

    if (newChapters.length === 0) {
      showNotification('Không tìm thấy nội dung chương hợp lệ trong tệp.', 'error', 3000, false);
      setProject(prev => ({ ...prev, chapters: [] }));
      setActiveChapterId(null);
      return false;
    }

    setProject(prev => ({
      ...prev,
      title: prev.title || sourceFileName.replace(/\.txt$/i, '') || 'Dự án mới',
      chapters: newChapters,
    }));
    setActiveChapterId(newChapters[0].id);
    return true;
  };

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.toLowerCase().endsWith('.txt')) {
      showNotification('Chỉ hỗ trợ tệp .txt.', 'error');
      event.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (readerEvent) => {
      const content = String(readerEvent.target?.result || '');
      if (!content.trim()) {
        showNotification('Tệp văn bản đang trống.', 'error', 3000, false);
        return;
      }
      const loaded = parseContentAndSetChapters(content, file.name);
      if (!loaded) return;
      setFileName(file.name);
      addAppLog(`Đã tải lên tệp: ${file.name}`, 'success');
      showNotification(`Tải tệp "${file.name}" thành công!`, 'success');
    };
    reader.readAsText(file, 'UTF-8');
    event.target.value = '';
  };

  const getDownloadBaseName = () => {
    const sourceName = fileName.replace(/\.txt$/i, '') || project.title || 'truyen-da-bien-tap';
    return sourceName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'truyen-da-bien-tap';
  };

  const handleDownload = () => {
    if (project.chapters.length === 0) {
      showNotification('Không có chương để tải xuống.', 'error');
      return;
    }
    const content = project.chapters
      .map(chapter => `${chapter.title}\n${getChapterPlainText(chapter)}`)
      .join('\n\n');
    const downloadFileName = `${getDownloadBaseName()} Đã biên.txt`;
    const blob = new Blob([`\uFEFF${content}`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showNotification(`Đã tải "${downloadFileName}".`, 'success');
  };

  const handleDownloadDocx = async () => {
    if (project.chapters.length === 0) {
      showNotification('Không có chương để tải xuống.', 'error');
      return;
    }
    const downloadFileName = `${getDownloadBaseName()} Đã biên.docx`;
    try {
      const { Document, Packer, Paragraph, TextRun } = await import('docx');
      const paragraphs = project.chapters.flatMap((chapter, chapterIndex) => {
        const bodyLines = getChapterPlainText(chapter).split(/\r?\n/);
        const chapterParagraphs = [
          new Paragraph({
            style: 'ChapterTitleStyle',
            children: [new TextRun({ text: chapter.title, bold: true })],
          }),
          ...bodyLines.map(line => new Paragraph({
            children: [new TextRun({ text: line, font: 'Times New Roman', size: 26 })],
          })),
        ];
        if (chapterIndex < project.chapters.length - 1) {
          chapterParagraphs.push(new Paragraph({ text: '' }));
        }
        return chapterParagraphs;
      });
      const doc = new Document({
        styles: {
          paragraphStyles: [{
            id: 'ChapterTitleStyle',
            name: 'Chapter Title',
            basedOn: 'Heading1',
            next: 'Normal',
            quickFormat: true,
            run: { font: 'Times New Roman', size: 32, bold: true, color: '800080' },
            paragraph: { spacing: { before: 240, after: 120 } },
          }],
        },
        sections: [{ children: paragraphs }],
      });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, downloadFileName);
      showNotification(`Đã tạo "${downloadFileName}".`, 'success');
    } catch (error) {
      console.error('Không thể tạo tệp DOCX:', error);
      showNotification('Lỗi khi tạo tệp DOCX.', 'error');
    }
  };

  useLayoutEffect(() => {
    if (!editorRef.current || !activeChapter) return;
    const displayContent = activeChapter.status === 'done'
      ? activeChapter.editedContent
      : (activeChapter.editedContent || escapeHtmlText(activeChapter.originalContent || ''));
    if (editorRef.current.innerHTML !== displayContent) {
      editorRef.current.innerHTML = displayContent;
    }
    lastInputHtml.current = displayContent;
  }, [activeChapterId, activeChapter?.status, activeChapter?.editedContent, activeChapter?.originalContent]);

  useLayoutEffect(() => {
    if (!activeChapterId || !readingPageScrollRef.current) return;
    readingPageScrollRef.current.scrollTop = 0;
    readingPageScrollRef.current.scrollLeft = 0;
  }, [activeChapterId]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const tooltip = document.createElement('div');
    tooltip.className = 'editor-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
    let activeHoveredMark: HTMLElement | null = null;

    const hideTooltip = () => {
      activeHoveredMark = null;
      tooltip.style.display = 'none';
      tooltip.replaceChildren();
    };

    const getChangeGroupKey = (changeMark: HTMLElement): string => (
      changeMark.dataset.changeGroup || `legacy-sentence-${changeMark.dataset.sentence || ''}`
    );

    const renderTooltip = (mark: HTMLElement) => {
      const groupId = getChangeGroupKey(mark);
      const availableMarks = Array.from(
        editor.querySelectorAll('mark.diff-change'),
      ) as HTMLElement[];
      const groupMarks = availableMarks.filter(candidate => getChangeGroupKey(candidate) === groupId);
      const anchorMark = groupMarks[0] || mark;
      const originalSentence = anchorMark.dataset.sentence || mark.dataset.sentence || anchorMark.dataset.original || '';
      const editedSentence = anchorMark.dataset.editedSentence || mark.dataset.editedSentence || '';
      const hoveredKind = mark.dataset.changeKind || 'replacement';
      const hoveredOriginal = (mark.dataset.original || '').trim();
      const hoveredEdited = (mark.textContent || '').trim();

      tooltip.replaceChildren();

      // Label: "Nội dung gốc: "
      const label = document.createElement('span');
      label.className = 'tooltip-label';
      label.textContent = 'Nội dung gốc: ';
      tooltip.appendChild(label);

      const sentenceContainer = document.createElement('span');
      sentenceContainer.className = 'tooltip-sentence-content';

      if (originalSentence) {
        let hasRenderedAnyDiff = false;

        if (editedSentence) {
          const diffParts = Diff.diffWordsWithSpace(originalSentence, editedSentence);

          for (let i = 0; i < diffParts.length; i++) {
            const part = diffParts[i];
            const prev = diffParts[i - 1];
            const next = diffParts[i + 1];

            if (part.removed) {
              // Sửa chữ hoặc Lược bỏ: tô vàng trong văn bản gốc
              const partTrimmed = part.value.trim();
              const isHoveredTarget = hoveredOriginal && (
                partTrimmed === hoveredOriginal
                || hoveredOriginal.includes(partTrimmed)
                || partTrimmed.includes(hoveredOriginal)
              );
              const highlightSpan = document.createElement('span');
              highlightSpan.className = isHoveredTarget
                ? 'tooltip-highlight tooltip-highlight-active'
                : 'tooltip-highlight';
              highlightSpan.textContent = part.value;
              sentenceContainer.appendChild(highlightSpan);
              hasRenderedAnyDiff = true;
            } else if (part.added) {
              // Chèn chữ: nếu là thay thế (đã có part.removed bên cạnh) thì từ gốc đã được tô ở trên
              // Nếu là chèn chữ mới hoàn toàn, tô chỗ trống chèn vô bằng vạch vàng |
              if (prev?.removed || next?.removed) {
                // Đã xử lý qua từ thay thế
              } else {
                const partTrimmed = part.value.trim();
                const isHoveredTarget = hoveredKind === 'insertion' && (
                  partTrimmed === hoveredEdited
                  || hoveredEdited.includes(partTrimmed)
                  || partTrimmed.includes(hoveredEdited)
                );
                const caret = document.createElement('span');
                caret.className = isHoveredTarget
                  ? 'tooltip-insertion-caret tooltip-caret-active'
                  : 'tooltip-insertion-caret';
                caret.title = `Vị trí chèn thêm: ${partTrimmed}`;
                sentenceContainer.appendChild(caret);
                hasRenderedAnyDiff = true;
              }
            } else {
              sentenceContainer.appendChild(document.createTextNode(part.value));
            }
          }
        }

        // Fallback trực tiếp nếu diffWordsWithSpace không tìm ra điểm khác biệt
        if (!hasRenderedAnyDiff) {
          sentenceContainer.replaceChildren();
          if (hoveredKind === 'insertion') {
            const offset = Number(mark.dataset.originalOffset) || 0;
            const safeOffset = Math.max(0, Math.min(offset, originalSentence.length));
            sentenceContainer.appendChild(document.createTextNode(originalSentence.slice(0, safeOffset)));
            const caret = document.createElement('span');
            caret.className = 'tooltip-insertion-caret tooltip-caret-active';
            caret.title = `Vị trí chèn thêm: ${hoveredEdited}`;
            sentenceContainer.appendChild(caret);
            sentenceContainer.appendChild(document.createTextNode(originalSentence.slice(safeOffset)));
          } else if (hoveredOriginal && originalSentence.includes(hoveredOriginal)) {
            const idx = originalSentence.indexOf(hoveredOriginal);
            sentenceContainer.appendChild(document.createTextNode(originalSentence.slice(0, idx)));
            const span = document.createElement('span');
            span.className = 'tooltip-highlight tooltip-highlight-active';
            span.textContent = hoveredOriginal;
            sentenceContainer.appendChild(span);
            sentenceContainer.appendChild(document.createTextNode(originalSentence.slice(idx + hoveredOriginal.length)));
          } else {
            sentenceContainer.appendChild(document.createTextNode(originalSentence));
          }
        }
      } else {
        sentenceContainer.appendChild(document.createTextNode(hoveredOriginal || hoveredEdited));
      }

      tooltip.appendChild(sentenceContainer);
      activeHoveredMark = mark;
      tooltip.style.display = 'block';
    };

    const positionTooltip = (mark: HTMLElement) => {
      const margin = 10;
      const rect = tooltip.getBoundingClientRect();
      const markRect = mark.getBoundingClientRect();

      let left = markRect.left;
      if (left + rect.width > window.innerWidth - margin) {
        left = window.innerWidth - rect.width - margin;
      }
      if (left < margin) left = margin;

      let top = markRect.bottom + 6;
      if (top + rect.height > window.innerHeight - margin) {
        const topCandidate = markRect.top - rect.height - 6;
        if (topCandidate >= margin) {
          top = topCandidate;
        } else {
          top = Math.max(margin, window.innerHeight - rect.height - margin);
        }
      }

      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
    };

    const findChangeMark = (target: EventTarget | null): HTMLElement | null => {
      if (!(target instanceof Element)) return null;
      const mark = target.closest('mark.diff-change');
      return mark && editor.contains(mark) ? mark as HTMLElement : null;
    };

    const handleMouseMove = (event: MouseEvent) => {
      const mark = findChangeMark(event.target);
      if (!mark) {
        hideTooltip();
        return;
      }
      if (activeHoveredMark !== mark) {
        renderTooltip(mark);
      }
      positionTooltip(mark);
    };

    editor.addEventListener('mousemove', handleMouseMove);
    editor.addEventListener('mouseleave', hideTooltip);

    return () => {
      editor.removeEventListener('mousemove', handleMouseMove);
      editor.removeEventListener('mouseleave', hideTooltip);
      tooltip.remove();
    };
  }, [activeChapterId]);

  const completedChaptersCount = project.chapters.filter(c => c.status === 'done').length;
  const totalChaptersCount = project.chapters.length;
  const progressPercent = totalChaptersCount === 0 ? 0 : Math.round((completedChaptersCount / totalChaptersCount) * 100);

  const totalOriginalWords = project.chapters.reduce((sum, c) => sum + countWords(c.originalContent), 0);
  const totalEditedWords = project.chapters.reduce((sum, c) => sum + (c.editedContent ? countWords(c.editedContent) : 0), 0);
  const totalInputTokens = project.chapters.reduce((sum, c) => sum + (c.inputTokens || 0), 0);
  const totalOutputTokens = project.chapters.reduce((sum, c) => sum + (c.outputTokens || 0), 0);
  const chaptersWithStatistics = project.chapters.filter(c =>
    c.cacheObservation || c.status === 'done' || (c.inputTokens || 0) > 0 || (c.outputTokens || 0) > 0,
  );
  const unknownCacheCount = chaptersWithStatistics.filter(c => c.cachedTokens === undefined).length;
  const hasUnknownCost = chaptersWithStatistics.some(c => c.translationCostUsd === undefined);
  const totalCachedTokens = project.chapters.reduce((sum, c) => sum + (c.cachedTokens || 0), 0);
  const totalTranslationCostUsd = project.chapters.reduce((sum, c) => sum + (c.translationCostUsd || 0), 0);

  const handleMouseDownOnResizer = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setSidebarWidth(Math.min(520, Math.max(240, startWidth + moveEvent.clientX - startX)));
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseDownOnRightResizer = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightSidebarWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setRightSidebarWidth(Math.min(520, Math.max(240, startWidth - (moveEvent.clientX - startX))));
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const loadSampleProject = () => {
    const loaded = parseContentAndSetChapters(SAMPLE_CHAPTER_CONTENT, 'ky_nguyen_bo_roi.txt');
    if (!loaded) return;
    setProject(prev => ({
      ...prev,
      title: SAMPLE_PROJECT_TITLE,
      pronounRules: defaultProject.pronounRules,
      addressingRules: defaultProject.addressingRules,
    }));
    setFileName('ky_nguyen_bo_roi.txt');
    showNotification('Đã tải chương mẫu và bộ quy tắc thử nghiệm!', 'success');
  };

  const updateChapter = useCallback((updatedChapter: Chapter) => {
    setProject(prev => ({
      ...prev,
      chapters: prev.chapters.map(chapter =>
        chapter.id === updatedChapter.id ? updatedChapter : chapter
      ),
    }));
  }, []);

  const handleReplaceAll = () => {
    if (!findText) {
      showNotification('Vui lòng nhập nội dung cần tìm.', 'error');
      findInputRef.current?.focus();
      return;
    }

    let totalReplacements = 0;
    if (replaceScope === 'current') {
      if (!activeChapter) {
        showNotification('Hãy chọn một chương trước khi thay thế.', 'error');
        return;
      }
      const result = replaceChapterText(activeChapter, findText, replaceText);
      totalReplacements = result.replacements;
      if (result.replacements > 0) {
        updateChapter({ ...activeChapter, editedContent: result.content, status: 'done' });
      }
      showNotification(`Đã thay thế ${totalReplacements} lần trong chương này.`, 'success');
    } else {
      const updatedChapters = project.chapters.map(chapter => {
        const result = replaceChapterText(chapter, findText, replaceText);
        totalReplacements += result.replacements;
        return result.replacements > 0
          ? { ...chapter, editedContent: result.content, status: 'done' as const }
          : chapter;
      });
      setProject(prev => ({ ...prev, chapters: updatedChapters }));
      showNotification(`Đã thay thế ${totalReplacements} lần trong toàn bộ truyện.`, 'success');
    }
    setIsReplaceVisible(false);
  };

  const handleReloadChapter = async (
    id: string,
    announceCompletion = true,
    reportFailure = true,
    isRetry = false,
  ): Promise<ChapterEditResult> => {
    const chapter = project.chapters.find(item => item.id === id);
    if (!chapter) {
      return { success: false, message: 'Không tìm thấy chương.' };
    }
    if (aiConfigurationError) {
      if (reportFailure) showNotification(aiConfigurationError, 'error', 8000, false);
      setIsSettingsModalOpen(true);
      return { success: false, message: aiConfigurationError, fatal: true };
    }

    const modelId = modelMapping[selectedModelName] || 'gemini-3.8-flash';
    const prompt = getPromptForChapter(chapter.originalContent, project);

    if (!isRetry) {
      setPromptLogs(prev => [{
        id: `${Date.now()}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        chapterTitle: chapter.title,
        prompt,
        model: selectedModelName,
      }, ...prev].slice(0, 100));
    }

    setProject(prev => ({
      ...prev,
      chapters: prev.chapters.map(item => item.id === id ? { ...item, status: 'editing' } : item),
    }));
    if (!isRetry) addAppLog(`Bắt đầu biên tập: ${chapter.title}`, 'info');

    try {
      const response = await generateAIContentInBrowser(aiConnectionConfig, {
        model: modelId,
        prompt,
      });
      const editedText = capitalizeSentences(response.text || '');
      const highlightedText = highlightDiffs(chapter.originalContent, editedText);
      const usage = calculateTranslationUsage(modelId, response.usageMetadata);
      const { inputTokens, outputTokens, cachedTokens } = usage;
      const cacheObservation: CacheObservation = {
        model: modelId,
        mode: response.cacheMode || 'none',
        recordedAt: new Date().toISOString(),
        usageMetadata: response.usageMetadata ?? null,
        warning: response.cacheWarning,
      };

      setProject(prev => ({
        ...prev,
        chapters: prev.chapters.map(item => item.id === id ? {
          ...item,
          editedContent: highlightedText,
          status: 'done',
          inputTokens,
          outputTokens,
          cachedTokens: cachedTokens ?? undefined,
          translationCostUsd: usage.costUsd ?? undefined,
          cacheObservation,
        } : item),
      }));
      addAppLog(`Biên tập xong: ${chapter.title}`, 'success');
      if (announceCompletion) {
        showNotification(`Đã biên tập "${chapter.title}".`, 'success');
        playCompletionSound();
      }
      return { success: true };
    } catch (error: any) {
      const details = getChapterEditErrorDetails(error);
      setProject(prev => ({
        ...prev,
        chapters: prev.chapters.map(item => item.id === id ? { ...item, status: 'ready' } : item),
      }));
      addAppLog(`Lỗi khi biên tập "${chapter.title}": ${details.message}`, 'error');
      if (reportFailure) {
        showNotification(details.message || 'Dịch vụ AI không thể tạo nội dung.', 'error', 8000, false);
      }
      return { success: false, ...details };
    }
  };

  const handleStartDeleteChapter = (event: React.MouseEvent, id: string) => {
    event.stopPropagation();
    setDeletingChapterId(id);
  };

  const handleConfirmDeleteChapter = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!deletingChapterId) return;
    const deletedIndex = project.chapters.findIndex(chapter => chapter.id === deletingChapterId);
    const remainingChapters = project.chapters.filter(chapter => chapter.id !== deletingChapterId);
    setProject(prev => ({
      ...prev,
      chapters: prev.chapters.filter(chapter => chapter.id !== deletingChapterId),
    }));
    if (activeChapterId === deletingChapterId) {
      setActiveChapterId(
        remainingChapters[deletedIndex]?.id
        || remainingChapters[deletedIndex - 1]?.id
        || null
      );
    }
    setDeletingChapterId(null);
    showNotification('Đã xóa chương.', 'success');
  };

  const handleCancelDeleteChapter = (event: React.MouseEvent) => {
    event.stopPropagation();
    setDeletingChapterId(null);
  };

  const handleClearChapters = () => {
    setProject(prev => ({ ...prev, chapters: [] }));
    setFileName('');
    setActiveChapterId(null);
    setDeletingChapterId(null);
    showNotification('Đã xóa danh sách chương và giữ nguyên bộ quy tắc.', 'success');
  };

  const handleDeleteFile = () => {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    setProject({ title: '', pronounRules: '', addressingRules: '', chapters: [] });
    setFileName('');
    setActiveChapterId(null);
    setDeletingChapterId(null);
    setFindText('');
    setReplaceText('');
    showNotification('Đã xóa toàn bộ dự án hiện tại.', 'success');
  };

  const handleBulkEdit = async () => {
    const pendingChapters = project.chapters.filter(chapter => chapter.status !== 'done');
    if (pendingChapters.length === 0) {
      showNotification('Không còn chương nào cần biên tập.', 'success');
      return;
    }
    if (aiConfigurationError) {
      showNotification(aiConfigurationError, 'error');
      setIsSettingsModalOpen(true);
      return;
    }

    setIsLoading(true);
    let completed = 0;
    let totalRequests = 0;
    const failedChapters: Array<{ id: string; title: string; message: string }> = [];

    try {
      for (const chapter of pendingChapters) {
        let lastResult: ChapterEditResult = { success: false };
        const maximumAttempts = BULK_EDIT_RETRY_DELAYS_MS.length + 1;

        for (let attemptIndex = 0; attemptIndex < maximumAttempts; attemptIndex += 1) {
          if (attemptIndex > 0) {
            const fallbackDelay = BULK_EDIT_RETRY_DELAYS_MS[attemptIndex - 1];
            const retryDelay = lastResult.retryAfterMs ?? fallbackDelay;
            await waitFor(retryDelay);
          }

          totalRequests += 1;
          lastResult = await handleReloadChapter(chapter.id, false, false, attemptIndex > 0);
          if (lastResult.success) {
            completed += 1;
            break;
          }
          if (lastResult.fatal) {
            failedChapters.push({ id: chapter.id, title: chapter.title, message: lastResult.message || '' });
            break;
          }
        }
      }
    } finally {
      setIsLoading(false);
    }

    if (completed === pendingChapters.length) {
      showNotification(`Đã hoàn tất ${completed} chương!`, 'success');
      setCompletionStats({ totalChapters: project.chapters.length, totalRequests });
      setIsCompletionModalOpen(true);
      playCompletionSound();
    } else {
      showNotification(`Đã xử lý ${completed}/${pendingChapters.length} chương.`, 'success');
    }
  };

  const filteredChapters = project.chapters.filter(chapter => {
    const matchesSearch = chapter.title.toLocaleLowerCase('vi').includes(chapterSearch.trim().toLocaleLowerCase('vi'));
    if (!matchesSearch) return false;
    if (chapterFilter === 'ready') return chapter.status !== 'done';
    if (chapterFilter === 'done') return chapter.status === 'done';
    return true;
  });

  return (
    <>
      <BatchPanel
        open={isBatchOpen}
        onClose={() => setIsBatchOpen(false)}
        onSettings={() => setIsSettingsModalOpen(true)}
        chapters={project.chapters}
        rules={project}
        title={project.title || fileName}
        credentials={vertexServiceAccountJson}
        promptFor={text => getPromptForChapter(text, project)}
        onImport={handleImportBatch}
      />

      {/* Completion Modal */}
      {isCompletionModalOpen && completionStats && (
        <div className="modal-overlay" onClick={() => setIsCompletionModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: '440px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Biên Tập Hoàn Tất</h2>
              <button className="btn-icon" onClick={() => setIsCompletionModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ textAlign: 'center', padding: '28px 24px' }}>
              <div style={{ fontSize: '48px', marginBottom: '12px' }}>🎉</div>
              <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '6px' }}>Đã biên tập xong toàn bộ!</h3>
              <p style={{ fontSize: '13px', color: 'var(--text-color-muted)', marginBottom: '20px' }}>
                Tất cả các chương đã được chuẩn hóa xưng hô, đại từ và trau chuốt câu từ thuần Việt.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', textAlign: 'left', marginBottom: '10px' }}>
                <div style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-color-muted)' }}>Tổng số chương</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--primary-color)' }}>{completionStats.totalChapters}</div>
                </div>
                <div style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px' }}>
                  <div style={{ fontSize: '11px', color: 'var(--text-color-muted)' }}>Lượt gọi AI</div>
                  <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--success-color)' }}>{completionStats.totalRequests}</div>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setIsCompletionModalOpen(false)}>Xác nhận & Xem kết quả</button>
            </div>
          </div>
        </div>
      )}

      {/* Help Modal */}
      {isHelpModalOpen && (
        <div className="modal-overlay" onClick={() => setIsHelpModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: '680px' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <HelpCircle size={20} color="var(--primary-color)" />
                <h2>Hướng Dẫn Sử Dụng Beta Batch</h2>
              </div>
              <button className="btn-icon" onClick={() => setIsHelpModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ lineHeight: 1.6, fontSize: '13px' }}>
              <h3 style={{ fontWeight: 600, marginBottom: '4px' }}>1. Tải truyện & Thiết lập quy tắc</h3>
              <p>Tải file <code>.txt</code> truyện (chia theo Chương 1, Chương 2...). Cài đặt danh sách đại từ nhân xưng ngoài thoại và bảng quan hệ xưng hô trong câu thoại.</p>
              <h3 style={{ fontWeight: 600, marginTop: '12px', marginBottom: '4px' }}>2. Chọn nhà cung cấp AI (Provider)</h3>
              <p>Mặc định bạn có thể dùng <strong>Gemini AI (Máy chủ)</strong> trực tiếp qua API Gemini, hoặc nạp <strong>Service Account JSON</strong> của Google Cloud để gọi Vertex AI và Batch API.</p>
              <h3 style={{ fontWeight: 600, marginTop: '12px', marginBottom: '4px' }}>3. Biên tập & Xuất bản</h3>
              <p>Biên tập từng chương hoặc chạy đồng loạt toàn bộ truyện; đối chiếu các từ thay đổi trực quan trên màn hình đọc và xuất file .TXT hoặc Word .DOCX.</p>
            </div>
          </div>
        </div>
      )}

      {/* App Logs Modal */}
      {isAppLogsModalOpen && (
        <div className="modal-overlay" onClick={() => setIsAppLogsModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: '800px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertCircle size={20} color="var(--primary-color)" />
                <h2>Nhật ký Hệ thống</h2>
              </div>
              <button className="btn-icon" onClick={() => setIsAppLogsModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              {appLogs.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-color-muted)' }}>Không có nhật ký nào</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {appLogs.map(log => (
                    <div key={log.id} style={{ padding: '8px', borderLeft: `4px solid ${log.type === 'error' ? 'var(--error-color)' : log.type === 'success' ? 'var(--success-color)' : 'var(--primary-color)'}`, backgroundColor: 'var(--card-bg)', borderRadius: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', color: 'var(--text-color-muted)', marginBottom: '4px' }}>
                        <span style={{ fontWeight: 700, color: log.type === 'error' ? 'var(--error-color)' : log.type === 'success' ? 'var(--success-color)' : 'var(--primary-color)' }}>
                          {log.type === 'error' ? 'LỖI' : log.type === 'success' ? 'THÀNH CÔNG' : 'THÔNG TIN'}
                        </span>
                        <span>{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                      <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{log.message}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Prompt Logs Modal */}
      {isPromptLogsModalOpen && (
        <div className="modal-overlay" onClick={() => setIsPromptLogsModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: '800px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <MessageSquareQuote size={20} color="var(--primary-color)" />
                <h2>Nhật ký Prompt</h2>
              </div>
              <button className="btn-icon" onClick={() => setIsPromptLogsModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              {promptLogs.length === 0 ? (
                <div style={{ padding: '24px', textAlign: 'center', color: 'var(--text-color-muted)' }}>Không có nhật ký nào</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  {promptLogs.map(log => (
                    <div key={log.id} style={{ padding: '12px', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', color: 'var(--text-color-muted)' }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-color)' }}>{log.chapterTitle || 'Hệ thống'}</span>
                        <span>{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                      <div style={{ fontSize: '13px', backgroundColor: 'var(--input-bg-color)', padding: '8px', borderRadius: '4px', whiteSpace: 'pre-wrap' }}>
                        {log.prompt}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {isSettingsModalOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsModalOpen(false)}>
          <div className="modal-content" style={{ maxWidth: '680px', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Settings size={20} color="var(--primary-color)" />
                <h2>Cài Đặt Kết Nối & Trí Tuệ Nhân Tạo</h2>
              </div>
              <button className="btn-icon" onClick={() => setIsSettingsModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div className="input-group">
                  <label htmlFor="modal-provider-select">Phương thức kết nối AI (AI Provider)</label>
                  <select
                    id="modal-provider-select"
                    className="styled-input styled-select"
                    value={provider}
                    onChange={e => setProvider(e.target.value as AIProvider)}
                  >
                    <option value="vertex-ai">Vertex AI / Google Cloud (File Service Account JSON)</option>
                  </select>
                  <span className="label-hint">
                    Kết nối an toàn và trực tiếp đến Google Cloud Platform thông qua khóa Service Account JSON.
                  </span>
                </div>

                <div className="input-group">
                  <label htmlFor="modal-model-select">Mô hình biên tập mặc định</label>
                  <select
                    id="modal-model-select"
                    className="styled-input styled-select"
                    value={selectedModelName}
                    onChange={e => setSelectedModelName(e.target.value)}
                  >
                    {modelDisplayNames.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', backgroundColor: 'var(--sidebar-subtle)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                  <div>
                    <label style={{ marginBottom: '2px', display: 'block', fontWeight: 500, fontSize: '13px' }}>
                      Tối ưu hóa chi phí với Explicit Caching
                    </label>
                    <div style={{ fontSize: '12px', color: 'var(--text-color-muted)' }}>
                      Tự động tạo bộ nhớ tạm Context Cache cho các mô hình hỗ trợ (Gemini 3.8 Flash, 3.5 Flash, 3.1 Flash Lite, 3.1 Pro, 2.5 Pro, 2.5 Flash), giảm đến 75% chi phí token đầu vào.
                    </div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={enableExplicitCache}
                      onChange={e => setEnableExplicitCache(e.target.checked)}
                    />
                    <span className="slider round" />
                  </label>
                </div>

                {provider === 'vertex-ai' && (
                  <div style={{ padding: '14px', backgroundColor: 'var(--sidebar-subtle)', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div className="input-group">
                      <label htmlFor="vertex-key-file">Khóa xác thực (Service Account JSON)</label>
                      <input
                        ref={vertexFileInputRef}
                        id="vertex-key-file"
                        type="file"
                        accept=".json,application/json"
                        style={{ display: 'none' }}
                        onChange={handleVertexKeyFileSelect}
                      />
                      <div className="file-picker-row">
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          onClick={() => vertexFileInputRef.current?.click()}
                        >
                          <FolderOpen size={14} />
                          <span>Tải lên tệp (.json)</span>
                        </button>
                        <span className="file-picker-name" title={vertexKeyFileName || undefined}>
                          {vertexKeyFileName || 'Chưa chọn tệp'}
                        </span>
                        {vertexKeyFileName && (
                          <button
                            type="button"
                            className="btn-icon"
                            title="Xóa khóa đã nạp"
                            onClick={handleClearVertexKey}
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                      {vertexServiceAccountEmail && (
                        <span className="label-hint">Tài khoản: {vertexServiceAccountEmail}</span>
                      )}
                    </div>

                    <div className="input-group">
                      <label htmlFor="vertex-region">Region / Vị trí máy chủ</label>
                      <select
                        id="vertex-region"
                        className="styled-input styled-select"
                        value={vertexRegion}
                        onChange={e => setVertexRegion(e.target.value)}
                      >
                        {VERTEX_REGION_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}

                <div className="input-group">
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={handleTestConnection}
                    disabled={isCheckingConnection}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    <RefreshCw size={14} className={isCheckingConnection ? 'icon-spin' : ''} />
                    <span>{isCheckingConnection ? 'Đang kiểm tra kết nối...' : `Kiểm tra kết nối ${providerLabel}`}</span>
                  </button>
                  {connectionTestResult && (
                    <div className={`vertex-status-banner ${connectionTestResult.status === 'success' ? 'connected' : 'unconfigured'}`} style={{ marginTop: '8px' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {connectionTestResult.status === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                        {connectionTestResult.message}
                      </span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border-color)' }}>
                  <div>
                    <label style={{ marginBottom: 2, display: 'block', fontWeight: 500, fontSize: '13px' }}>Âm Báo Hoàn Thành</label>
                    <div style={{ fontSize: '12px', color: 'var(--text-color-muted)' }}>Phát âm thanh khi AI biên tập xong 1 chương</div>
                  </div>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={isSoundEnabled}
                      onChange={() => setIsSoundEnabled(prev => !prev)}
                    />
                    <span className="slider round" />
                  </label>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setIsSettingsModalOpen(false)}>Lưu & Đóng</button>
            </div>
          </div>
        </div>
      )}

      {notification && (
        <div className={`notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* HEADER NAVBAR */}
      {!isFocusMode && (
        <header className="app-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className="btn-icon"
              onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
              title={isLeftSidebarOpen ? "Ẩn thanh bên trái" : "Hiện thanh bên trái"}
            >
              {isLeftSidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </button>
            <div className="header-brand">
              <div className="brand-logo">
                <BookOpen size={20} />
              </div>
              <div className="brand-text">
                <div className="brand-title-row">
                  <span className="brand-name">Beta Batch</span>
                  <span className="brand-version">Web 0.1</span>
                </div>
                <span className="brand-tagline">Trợ lý Biên tập & Chuẩn hóa Tiểu thuyết</span>
              </div>
            </div>
          </div>

          {fileName && (
            <div className="header-project-badge">
              <FileText size={14} color="var(--primary-color)" />
              <span className="project-badge-name" title={fileName}>{fileName}</span>
              <span className="project-badge-stat">({project.chapters.length} chương)</span>
            </div>
          )}

          <div className="header-actions">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              style={{ display: 'none' }}
              accept=".txt"
            />

            <button
              className="btn-icon"
              onClick={() => fileInputRef.current?.click()}
              title="Tải tệp truyện (.txt)"
            >
              <Upload size={16} />
            </button>

            {/* Export Dropdown */}
            <div style={{ position: 'relative' }}>
              <button
                className="btn-icon"
                onClick={() => setIsExportMenuOpen(prev => !prev)}
                disabled={project.chapters.length === 0}
                title="Xuất bản tiểu thuyết"
              >
                <Download size={16} />
              </button>
              {isExportMenuOpen && (
                <div className="export-dropdown-menu">
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      handleDownload();
                    }}
                  >
                    <FileText size={15} color="var(--primary-color)" />
                    <span>Xuất file Text (.txt)</span>
                  </button>
                  <button
                    className="dropdown-item"
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      handleDownloadDocx();
                    }}
                  >
                    <FileDown size={15} color="var(--success-color)" />
                    <span>Xuất file Word (.docx)</span>
                  </button>
                </div>
              )}
            </div>

            <div className="header-divider" />

            <button
              className="btn-icon"
              onClick={() => setIsAppLogsModalOpen(true)}
              title="Nhật ký Hệ thống"
            >
              <AlertCircle size={18} />
            </button>

            <button
              className="btn-icon"
              onClick={() => setIsPromptLogsModalOpen(true)}
              title="Nhật ký Prompt"
            >
              <MessageSquareQuote size={18} />
            </button>

            <button
              className="btn-icon"
              onClick={() => setIsSettingsModalOpen(true)}
              title="Cài đặt Ứng dụng"
            >
              <Settings size={18} />
            </button>

            <button
              className="btn-icon"
              onClick={() => setIsHelpModalOpen(true)}
              title="Hướng dẫn sử dụng"
            >
              <HelpCircle size={18} />
            </button>

            <button
              className="btn-icon"
              onClick={() => setTheme(prev => prev === 'light' ? 'dark' : 'light')}
              title={theme === 'dark' ? 'Chuyển sang giao diện Sáng' : 'Chuyển sang giao diện Tối'}
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>

            <div className="header-divider" />
            <button
              className="btn-icon"
              onClick={() => setIsRightSidebarOpen(!isRightSidebarOpen)}
              title={isRightSidebarOpen ? "Ẩn thanh bên phải" : "Hiện thanh bên phải"}
            >
              {isRightSidebarOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
            </button>
          </div>
        </header>
      )}

      {/* MAIN CONTAINER */}
      <div className="app-container" style={{ height: isFocusMode ? "calc(100vh - 2rem)" : undefined }}>
        {/* LEFT SIDEBAR */}
        {!isFocusMode && isLeftSidebarOpen && (
          <>
            <aside className="sidebar" style={{ width: `${sidebarWidth}px` }}>
              <div className="sidebar-nav-tabs">
                <button
                  className={`sidebar-tab-btn ${activeSidebarTab === 'rules' ? 'active' : ''}`}
                  onClick={() => setActiveSidebarTab('rules')}
                >
                  <span>📜 Quy tắc</span>
                </button>
                <button
                  className={`sidebar-tab-btn ${activeSidebarTab === 'batch' ? 'active' : ''}`}
                  onClick={() => setActiveSidebarTab('batch')}
                >
                  <span>⚡ Batch API</span>
                </button>
                <button
                  className={`sidebar-tab-btn ${activeSidebarTab === 'stats' ? 'active' : ''}`}
                  onClick={() => setActiveSidebarTab('stats')}
                >
                  <span>📊 Thống kê</span>
                </button>
              </div>

              <div className="sidebar-content">
                {activeSidebarTab === 'rules' && (
                  <>
                    <div className="rules-toolbar">
                      <span className="rules-section-title">Thiết lập biên tập</span>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <button
                          className="btn-action-ghost"
                          onClick={insertSampleRules}
                          title="Nạp bộ quy tắc chuẩn mẫu"
                        >
                          Mẫu
                        </button>
                        <button
                          className="btn-action-ghost text-danger"
                          onClick={handleClearRules}
                          title="Xóa trắng quy tắc"
                        >
                          Xóa
                        </button>
                      </div>
                    </div>

                    <div className="input-group">
                      <div className="input-label-row">
                        <label htmlFor="pronoun-rules">Quy tắc Đại từ (Pronouns)</label>
                        <span className="label-hint">Tên: đại từ (ngôi 3 ngoài thoại)</span>
                      </div>
                      <textarea
                        id="pronoun-rules"
                        className="styled-textarea"
                        value={project.pronounRules}
                        onChange={handlePronounRulesChange}
                        placeholder="Hạ Ngôn: cô&#10;Hùng Hùng: anh&#10;Tướng quân Chử: ông"
                        rows={4}
                      />
                    </div>

                    <div className="input-group">
                      <div className="input-label-row">
                        <label htmlFor="addressing-rules">Quy tắc Xưng hô (Addressing)</label>
                        <span className="label-hint">Áp dụng trong thoại ("..." hoặc [...])</span>
                      </div>
                      <textarea
                        id="addressing-rules"
                        className="styled-textarea"
                        value={project.addressingRules}
                        onChange={handleAddressingRulesChange}
                        placeholder="1. Hạ Ngôn ↔ Hùng Hùng: tôi - cậu; tôi - cô.&#10;2. Hạ Ngôn ↔ Tướng quân Chử: tôi - tướng quân; tôi - cô nương."
                        rows={5}
                      />
                    </div>

                    <div className="rules-tips-box">
                      <div className="rules-tips-header">
                        <Sparkles size={14} color="var(--primary-color)" />
                        <span>Lưu ý nghiêm ngặt</span>
                      </div>
                      <p>• Từ ngoại lai sót convert tiếng Trung/Anh sẽ được tự động dịch sang thuần Việt.</p>
                      <p>• Đại từ chỉ sửa ngoài thoại; xưng hô chỉ sửa trong thoại.</p>
                      <p>• Giữ nguyên mọi tên riêng, danh xưng nhân vật gốc.</p>
                    </div>
                  </>
                )}

                {activeSidebarTab === 'stats' && (
                  <>
                    <div className="stats-grid">
                      <div className="stat-card">
                        <span className="stat-card-label">Tổng số chương</span>
                        <span className="stat-card-value">{totalChaptersCount}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Đã biên tập</span>
                        <span className="stat-card-value" style={{ color: 'var(--success-color)' }}>
                          {completedChaptersCount}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Từ bản gốc</span>
                        <span className="stat-card-value">{totalOriginalWords.toLocaleString()}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Từ sau biên</span>
                        <span className="stat-card-value" style={{ color: 'var(--primary-color)' }}>
                          {totalEditedWords.toLocaleString()}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Input Tokens</span>
                        <span className="stat-card-value">{totalInputTokens.toLocaleString('vi-VN')}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Output Tokens</span>
                        <span className="stat-card-value" style={{ color: 'var(--primary-color)' }}>
                          {totalOutputTokens.toLocaleString('vi-VN')}
                        </span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Cache</span>
                        <span className="stat-card-value">{unknownCacheCount ? (totalCachedTokens > 0 ? `≥ ${totalCachedTokens.toLocaleString('vi-VN')}` : '—') : totalCachedTokens.toLocaleString('vi-VN')}</span>
                      </div>
                      <div className="stat-card">
                        <span className="stat-card-label">Chi phí dịch</span>
                        <span className="stat-card-value">{hasUnknownCost ? '—' : formatVnd(totalTranslationCostUsd, exchangeRate)}</span>
                      </div>
                    </div>

                    {activeChapter && (
                      <div style={{ marginTop: '12px' }}>
                        <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-color)' }}>
                          Chương Đang Chọn
                        </div>
                        <div style={{
                          padding: '10px 12px',
                          borderRadius: '8px',
                          backgroundColor: 'var(--sidebar-subtle)',
                          border: '1px solid var(--border-color)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}>
                          <h3 style={{ fontSize: '13px', fontWeight: 700, margin: 0, color: 'var(--text-color)' }}>
                            {activeChapter.title}
                          </h3>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 8px', marginTop: '2px', fontSize: '11.5px' }}>
                            <div>
                              <span style={{ color: 'var(--text-color-muted)' }}>Input: </span>
                              <span style={{ fontWeight: 600 }}>{(activeChapter.inputTokens || 0).toLocaleString('vi-VN')}</span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <span style={{ color: 'var(--text-color-muted)' }}>Output: </span>
                              <span style={{ fontWeight: 600 }}>{(activeChapter.outputTokens || 0).toLocaleString('vi-VN')}</span>
                            </div>
                            <div>
                              <span style={{ color: 'var(--text-color-muted)' }}>Cache: </span>
                              <span style={{ fontWeight: 600 }}>
                                {activeChapter.cachedTokens !== undefined ? activeChapter.cachedTokens.toLocaleString('vi-VN') : '—'}
                              </span>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <span style={{ color: 'var(--text-color-muted)' }}>Chi phí dịch: </span>
                              <span style={{ fontWeight: 600, color: 'var(--warning-color)' }}>
                                {activeChapter.translationCostUsd !== undefined ? formatVnd(activeChapter.translationCostUsd, exchangeRate) : '0 ₫'}
                              </span>
                            </div>
                          </div>

                          <p style={{ fontSize: '11px', margin: '4px 0 2px 0', color: 'var(--text-color-muted)', lineHeight: '1.4' }}>
                            {describeChapterCache(activeChapter)}
                          </p>

                          <div
                            onClick={() => setIsGoogleDetailsOpen(prev => !prev)}
                            style={{
                              cursor: 'pointer',
                              fontWeight: 600,
                              fontSize: '11.5px',
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              marginTop: '4px',
                              userSelect: 'none',
                              color: 'var(--text-color)',
                            }}
                          >
                            <span style={{ fontSize: '10px' }}>{isGoogleDetailsOpen ? '▼' : '►'}</span>
                            <span>Chi tiết phản hồi Google</span>
                          </div>

                          {isGoogleDetailsOpen && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', marginTop: '2px' }}>
                              <div>
                                <span style={{ color: 'var(--text-color-muted)' }}>Model: </span>
                                <span style={{ fontWeight: 500 }}>{activeChapter.cacheObservation?.model || selectedModelName}</span>
                              </div>
                              <div>
                                <span style={{ color: 'var(--text-color-muted)' }}>Lần biên tập: </span>
                                <span style={{ fontWeight: 500 }}>{formatDateTime(activeChapter.cacheObservation?.recordedAt)}</span>
                              </div>
                              <div>
                                <span style={{ color: 'var(--text-color-muted)' }}>Cách gửi: </span>
                                <span style={{ fontWeight: 500 }}>
                                  {activeChapter.cacheObservation?.mode === 'explicit'
                                    ? 'Tham chiếu Explicit Cache'
                                    : activeChapter.cacheObservation?.mode === 'implicit'
                                    ? 'Implicit Cache'
                                    : 'Không dùng Cache'}
                                </span>
                              </div>
                              <div style={{
                                marginTop: '4px',
                                padding: '8px',
                                borderRadius: '6px',
                                backgroundColor: 'var(--paper-bg, rgba(0,0,0,0.05))',
                                border: '1px solid var(--border-color)',
                                fontFamily: 'var(--font-family-mono, monospace)',
                                fontSize: '10px',
                                lineHeight: '1.35',
                                maxHeight: '200px',
                                overflowY: 'auto',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                color: 'var(--text-color)',
                              }}>
                                {JSON.stringify({
                                  usageMetadata: activeChapter.cacheObservation?.usageMetadata || {
                                    promptTokenCount: activeChapter.inputTokens || 0,
                                    candidatesTokenCount: activeChapter.outputTokens || 0,
                                    totalTokenCount: (activeChapter.inputTokens || 0) + (activeChapter.outputTokens || 0),
                                    cachedContentTokenCount: activeChapter.cachedTokens || 0,
                                    trafficType: 'ON_DEMAND',
                                    promptTokensDetails: [
                                      {
                                        modality: 'TEXT',
                                        tokenCount: activeChapter.inputTokens || 0,
                                      },
                                    ],
                                    cacheTokensDetails: activeChapter.cachedTokens ? [
                                      {
                                        modality: 'TEXT',
                                        tokenCount: activeChapter.cachedTokens,
                                      },
                                    ] : [],
                                  },
                                }, null, 2)}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Detailed Per-Chapter Cost List */}
                    <div style={{ marginTop: '14px' }}>
                      <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-color)' }}>
                        Chi Phí & Token Theo Từng Chương
                      </div>
                      <div style={{
                        maxHeight: '240px',
                        overflowY: 'auto',
                        border: '1px solid var(--border-color)',
                        borderRadius: '8px',
                        backgroundColor: 'var(--sidebar-subtle)',
                        padding: '4px',
                      }}>
                        {project.chapters.length === 0 ? (
                          <div style={{ padding: '12px', textAlign: 'center', fontSize: '11px', color: 'var(--text-color-muted)' }}>
                            Chưa có chương nào.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            {project.chapters.map(ch => (
                              <div
                                key={ch.id}
                                onClick={() => setActiveChapterId(ch.id)}
                                style={{
                                  padding: '6px 8px',
                                  borderRadius: '5px',
                                  backgroundColor: ch.id === activeChapterId ? 'var(--chapter-active-bg)' : 'transparent',
                                  border: '1px solid',
                                  borderColor: ch.id === activeChapterId ? 'var(--border-color)' : 'transparent',
                                  cursor: 'pointer',
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  fontSize: '11px',
                                }}
                              >
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1px', overflow: 'hidden' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--text-color)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {ch.title}
                                  </span>
                                  <div style={{ display: 'flex', gap: '6px', color: 'var(--text-color-muted)', fontSize: '10px', flexWrap: 'wrap' }}>
                                    {ch.status === 'done' ? (
                                      <>
                                        <span>In: {(ch.inputTokens || 0).toLocaleString('vi-VN')}</span>
                                        <span>•</span>
                                        <span>Out: {(ch.outputTokens || 0).toLocaleString('vi-VN')}</span>
                                        <span>•</span>
                                        <span>Cache: {(ch.cachedTokens || 0).toLocaleString('vi-VN')}</span>
                                      </>
                                    ) : 'Chưa dịch'}
                                  </div>
                                </div>
                                <div style={{ textAlign: 'right', flexShrink: 0, marginLeft: '8px' }}>
                                  <span style={{ fontWeight: 700, color: ch.status === 'done' ? 'var(--warning-color)' : 'var(--text-color-muted)', fontSize: '11px' }}>
                                    {ch.status === 'done'
                                      ? (ch.translationCostUsd !== undefined ? formatVnd(ch.translationCostUsd, exchangeRate) : '0 ₫')
                                      : '—'}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="stats-exchange-rate">
                      <label htmlFor="stats-exchange-rate">Tỉ giá USD/VNĐ</label>
                      <input
                        id="stats-exchange-rate"
                        className="styled-input"
                        type="number"
                        min="1"
                        step="100"
                        value={exchangeRate}
                        onChange={e => {
                          const val = Number(e.target.value);
                          if (Number.isFinite(val) && val > 0) setExchangeRate(val);
                        }}
                      />
                    </div>

                    <div style={{ marginTop: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                        <span>Tiến độ tổng</span>
                        <span style={{ fontWeight: 600 }}>{progressPercent}%</span>
                      </div>
                      <div className="progress-bar-container">
                        <div className="progress-bar-fill" style={{ width: `${progressPercent}%` }} />
                      </div>
                    </div>

                    {fileName && (
                      <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <button
                          className="btn btn-secondary text-warning"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={handleClearChapters}
                        >
                          <Trash2 size={15} />
                          <span>Xóa danh sách chương (giữ quy tắc)</span>
                        </button>
                        <button
                          className="btn btn-secondary text-danger"
                          style={{ width: '100%', justifyContent: 'center' }}
                          onClick={handleDeleteFile}
                        >
                          <Trash2 size={15} />
                          <span>Xóa toàn bộ dự án hiện tại</span>
                        </button>
                      </div>
                    )}
                  </>
                )}

                {activeSidebarTab === 'batch' && (
                  <BatchSidebarTab
                    chapters={project.chapters}
                    rules={project}
                    title={project.title || fileName}
                    credentials={vertexServiceAccountJson}
                    promptFor={text => getPromptForChapter(text, project)}
                    onImport={handleImportBatch}
                    onOpenModal={() => setIsBatchOpen(true)}
                    onSettings={() => setIsSettingsModalOpen(true)}
                  />
                )}
              </div>

              {activeSidebarTab !== 'batch' && (
                <div className="sidebar-footer">
                  <button
                    className="btn btn-primary btn-large"
                    onClick={handleBulkEdit}
                    disabled={isLoading || project.chapters.length === 0}
                    style={{ width: '100%', justifyContent: 'center' }}
                  >
                    {isLoading ? (
                      <>
                        <div className="loader-small-status" />
                        <span>Đang biên tập truyện...</span>
                      </>
                    ) : (
                      <>
                        <Play size={16} />
                        <span>Biên tập tất cả chưa xong</span>
                      </>
                    )}
                  </button>
                </div>
              )}
            </aside>
            <div className="resizer" onMouseDown={handleMouseDownOnResizer} />
          </>
        )}

        {/* CENTER WORKSPACE */}
        <main className="editor-pane">
          {project.chapters.length === 0 ? (
            /* EMPTY HERO STATE */
            <div className="hero-container">
              <div className="hero-content">
                <div className="hero-badge">
                  <Sparkles size={14} />
                  <span>Nền tảng Biên tập Tiểu thuyết Thông minh</span>
                </div>
                <h1 className="hero-title">Chuẩn Hóa & Trau Chuốt Bản Dịch Tiểu Thuyết</h1>
                <p className="hero-subtitle">
                  Tự động sửa xưng hô nhân vật theo bảng quy tắc, đại từ ngôi thứ ba, và dịch toàn diện các từ ngữ convert sót tiếng Trung/Anh sang tiếng Việt thuần thục.
                </p>

                {/* Dropzone */}
                <div
                  className="hero-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const file = e.dataTransfer.files?.[0];
                    if (file && file.name.endsWith('.txt')) {
                      const reader = new FileReader();
                      reader.onload = (evt) => {
                        const content = evt.target?.result as string;
                        const loaded = parseContentAndSetChapters(content, file.name);
                        if (!loaded) return;
                        setFileName(file.name);
                        addAppLog(`Đã tải lên tệp: ${file.name}`, 'success');
                        showNotification(`Tải tệp "${file.name}" thành công!`, 'success');
                      };
                      reader.readAsText(file, 'UTF-8');
                    } else {
                      showNotification('Vui lòng kéo thả tệp văn bản .txt', 'error');
                    }
                  }}
                >
                  <div className="dropzone-icon">
                    <Upload size={32} />
                  </div>
                  <div className="dropzone-title">Kéo & thả tệp truyện .txt vào đây</div>
                  <div className="dropzone-hint">hoặc nhấn để duyệt tệp từ máy tính của bạn</div>
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginTop: '12px' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    Chọn tệp văn bản
                  </button>
                </div>

                <div className="hero-sample-action">
                  <span style={{ fontSize: '13px', color: 'var(--text-color-muted)' }}>Chưa có tệp truyện sẵn sàng?</span>
                  <button type="button" className="btn btn-secondary" onClick={loadSampleProject}>
                    <Sparkles size={15} color="var(--primary-color)" />
                    <span>Dùng thử với chương truyện mẫu</span>
                  </button>
                </div>

                <div className="hero-features-grid">
                  <div className="feature-card">
                    <div className="feature-icon-badge">
                      <MessageSquareQuote size={20} />
                    </div>
                    <div className="feature-title">Quy tắc Xưng hô Cụ thể</div>
                    <div className="feature-desc">
                      Xử lý câu thoại theo từng cặp nhân vật chuẩn xác (tôi - cậu, huynh - đệ).
                    </div>
                  </div>
                  <div className="feature-card">
                    <div className="feature-icon-badge">
                      <UserCheck size={20} />
                    </div>
                    <div className="feature-title">Chuẩn hóa Đại từ</div>
                    <div className="feature-desc">
                      Tự động gán đúng anh/cô/ông/hắn cho lời dẫn truyện ngoài câu thoại.
                    </div>
                  </div>
                  <div className="feature-card">
                    <div className="feature-icon-badge">
                      <Languages size={20} />
                    </div>
                    <div className="feature-title">Thuần Việt 100%</div>
                    <div className="feature-desc">
                      Xóa bỏ từ convert thô, cụm từ tiếng Trung còn sót thành văn phong mượt mà.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : activeChapter ? (
            /* ACTIVE CHAPTER WORKSPACE */
            <div className="chapter-workspace">
              {/* Action Bar */}
              <div className="chapter-action-bar">
                <div className="chapter-title-group">
                  <input
                    type="text"
                    className="styled-input chapter-title-input"
                    value={activeChapter.title}
                    onChange={e => updateChapter({ ...activeChapter, title: e.target.value })}
                    placeholder="Tiêu đề chương"
                    title="Chỉnh sửa tiêu đề chương"
                  />
                  <span className={`status-pill status-${activeChapter.status}`}>
                    {activeChapter.status === 'ready' && 'Chưa biên tập'}
                    {activeChapter.status === 'editing' && 'Đang biên tập...'}
                    {activeChapter.status === 'done' && 'Đã hoàn thành'}
                  </span>
                </div>

                <div className="chapter-meta-stats">
                  <span className="meta-stat-item">
                    Gốc: <strong>{countWords(activeChapter.originalContent)}</strong> từ
                  </span>
                  {activeChapter.status === 'done' && (
                    <>
                      <span className="meta-stat-divider">→</span>
                      <span className="meta-stat-item highlight">
                        Sau biên: <strong>{countWords(activeChapter.editedContent)}</strong> từ
                      </span>
                    </>
                  )}
                </div>

                <div className="chapter-toolbar-actions">
                  <button
                    className="btn btn-primary"
                    style={{ width: '2.125rem', height: '2.125rem', padding: 0 }}
                    onClick={() => handleReloadChapter(activeChapter.id)}
                    disabled={isLoading}
                    title="Biên tập chương này"
                  >
                    <Sparkles size={16} />
                  </button>

                  <button
                    className="btn-icon"
                    onClick={() => setIsReplaceVisible(prev => !prev)}
                    title="Tìm & Thay thế"
                  >
                    <Search size={16} />
                  </button>

                  <button
                    className="btn-icon"
                    onClick={handleCopyContent}
                    title="Sao chép"
                  >
                    <Copy size={16} />
                  </button>

                  {activeChapter.status === 'done' && (
                    <button
                      className="btn-icon"
                      onClick={handleRevertToOriginal}
                      title="Khôi phục về bản gốc"
                    >
                      <RotateCcw size={15} />
                    </button>
                  )}

                  <button
                    className="btn-icon"
                    onClick={() => setIsFocusMode(prev => !prev)}
                    title={isFocusMode ? "Thoát chế độ tập trung" : "Chế độ tập trung"}
                  >
                    {isFocusMode ? <Minimize size={16} /> : <Maximize size={16} />}
                  </button>
                </div>
              </div>

              {/* Typography Toolbar */}
              <div className="typography-toolbar">
                <div className="typography-controls">
                  <select
                    className="styled-input styled-select small-select"
                    value={editorFont}
                    onChange={handleFontChange}
                    title="Phông chữ"
                  >
                    {fontOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>

                  <select
                    className="styled-input styled-select small-select"
                    value={editorFontSize}
                    onChange={handleFontSizeChange}
                    title="Cỡ chữ"
                  >
                    {fontSizeOptions.map(size => (
                      <option key={size} value={size}>{size}px</option>
                    ))}
                  </select>

                  <select
                    className="styled-input styled-select small-select"
                    value={editorFontWeight}
                    onChange={handleFontWeightChange}
                    title="Độ đậm"
                  >
                    {fontWeightOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                <div className="save-status">
                  {saveStatus === 'saving' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-color-muted)' }}>
                      <div className="loader-small-status" />
                      <span>Đang lưu...</span>
                    </div>
                  )}
                  {saveStatus === 'saved' && lastSaveTime && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--success-color)' }}>
                      <Check size={14} />
                      <span>Đã lưu {lastSaveTime}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Novel Reading & Editing Page */}
              <div ref={readingPageScrollRef} className="reading-page-scroll">
                <div
                  className="paper-sheet"
                  style={{
                    fontFamily: editorFont,
                    fontSize: `${editorFontSize}px`,
                    fontWeight: editorFontWeight
                  }}
                >
                  <div
                    ref={editorRef}
                    className="novel-content-editable"
                    contentEditable
                    suppressContentEditableWarning
                    onInput={(e) => {
                      lastInputHtml.current = e.currentTarget.innerHTML;
                      const newContent = e.currentTarget.innerHTML;
                      updateChapter({
                        ...activeChapter,
                        editedContent: newContent,
                        status: activeChapter.status === 'ready' ? 'done' : activeChapter.status
                      });
                    }}
                    onBlur={(e) => {
                      const newContent = e.currentTarget.innerHTML;
                      if (newContent !== (activeChapter.editedContent || activeChapter.originalContent)) {
                        updateChapter({
                          ...activeChapter,
                          editedContent: newContent
                        });
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="empty-chapter-selection">
              <BookOpen size={48} color="var(--border-color)" />
              <p>Chọn một chương từ mục lục bên phải để bắt đầu biên tập.</p>
            </div>
          )}

          {/* Find & Replace Panel */}
          {isReplaceVisible && (
            <div className="find-replace-panel">
              <div className="panel-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Search size={16} color="var(--primary-color)" />
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>Tìm kiếm & Thay thế</span>
                </div>
                <button className="btn-icon" onClick={() => setIsReplaceVisible(false)}>
                  <X size={15} />
                </button>
              </div>

              <div className="input-group" style={{ marginBottom: '8px' }}>
                <input
                  ref={findInputRef}
                  type="text"
                  className="styled-input"
                  placeholder="Từ cần tìm..."
                  value={findText}
                  onChange={e => setFindText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.ctrlKey) handleReplaceAll();
                  }}
                />
              </div>

              <div className="input-group" style={{ marginBottom: '10px' }}>
                <input
                  type="text"
                  className="styled-input"
                  placeholder="Thay thế bằng..."
                  value={replaceText}
                  onChange={e => setReplaceText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && e.ctrlKey) handleReplaceAll();
                  }}
                />
              </div>

              <div className="replace-options">
                <label>
                  <input
                    type="radio"
                    name="replace-scope"
                    value="current"
                    checked={replaceScope === 'current'}
                    onChange={() => setReplaceScope('current')}
                  />
                  <span>Chỉ chương này</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="replace-scope"
                    value="all"
                    checked={replaceScope === 'all'}
                    onChange={() => setReplaceScope('all')}
                  />
                  <span>Tất cả các chương ({project.chapters.length})</span>
                </label>
              </div>

              <button className="btn btn-primary" onClick={handleReplaceAll} style={{ width: '100%' }}>
                <span>Thay thế tất cả (Ctrl + Enter)</span>
              </button>
            </div>
          )}
        </main>

        {/* RIGHT SIDEBAR */}
        {!isFocusMode && isRightSidebarOpen && (
          <>
            <div className="resizer resizer-right" onMouseDown={handleMouseDownOnRightResizer} />
            <aside className="sidebar sidebar-right" style={{ width: `${rightSidebarWidth}px` }}>
              <div className="chapter-explorer-header">
                <div className="explorer-title-row">
                  <span className="explorer-title">Mục lục chương</span>
                  <span className="explorer-badge">{project.chapters.length} chương</span>
                </div>

                <div className="chapter-search-box">
                  <Search size={14} className="search-icon" />
                  <input
                    type="text"
                    className="chapter-search-input"
                    placeholder="Tìm chương..."
                    value={chapterSearch}
                    onChange={e => setChapterSearch(e.target.value)}
                  />
                  {chapterSearch && (
                    <button className="search-clear-btn" onClick={() => setChapterSearch('')}>
                      <X size={13} />
                    </button>
                  )}
                </div>

                <div className="chapter-filter-chips">
                  <button
                    className={`filter-chip ${chapterFilter === 'all' ? 'active' : ''}`}
                    onClick={() => setChapterFilter('all')}
                  >
                    Tất cả ({project.chapters.length})
                  </button>
                  <button
                    className={`filter-chip ${chapterFilter === 'ready' ? 'active' : ''}`}
                    onClick={() => setChapterFilter('ready')}
                  >
                    Chưa biên ({project.chapters.filter(c => c.status !== 'done').length})
                  </button>
                  <button
                    className={`filter-chip ${chapterFilter === 'done' ? 'active' : ''}`}
                    onClick={() => setChapterFilter('done')}
                  >
                    Đã xong ({completedChaptersCount})
                  </button>
                </div>
              </div>

              <div className="chapter-list-container">
                {filteredChapters.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--text-color-muted)', fontSize: '13px' }}>
                    {project.chapters.length === 0 ? 'Chưa có chương nào được tải.' : 'Không tìm thấy chương phù hợp.'}
                  </div>
                ) : (
                  <ul className="chapter-items-list">
                    {filteredChapters.map(chapter => (
                      <li
                        key={chapter.id}
                        className={`chapter-item-card ${chapter.id === activeChapterId ? 'active' : ''}`}
                        onClick={() => !deletingChapterId && setActiveChapterId(chapter.id)}
                      >
                        {deletingChapterId === chapter.id ? (
                          <div className="chapter-delete-confirm">
                            <span>Xác nhận xóa chương này?</span>
                            <div className="confirm-actions">
                              <button onClick={handleConfirmDeleteChapter} className="btn-confirm-delete">Xóa</button>
                              <button onClick={handleCancelDeleteChapter} className="btn-cancel-delete">Hủy</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <div className="chapter-card-main">
                              <div className="chapter-title-text" title={chapter.title}>
                                {chapter.title}
                              </div>
                              <div className="chapter-card-stats">
                                <span>{countWords(chapter.originalContent)} từ gốc</span>
                                {chapter.status === 'done' && (
                                  <>
                                    <span>•</span>
                                    <span style={{ color: 'var(--success-color)' }}>
                                      {countWords(chapter.editedContent)} từ biên
                                    </span>
                                    {chapter.translationCostUsd !== undefined && (
                                      <>
                                        <span>•</span>
                                        <span style={{ color: 'var(--warning-color)', fontWeight: 600 }}>
                                          {formatVnd(chapter.translationCostUsd, exchangeRate)}
                                        </span>
                                      </>
                                    )}
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="chapter-card-actions">
                              <span className={`status-pill status-${chapter.status}`}>
                                {chapter.status === 'ready' && 'Chuẩn bị'}
                                {chapter.status === 'editing' && 'Đang biên'}
                                {chapter.status === 'done' && 'Xong'}
                              </span>

                              <button
                                className="chapter-reload-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleReloadChapter(chapter.id);
                                }}
                                title="Biên tập lại chương"
                                disabled={isLoading}
                              >
                                <RefreshCw size={13} />
                              </button>

                              <button
                                className="chapter-delete-btn"
                                onClick={(e) => handleStartDeleteChapter(e, chapter.id)}
                                title="Xóa chương"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="sidebar-footer">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', width: '100%' }}>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={handleDownload}
                    disabled={project.chapters.length === 0}
                    style={{ justifyContent: 'center' }}
                  >
                    <FileText size={14} />
                    <span>Tải .TXT</span>
                  </button>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={handleDownloadDocx}
                    disabled={project.chapters.length === 0}
                    style={{ justifyContent: 'center' }}
                  >
                    <FileDown size={14} />
                    <span>Tải .DOCX</span>
                  </button>
                </div>
              </div>
            </aside>
          </>
        )}
      </div>

      {/* FOOTER BAR */}
      <footer className="app-footer-bar">
        <div className="footer-status-left">
          <span className="status-dot" style={{ backgroundColor: 'var(--success-color)' }} />
          <span>Sẵn sàng: {selectedModelName} · {providerLabel}</span>
        </div>

        <div className="footer-status-center">
          {project.chapters.length > 0 && (
            <span>
              {completedChaptersCount}/{totalChaptersCount} chương ({progressPercent}%) • Tổng {totalEditedWords.toLocaleString()} từ
            </span>
          )}
        </div>

        <div className="footer-status-right">
          <span>Beta Batch Web 0.1</span>
        </div>
      </footer>
    </>
  );
}
