import './index.css';
import { BatchPanel } from './BatchPanel';
import { batchRunModel, importDisposition, type BatchRun } from './batch-core';
import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import {
  checkAIConnectionInBrowser, generateAIContentInBrowser, getAIConfigurationError, restoreAPIKeyConfig,
  modelMapping, GLOBAL_VERTEX_MODELS, resolveVertexRegion,
  type AIConnectionConfig, type AIProvider,
} from './ai-browser';
import {
  calculateTranslationUsage, describeChapterCache, formatVnd, restoreTranslationStatistics,
  type CacheObservation,
} from './translation-statistics';
import { inspectVertexArgonCache, type VertexArgonCacheDiagnostic } from './vertex-browser';
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
  Volume2,
  VolumeX,
  X,
  Plus,
  RefreshCw,
  FolderOpen,
  Layers,
  Sliders,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  ChevronDown,
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
interface Chapter {
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

interface Project {
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

interface CompletionModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: CompletionStats | null;
}

// --- CONSTANTS ---
const LOCAL_STORAGE_KEY = 'beta-batch-novel-project-v1';
const EXCHANGE_RATE_KEY = 'translation-usd-vnd-rate';
const DEFAULT_EXCHANGE_RATE = 26_000;
const SOUND_ENABLED_KEY = 'sound-notification-enabled';
const EDITOR_FONT_FAMILY_KEY = 'editor-font-family';
const EDITOR_FONT_SIZE_KEY = 'editor-font-size';
const EDITOR_FONT_WEIGHT_KEY = 'editor-font-weight';
const THEME_KEY = 'app-theme';
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
  { value: 'global', label: 'global (Gemini 4 Argon)' },
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
  { label: 'Roboto', value: "'Roboto', sans-serif" },
  { label: 'Arial', value: 'Arial, sans-serif' },
];

const fontSizeOptions = Array.from({ length: 13 }, (_, i) => 12 + i); // [12, ..., 24]

const fontWeightOptions = [
  { label: 'Bình thường (400)', value: '400' },
  { label: 'Vừa (500)', value: '500' },
  { label: 'Đậm (700)', value: '700' },
];

// --- HELPER FUNCTIONS ---
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

---

### 1️⃣ Trau chuốt & Thuần Việt
* ✅ **Trau chuốt câu từ cho mượt mà, thuần Việt** nhưng vẫn phải **giữ nguyên đúng ý gốc**.
* ✅ Chỉ sửa cấu trúc câu cho thật sự thuần Việt, dễ hiểu, trôi chảy, **không sửa nghĩa**.
* ❌ Tuyệt đối không làm thay đổi ý nghĩa của tác giả.
* ❌ Không thêm thắt tình tiết hoặc thay đổi tính cách nhân vật thông qua cách dùng từ.

---

### 2️⃣ Tên riêng & Ngôi xưng (QUY TẮC NGHIÊM NGẶT)
* ❌ **CẤM TUYỆT ĐỐI:** Không đổi tên riêng thành đại từ (Ví dụ: "Hạ Ngôn" → "cô").
* ❌ **CẤM TUYỆT ĐỐI:** Không đổi đại từ thành tên riêng (Ví dụ: "cô" → "Hạ Ngôn").
* ✅ **CHỈ SỬA:** Đại từ sai (so với quy tắc đại từ/xưng hô đã cung cấp) thành đại từ đúng theo quy tắc đã cung cấp.
* ✅ Giữ nguyên biệt danh, chức danh, tên riêng.
* ✅ Chỉ sửa lỗi chính tả rõ ràng.

---

## 🧩 **BIÊN TẬP ĐẠI TỪ & XƯNG HÔ CHUẨN HÓA (ÁP DỤNG CHO TOÀN TRUYỆN)**

> Khi biên tập, **chỉ sửa các đại từ xưng hô sai** giữa các nhân vật dựa trên **bảng quy tắc xưng hô và đại từ mà tôi cung cấp**.
> Bảng này có thể ở **dạng rút gọn** hoặc **dạng chi tiết** – Gemini phải tự hiểu cả hai.
---
### 🔹 PHẠM VI ÁP DỤNG – ĐẠI TỪ NGÔI THỨ 3

> ✅ **Chỉ sửa đại từ ngôi thứ 3 ở những câu KHÔNG PHẢI là câu thoại** (tức là không nằm giữa dấu ngoặc kép \`" "\` hoặc dấu ngoặc vuông \`[ ]\`).

**Danh sách đại từ ngôi thứ 3 cần kiểm tra và có thể sửa:**  
"cô", "hắn", "anh", "anh ta", "cô ta", "hắn ta", "gã", "ả", "nó", "ông ta", "bà ta",  
"cậu ta", "chị ta", "em ta", "hắn ta", "nàng", "chàng", "gã đàn ông", "người đàn ông", "người phụ nữ",  
"gã kia", "ả kia", "nó ta", "bà ấy", "ông ấy", "lão ta", "mụ ta", "gã đó", "ả đó", "hắn đó"…

**Bắt buộc:**
- 🚫 **Không được sửa đại từ** nếu câu nằm **trong đoạn thoại** (nằm giữa \`" "\` hoặc \`[ ]\`).
- ✅ **Chỉ sửa** nếu đại từ đó sai giới tính hoặc sai quy tắc xưng hô đã định nghĩa.
- ✅ Nếu trong cùng đoạn văn có **tên riêng** → ưu tiên giữ nguyên, không đổi sang đại từ.
- ⚠️ Nếu không chắc → giữ nguyên.

**Ví dụ rõ ràng:**

| Tình huống | Câu gốc | Gemini phải làm |
|------------|----------|----------------|
| Ngoài thoại (được phép sửa) | *Hắn ngẩng đầu nhìn trời, ánh mắt trống rỗng.* | Nếu “hắn” nói về nhân vật nữ, sửa thành “Cô ngẩng đầu nhìn trời…” |
| Trong thoại (bị cấm sửa) | *“Hắn ngẩng đầu nhìn trời,” cô nói.* | ❌ Giữ nguyên, không sửa “hắn” vì nằm trong dấu ngoặc kép |
| Ngoài thoại nhưng sai đại từ | *Cô ta vốn dĩ là một người đàn ông mạnh mẽ.* | ✅ Sửa “Cô ta” → “Anh ta” |
| Ngoài thoại đúng đại từ | *Anh ta thở dài, rồi quay lưng đi.* | ✅ Giữ nguyên, không sửa. |

---

### 📗 **CÁC DẠNG ĐỊNH NGHĨA HỢP LỆ**

#### 🔸 Dạng rút gọn:
Hạ Ngôn ↔ Hùng Hùng: tôi – cậu; tôi – cô.

#### 🔸 Dạng chi tiết:
Hạ Ngôn ↔ Hùng Hùng
Khi Hạ Ngôn nói với Hùng Hùng: Xưng "tôi" (我), gọi Hùng Hùng là "cậu" (你).
Khi Hùng Hùng nói với Hùng Hùng: Xưng "tôi" (我), gọi Hạ Ngôn là "cô" (你) hoặc “bà chủ" (老板).

Gemini phải **tự động hiểu ý nghĩa tương đương**, nghĩa là:

* Khi Hạ Ngôn nói với Hùng Hùng → xưng “tôi”, gọi “cậu”.
* Khi Hùng Hùng nói với Hùng Hùng → xưng “tôi”, gọi “cô”.

---

### ⚙️ **QUY TẮC ÁP DỤNG CHUNG**

1. **Chỉ sửa khi đại từ xưng hô sai.**
   ✅ “Mày làm gì vậy?” → “Cô làm gì vậy?”
   ❌ “Ê, cô làm gì vậy?” → giữ nguyên.
2. **Không thay tên riêng, biệt danh, chức danh, hoặc danh xưng hợp lệ.**
   ✅ “Bà chủ Hạ” → giữ nguyên.
   ✅ “Tướng quân Chử” → giữ nguyên.
3. **Không đổi qua lại giữa các cách gọi hợp lệ.**
   ❌ Không “ông” → “tướng quân Chử” hoặc ngược lại.
4. **Không thêm, bớt, hoặc sáng tạo cách gọi.**
5. **Không sửa đại từ trong lời miêu tả.**
6. **Không đổi vai nói.**
7. Nếu không chắc → **giữ nguyên bản gốc.**

---

### 💬 **VÍ DỤ ỨNG DỤNG CHUẨN**

**Đoạn gốc:**

> Hạ Ngôn cười như không cười, tay vẫn không ngừng động tác: “Xin chào, hỏi anh là?”
> “Được. Tôi muốn phía sau, nửa phía trước cho ông.”
> “Không.”

**Kết quả đúng:**

> Hạ Ngôn cười như không cười, tay vẫn không ngừng động tác: “Xin chào, hỏi **ông** là?”
> “Được. Tôi muốn phía sau, nửa phía trước cho **ông**.”
> “Không.”

---

### ✅ **TÓM LẠI**

> * Hiểu đúng cả hai form xưng hô (rút gọn & chi tiết).
> * Chỉ sửa đại từ sai, không đổi tên hoặc ngôi.
> * Trau chuốt mượt mà, thuần Việt nhưng giữ nguyên ý.
> * Giữ nguyên dấu câu và cấu trúc đoạn văn.
> * Nếu không chắc → giữ nguyên.

---

### 4️⃣ Không tự thêm hoặc thay đổi ý nghĩa cốt lõi

* ❌ Không thêm các chi tiết miêu tả không có trong gốc như “tay cô”, “ánh mắt hắn”…
* ✅ Giữ nguyên hồn cốt của câu văn.
* ❌ Không thêm trạng ngữ cảm xúc hoặc từ tượng thanh nếu gốc không có.

---

### 5️⃣ Dấu câu

#### 🔹 Dấu chấm (.)

* ❌ Không đổi \`. \` → \`: \` trừ khi **trước lời thoại.**

#### 🔹 Dấu phẩy (,)

* ❌ Không thêm nếu gốc hợp lý.
* ✅ Chỉ thêm khi sai ngữ pháp.
* “Thật ra”, “Vốn dĩ”, “Đương nhiên”, “Có lẽ” → giữ nguyên nếu gốc không có dấu phẩy.
> Khi biên tập, **tuyệt đối KHÔNG được tự ý thêm dấu phẩy (,)** vào câu nếu bản gốc **đã đúng ngữ pháp và rõ nghĩa.**
>
> ❗**Chỉ thêm hoặc sửa dấu phẩy** trong hai trường hợp duy nhất:
>
> 1. Có lỗi chính tả hoặc lỗi ngữ pháp rõ ràng (ví dụ: câu ghép thiếu dấu phẩy bắt buộc theo quy tắc ngữ pháp).
> 2. Có hai mệnh đề độc lập liền kề nhau mà việc thêm dấu phẩy là cần thiết để tránh hiểu nhầm.
>
> ✅ Nếu trạng ngữ hoặc phó từ đầu câu **vốn không có dấu phẩy trong bản gốc** (như “Thật ra”, “Vốn dĩ”, “Đương nhiên”, “Có lẽ”, “Đột nhiên”…), **giữ nguyên đúng như vậy.**
>
> **Ví dụ:**
>
> * ✅ Đúng: *Thật ra những thùng hàng trên cao đối với Chử Vạn Phu cũng không có tác dụng lớn.*
> * ❌ Sai: *Thật ra, những thùng hàng trên cao đối với Chử Vạn Phu cũng không có tác dụng lớn.*
>
> 👉 **Tóm lại:**
>
> * Không được tự ý thêm dấu phẩy để “cải thiện nhịp câu”.
> * Chỉ sửa dấu phẩy nếu có lỗi chính tả thật sự.
> * Nếu không chắc, **giữ nguyên dấu câu gốc.**

#### 🔹 Dấu ngã (~)

* Mọi \`~\`, \`~~\`, \`~~~~\` → thay bằng **một “...”**
* Bỏ khoảng trắng quanh \`~\`.
  ✅ “Ọt ọt ọt~~~” → “Ọt ọt ọt...”
---

### 6️⃣ Cấu trúc “đối với” & “đối xử với”

* ✅ Sửa “đối với … cũng …” → “cũng … với …”
* ❌ Không sửa “đối xử với”.

---

### 7️⃣ Trạng ngữ chỉ thời gian

* ❗**Chỉ được phép đảo các trạng ngữ chỉ thời gian** (diễn tả thời điểm xảy ra hành động) **lên trước chủ ngữ.**
* ❌ Không đảo bất kỳ trạng ngữ nào khác (nguyên nhân, cảm xúc, thái độ, điều kiện, cách thức...).
* ❌ Không đảo các bổ ngữ vị trí/hướng/kết quả như (“lên”, “xuống”, “vào”, “ra”, “trên”, “dưới”, “trước”, “sau”, “bên”, “về”, “tới”…).
* ✅ Ví dụ đúng:
  * \`Tang Du hôm đó mặc một chiếc áo sơ mi mỏng.\` → ✅ \`Hôm đó Tang Du mặc một chiếc áo sơ mi mỏng.\`  
  * \`Hôm nay Hạ Ngôn đến muộn.\` → ✅ \`Hôm nay Hạ Ngôn đến muộn.\`  

---

#### 📘 Các **trạng ngữ chỉ thời gian** phổ biến (Gemini có thể tham khảo)

> **🔹 Theo mốc thời gian cụ thể:**
> - hôm nay  
> - hôm qua  
> - ngày mai  
> - hôm kia  
> - ngày kìa  
> - ngày mốt  
> - năm ngoái  
> - năm nay  
> - năm sau  
> - tháng trước  
> - tháng này  
> - tháng sau  
> - tuần trước  
> - tuần này  
> - tuần sau  
> - sáng nay  
> - sáng hôm đó  
> - trưa hôm đó  
> - tối hôm đó  
> - đêm hôm đó  
> - buổi sáng  
> - buổi trưa  
> - buổi tối  
> - ban đêm  
> - rạng sáng  
> - bình minh  
> - hoàng hôn  

> **🔹 Theo mốc thời gian tương đối:**
> - khi ấy  
> - lúc ấy  
> - khi đó  
> - lúc đó  
> - khi này  
> - lúc này  
> - khi trước  
> - khi sau  
> - vừa nãy  
> - lát nữa  
> - ngay sau đó  
> - trước đó  
> - sau đó  
> - từ đó  
> - dạo đó  
> - hồi đó  
> - khi xưa  
> - ngày xưa  
> - thuở xưa  
> - dạo trước  
> - khi còn nhỏ  
> - khi còn bé  
> - khi trưởng thành  
> - từ bé  
> - từ nhỏ  
> - từ lâu  
> - từ trước đến nay  
> - từ đó về sau  
> - kể từ khi  
> - suốt thời gian qua  

> **🔹 Theo mốc thời gian có điều kiện:**
> - ngay khi  
> - vừa khi  
> - vừa lúc  
> - mỗi khi  
> - đến khi  
> - sau khi  
> - trước khi  
> - cho đến khi  
> - kể từ khi  
> - lúc vừa…  
> - khi vừa…  
> - hễ khi…  

> **🔹 Theo nhịp sinh hoạt hoặc mùa vụ:**
> - sáng sớm  
> - giữa trưa  
> - chiều muộn  
> - nửa đêm  
> - sáng hôm sau  
> - tối hôm qua  
> - ngày kế tiếp  
> - mùa xuân  
> - mùa hè  
> - mùa thu  
> - mùa đông  
> - đầu năm  
> - cuối năm  
> - đầu tháng  
> - cuối tháng  

> **🔹 Theo thời điểm không cụ thể:**
> - dạo này  
> - dạo gần đây  
> - hồi gần đây  
> - lâu rồi  
> - vừa rồi  
> - mới đây  
> - khi ấy  
> - lúc ấy  
> - đôi khi  
> - thỉnh thoảng  
> - đôi lúc  
> - lúc nào đó  
> - một lúc sau  
> - một lát sau  
> - chốc lát sau  
> - lát sau  
> - ít phút sau  
> - ít lâu sau  
> - ngay sau đó  

---

#### ⚙️ Quy tắc tổng quát
> Chỉ đảo khi trạng ngữ đó **diễn tả thời điểm xảy ra hành động** (rõ ràng, xác định được mốc “khi nào”).  
> Tuyệt đối **không đảo trạng ngữ nguyên nhân, cảm xúc, hay đánh giá**.  
> Nếu không chắc là trạng ngữ thời gian — **giữ nguyên** thứ tự câu gốc.  
> ⚠️ **Bổ sung điều kiện nghiêm ngặt:**  
> - **Chỉ được phép đảo khi trạng ngữ chỉ thời gian nằm ngay sau chủ ngữ trong câu gốc.**  
> - **Nếu giữa chủ ngữ và trạng ngữ có bất kỳ từ nào xen vào (ví dụ: “vừa”, “mới”, “đã”, “cũng”, “chỉ”, “thì”, “còn”, v.v.) → tuyệt đối không đảo.**

**Ví dụ:**
- \`Hạ Ngôn hôm đó đến muộn.\` → ✅ \`Hôm đó Hạ Ngôn đến muộn.\`  
- \`Hạ Ngôn vừa hôm đó đến.\` → ❌ Không đảo.  
- \`Hạ Ngôn chỉ hôm nay mới ra ngoài.\` → ❌ Không đảo.  
- \`Hạ Ngôn thì hôm qua đến, còn Tô Mai ở lại.\` → ❌ Không đảo.

---

### 8️⃣ Cụm “nghe thấy … vang lên …”

* ❌ Không tách “ở [địa điểm]” ra đầu câu.
* ✅ Giữ nguyên cấu trúc.

---

### 9️⃣ Không đảo hoặc tách “không ngờ / bất ngờ / chẳng ngờ”

* ✅ Giữ nguyên sau chủ ngữ.
* ❌ Không đưa lên đầu câu.

---

### 10️⃣ Bổ sung quy tắc thay thế dấu ngoặc kép tiếng Trung
> Khi gặp các dấu ngoặc kép tiếng Trung:
> 
> * \`《\` hoặc \`〈\` → thay bằng dấu \`“\`  
> * \`》\` hoặc \`〉\` → thay bằng dấu \`”\`
> 
> ✅ Ví dụ:  
> \`《Bạch Xà Truyện》\` → \`“Bạch Xà Truyện”\`
> 
> ❗Không được thêm hoặc xoá dấu ngoặc kép nếu bản gốc không có.  
> Chỉ thay đúng ký tự theo cặp đối xứng, không thêm dấu kép thừa.

---

### 11 Sửa dấu ,"

> Khi biên tập, hãy sửa đúng quy tắc hội thoại sau:

#### 🔸 **Sửa “,” hoặc “.” trước ngoặc kép (phải cách ngoặc kép 1 dấu cách) thành “: ”**

* **Chỉ sửa** khi sau ngoặc kép là **một câu thoại thật sự** (có chủ ngữ – vị ngữ).
* Nếu sau ngoặc kép chỉ là **âm thanh / từ ngắn / cảm thán** → **giữ nguyên**.

**Ví dụ:**
❌ Sai: *...đập vỡ: “phụt”...*
✅ Đúng: *...đập vỡ, “phụt”...*

#### 🔸 **Sửa ,” hoặc .” thành ...”**

* If trong ngoặc kép là **câu kết thúc bằng cảm thán nhẹ hoặc ngắt nghỉ**, đổi \`,"\` hoặc \`."\` thành \`..."\`.
* After dấu “..."” phải viết hoa nếu mở câu mới.

**Ví dụ:**
✅ *Cô ấy nói: "Thế à,"* → *Cô ấy nói: "Thế à..."*
✅ *Cô ấy nói: "Thế à," đoạn lại nói, "nhưng tôi không muốn."*
→ *Cô ấy nói: "Thế à..." Đoạn lại nói: "Nhưng tôi không muốn."*
✅ *Cô ấy nói: "Thế à," đoạn lại nói. "nhưng tôi không muốn."*
→ *Cô ấy nói: "Thế à..." Đoạn lại nói: "Nhưng tôi không muốn."*

**Tóm tắt:**

* \`,"\` → \`..."\`
* \`, "\` → \`: "\` (chỉ nếu sau là câu thoại)
* \`. "\` → \`: "\` (chỉ nếu sau là câu thoại)
* After \`"..."\` → viết hoa.
* Không sửa nếu là từ tượng thanh (*“á”, “ha”, “phụt”…*).
* Không sửa nếu câu trong dấu "" không có dấu kết câu ("mời", "nói"...)

---
#### 🔸 **Sửa “,” hoặc “.” trước [ thành “:”**

* **Chỉ sửa** khi sau [ là **một câu thoại thật sự** (có chủ ngữ – vị ngữ).
* Nếu sau [ chỉ là **âm thanh / từ ngắn / cảm thán** → **giữ nguyên**.

**Ví dụ:**
❌ Sai: *...đập vỡ: [phụt]...*
✅ Đúng: *...đập vỡ, [phụt]...*

#### 🔸 **Sửa ,] hoặc .” thành ...]**

* Nếu trong [] là **câu kết thúc bằng cảm thán nhẹ hoặc ngắt nghỉ**, đổi \`,]\` thành \`...]\`.
* After dấu “...]” phải viết hoa nếu mở câu mới.

**Ví dụ:**
✅ *Cô ấy nói: [Thế à,]* → *Cô ấy nói: [Thế à...]*
✅ *Cô ấy nói: [Thế à,] đoạn lại nói, [nhưng tôi không muốn.]*
→ *Cô ấy nói: [Thế à...] Đoạn lại nói: [Nhưng tôi không muốn.]*

**Tóm tắt:**

* \`,]\` → \`...]\`
* \`. [\` → \`: [\` (chỉ nếu sau là câu thoại)
* After \`[...]\` → viết hoa.
* Không sửa nếu là từ tượng thanh (*[á], [ha], [phụt]…*).
* Không sửa nếu câu trong dấu [] không có dấu kết câu ([mời], [nói]...)
* Không sửa dấu “ thành [ hay ]

---

### 12️⃣ Không đổi ngôi hoặc chủ thể nói

* ❌ Không đổi “chúng tôi” ↔ “tôi”.
* ✅ Giữ nguyên số ngôi, vai trò.

---

## 🔄 **CÁC QUY TẮC CHỈNH NGỮ PHÁP BỔ SUNG**

---

### 🔸 Sửa cấu trúc **“đem xxx làm gì đó”** → **“làm gì xxx”**

✅ “Anh ta lại đem đồ đặt xuống.” → “Anh ta lại đặt đồ xuống.”

Chỉ áp dụng khi:

* Từ “đem” (hoặc “mang”, “bưng”, “xách”) + danh từ + động từ hành động.
* Không áp dụng nếu “đem” là hành động độc lập (*đem đồ đến nhà cô ấy* → giữ nguyên).

---

### 🔸 Sửa cấu trúc **[chủ ngữ] trong lòng** → **trong lòng [chủ ngữ]**

✅ “Tang Du trong lòng bực bội.” → “Trong lòng Tang Du bực bội.”
✅ “Mọi người và Tang Chính Dịch trong lòng bực bội.” → “Trong lòng mọi người và Tang Chính Dịch bực bội.”
❗Chỉ sửa khi “trong lòng” đứng **ngay sau chủ ngữ**.
❌ Không sửa: “Hạ Ngôn cười thầm, trong lòng vui mừng.”

---

### 🔸 Sửa cấu trúc **[chủ ngữ] chẳng lẽ...** → **Chẳng lẽ [chủ ngữ]...**

✅ “Bà cô này, chẳng lẽ đang trả thù mình...” → “Chẳng lẽ bà cô này đang trả thù mình...”
❗Chỉ áp dụng khi “chẳng lẽ” đứng **ngay sau chủ ngữ**.
❌ Không sửa nếu “chẳng lẽ” nằm xa chủ ngữ.

---

### 🔸 Sửa cấu trúc **dùng xxx làm gì đó** → **làm gì đó bằng xxx**

✅ “Cô ấy dùng giọng trịch thượng nói: ‘Thôi vậy.’” → “Cô ấy nói bằng giọng trịch thượng: ‘Thôi vậy.’”

---

### 🔸 Sửa cấu trúc **Cái gì cũng không xxx** → **Không xxx gì**

✅ “Bên trong Tang Du cái gì cũng không mặc.” → “Bên trong Tang Du không mặc gì.”
✅ “Cái gì cũng không che.” → “Không che gì.”

---

### 🔸 Sửa cấu trúc **một chút cũng không xxx** → **không xxx gì**

✅ “Tang Du một chút cũng không hiểu.” → “Tang Du không hiểu gì.”

---

### 🔸 Sửa dấu kết thúc sai

* \`...?, \`!\`..., \`?...!\` → chỉ giữ một dấu duy nhất: \`.\` hoặc \`!\` tùy ngữ cảnh.
  ✅ “Anh ta nghĩ...?” → “Anh ta nghĩ...”
  ✅ “Thật ra thì...!” → “Thật ra thì...”
  ✅ “Nói rồi?...” → “Nói rồi!”

---

### 🔸 BẮT BUỘC DỊCH CÁC TỪ KHÔNG PHẢI TIẾNG VIỆT

Nếu trong câu có bất kỳ từ/đoạn **tiếng Trung, Anh, Nhật...**, BẮT BUỘC phải **dịch nghĩa ra tiếng Việt**.
Ví dụ:
❌ “nghiêm陣以待” → ✅ “đang nghiêm chỉnh giằng trận”.
❌ “bánh窩窝頭” → ❌ “bánh wōwōtóu” → ✅ “bánh ngô hấp”

---

### 🔸 Sửa cấu trúc **[chủ ngữ] + cụm mô tả + này/đó/kia** → **cụm mô tả + [chủ ngữ] + này/đó/kia**

✅ “Tang Du đồ đần này” → “Đồ đần Tang Du này.”

---

### 🔸 Sửa cấu trúc **[nhân vật] + bọn họ** → **[nhân vật] và mọi người**

✅ “Tang Du bọn họ nói gì chẳng hiểu.” → “Tang Du và mọi người nói chẳng hiểu gì.”
❗Chỉ sửa khi “bọn họ / các cô ấy / các anh ấy” đứng **ngay sau nhân vật.**

---

### 🔸 Sửa cấu trúc **Đại từ, [nhân vật], vị ngữ** → **[nhân vật] + đại từ + vị ngữ**

✅ “Tôi, Tang Du, định làm gì kệ tôi.” → “Tang Du tôi định làm gì kệ tôi.”

---

### 🔸 Bỏ cụm “— người” hoặc “, người”

✅ “Tang Du — người từ nãy đến giờ vẫn im lặng.” → “Tang Du nãy giờ vẫn im lặng.”
✅ “Chu Cẩn Ngôn, người mãi không nói gì.” → “Chu Cẩn Ngôn mãi không nói gì.”
❗Chỉ bỏ nếu “người” dùng để mô tả lại chính chủ ngữ ngay trước đó.

---

### 🔸 Bỏ dấu phẩy trước “thì” (trừ các cụm đặc biệt)

✅ Bỏ dấu phẩy nếu từ “thì” đứng một mình:
“Tang Du nghe thế, thì bực lắm.” → “Tang Du nghe thế thì bực lắm.”
❌ Không bỏ nếu “thì” đi với từ “thầm”, “ra”, “sao”.

---

### 🔸 Bỏ dấu “—” ở giữa câu, thay bằng dấu “,”

✅ “Tang Du và chị gái cô ta — không biết vì sao—ở đây zombie rất ít...”
→ “Tang Du và chị gái cô ta, không biết vì sao, ở đây zombie rất ít...”

---

### 🔸 Không tự ý thêm dấu * nếu bản gốc không có

---

## ⚙️ **CÁC QUY TẮC MỚI BỔ SUNG (CẬP NHẬT NGÀY 09/10/2025)**

---

### 🔸 0️⃣ **Không tự ý sửa đại từ/xưng hô nếu không có trong quy tắc**

> Nếu một nhân vật **không xuất hiện trong “Quy tắc Đại từ” hoặc “Quy tắc Xưng hô”**,  
> thì **tuyệt đối KHÔNG được thay đổi, thêm hoặc sửa** bất kỳ đại từ hay cách xưng hô nào liên quan đến nhân vật đó.

**Ví dụ:**
* Nếu trong quy tắc không có "Tang Du" → giữ nguyên "ông ta", "bà ta", "hắn", "nó", v.v.  
* Không được tự ý đổi "ông ta" → "anh ta", "hắn" → "cậu ta", v.v.  
* Chỉ được sửa nếu **tên nhân vật đó có trong danh sách quy tắc.**

👉 **Tóm lại:**  
Nếu nhân vật **không nằm trong danh sách quy tắc đại từ hoặc quy tắc xưng hô**, Gemini phải **giữ nguyên toàn bộ đại từ/xưng hô** trong câu gốc.

---

### 🔸 1️⃣ **Không tự ý viết hoa giữa câu**

> Khi biên tập, Gemini tuyệt đối **không được tự ý viết hoa** từ nằm **sau dấu phẩy (,), chấm phẩy (;) hoặc các liên từ nối câu** trừ khi đó là **tên riêng hoặc đầu câu mới**.

**Ví dụ:**
* “Thế này à, vốn dĩ không đúng.” ✅ (giữ nguyên)
* ❌ Sai: “Thế này à, Vốn dĩ không đúng.”
* “Cô ấy nói, hôm đó Tang Du đi vắng.” ✅  
* ❌ Sai: “Cô ấy nói, Hôm đó Tang Du đi vắng.”

👉 **Tóm lại:**
* Chỉ viết hoa sau dấu chấm (.), dấu chấm hỏi (?) hoặc dấu chấm than (!)
* Không viết hoa sau dấu phẩy hoặc trong giữa câu, trừ khi là tên riêng.

---

### 🔸 2️⃣ **Không được thêm dấu \`*\`, \`**\`, \`_\` hoặc ký hiệu Markdown**

> Khi biên tập, Gemini không được tự thêm các ký tự định dạng như:
> \`*\`, \`**\`, \`_\`, \`__\`, \`~\`, hoặc các ký hiệu tương tự vào kết quả.

**Ví dụ:**
* ❌ Sai: \`**Cô** chỉ đùa thôi.\`  
* ✅ Đúng: \`Cô chỉ đùa thôi.\`

👉 **Tóm lại:**
* Kết quả đầu ra phải là **văn bản thuần túy (plain text)**.  
* If thấy ký tự định dạng trong bản gốc thì **giữ nguyên**,  
  còn nếu không có → **không tự thêm vào**.

---

### 🔸 1️⃣ **Không được tự ý thay thế tên riêng hoặc biệt danh bằng đại từ ngôi thứ ba**

> Khi biên tập, **chỉ được sửa đại từ ngôi thứ ba (hắn, anh ta, cô ta, cậu ta, v.v.) nếu rõ ràng sai ngữ cảnh.**
>
> If bản gốc đang dùng **tên riêng, biệt danh, hoặc danh xưng hợp lệ** → **tuyệt đối không thay bằng đại từ.**

**Ví dụ:**

* ✅ Giữ nguyên:
  “Cậu bé ngơ ngác, không hiểu hai người đang nói gì.”
  ❌ Sai: “Cậu ta ngơ ngác, không hiểu hai người đang nói gì.”
* ✅ Giữ nguyên:
  “Hạ Ngôn tỉnh dậy trong ánh bình minh, thoải mái lăn một vòng trong chăn…”
  ❌ Sai: “Cô tỉnh dậy trong ánh bình minh, thoải mái lăn một vòng trong chăn…”

👉 **Tóm lại:**

* Không thay tên riêng, biệt danh, hoặc danh xưng bằng đại từ ngôi 3.
* Chỉ sửa đại từ nếu rõ ràng **sai quy tắc xưng hô** hoặc **lặp ngôi gây lỗi cú pháp.**

---

### 🔸 2️⃣ **Không tự ý thêm dấu câu ngay sau dấu ngoặc kép mở hoặc đóng**

> Khi biên tập, **không được thêm dấu phẩy hoặc bất kỳ dấu câu nào sau dấu “ hoặc trước dấu ”**
> nếu bản gốc không có.

**Ví dụ:**

* ✅ Giữ nguyên: “Bộp” một tiếng, một vật đẫm máu từ trong miệng cô ta văng ra.
* ❌ Sai: “Bộp”, một tiếng, một vật đẫm máu từ trong miệng cô ta văng ra.
* ❌ Sai: “Bộp.” một tiếng…

👉 **Tóm lại:**

* Không thêm dấu phẩy, chấm, hay bất kỳ dấu câu nào **ngay sau “ hoặc ngay trước ”** nếu câu gốc không có.
* Chỉ sửa nếu dấu câu gốc **rõ ràng sai chuẩn chính tả tiếng Việt.**

---

## ⚙️ **QUY TẮC MỚI BỔ SUNG – KHẮC PHỤC LỖI ĐẠI TỪ NGÔI THỨ 3**

### 🔸 **Không được tự ý thay thế tên riêng / biệt danh / danh xưng bằng đại từ ngôi thứ ba**

> Khi biên tập, Gemini **tuyệt đối không được thay thế các tên riêng, biệt danh, danh xưng, hoặc mô tả nhân vật hợp lệ** bằng **đại từ ngôi thứ ba** như “cô”, “hắn”, “nó”, “anh ta”, “cậu ta”, “cô ta”, “bà ta”, “ông ta”, “gã”, “ả”, v.v.
>
> Chỉ được sửa khi đại từ đó **rõ ràng sai ngữ cảnh hoặc sai quy tắc xưng hô**, còn lại phải **giữ nguyên văn bản gốc.**

---

### 💡 **Giải thích cụ thể để Gemini hiểu đúng:**

1. **Tên riêng, biệt danh, danh xưng hợp lệ** gồm:

   * Họ tên đầy đủ: *Hạ Ngôn*, *Tang Du*, *Chử Vạn Phu*...
   * Biệt danh / chức danh: *Bà chủ Hạ*, *Tướng quân Chử*, *Quản lý Hùng Hùng*, *Lâm đội trưởng*...
   * Cụm mô tả nhân vật: *Người đàn ông trung niên*, *Cô gái áo đỏ*, *Thiếu niên kia*, *cậu bé*, *ông cụ*, *bà cụ*, *ông lão*, *bà lão*, *ông già*, *bà già*...

2. **Đại từ ngôi 3 cần bị chặn:**
   "cô", "hắn", "nó", "anh ta", "cậu ta", "cô ta", "bà ta", "ông ta", "gã", "ả", v.v.

3. **Quy tắc áp dụng:**

   * If gốc có tên riêng hoặc danh xưng → **giữ nguyên**, không đổi thành đại từ.
   * If đại từ gốc sai (ví dụ "hắn" nói về nữ) → **sửa đúng ngữ cảnh**, nhưng **không đổi tên riêng thành đại từ.**
   * If có cả tên riêng and đại từ trong cùng câu → **giữ nguyên cả hai**, không lược bỏ tên riêng.

---

### 📘 **Ví dụ cụ thể để Gemini hiểu chính xác:**

| **Trường hợp**                     | **Câu gốc**                                        | **Gemini phải làm**                                 | **Cấm làm (Sai)**            |
| ---------------------------------- | -------------------------------------------------- | --------------------------------------------------- | ---------------------------- |
| Tên riêng → giữ nguyên             | Hạ Ngôn tỉnh dậy trong ánh bình minh...            | ✅ Giữ nguyên: *Hạ Ngôn tỉnh dậy...*                 | ❌ Sai: *Cô tỉnh dậy...*      |
| Mô tả nhân vật → giữ nguyên        | Cậu bé ngơ ngác, không hiểu hai người đang nói gì. | ✅ Giữ nguyên: *Cậu bé ngơ ngác...*                  | ❌ Sai: *Cậu ta ngơ ngác...*  |
| Biệt danh / chức danh → giữ nguyên | Bà chủ Hạ đứng dậy nhìn quanh.                     | ✅ Giữ nguyên: *Bà chủ Hạ...*                        | ❌ Sai: *Cô đứng dậy...*      |
| Đại từ gốc sai ngữ cảnh → sửa đúng | Hắn chạy đến ôm cô. (nói về nhân vật nữ)           | ✅ Sửa thành *Cô chạy đến ôm anh* (nếu đúng xưng hô) | ❌ Không đổi *Hạ Ngôn* → *cô* |

---

### 🧠 **Mẹo cho Gemini khi xử lý ngữ cảnh đại từ:**

1. If thấy **tên riêng hoặc danh xưng rõ ràng → ưu tiên giữ lại.**
2. If có cả **tên riêng and đại từ trong cùng câu → không xóa, không thay thế.**
3. If tên riêng lặp trong đoạn → **chỉ rút gọn bằng đại từ ngôi 3** khi có hướng dẫn cụ thể trong quy tắc xưng hô.
4. Khi nghi ngờ → **giữ nguyên bản gốc, không thay đổi.**

---

### ✅ **Tóm lại cho Gemini**

> * **Trau chuốt câu từ mượt mà, thuần Việt** nhưng giữ nguyên ý tưởng gốc.
> * **Luôn trau chuốt câu từ cho mượt mà, thuần Việt nhưng vẫn giữ nguyên đúng ý, chỉ sửa cấu trúc câu cho thật sự thuần Việt, không sửa nghĩa.**
> * Không được tự ý thay thế tên riêng, biệt danh, danh xưng hợp lệ bằng đại từ.
> * Chỉ sửa đại từ ngôi 3 khi rõ ràng sai ngữ cảnh.
> * Giữ nguyên bản gốc nếu không chắc.

---

--- QUY TẮC ĐẠI TỪ CỤ THỂ ---
Đây là các quy tắc về đại từ nhân xưng ngôi thứ 3. Định dạng là "Tên nhân vật: đại từ". Bạn phải đảm bảo khi nhắc đến nhân vật đó ở ngôi thứ 3, đại từ được sử dụng phải chính xác theo quy tắc.
Ví dụ: Nếu quy tắc là "Hạ Ngôn: cô", thì câu "Bà ta không muốn nói thêm" khi đang nói về Hạ Ngôn phải được sửa thành "Cô không muốn nói thêm".
⚠️ **Lưu ý đặc biệt về từ "mình":**
> Từ **"mình"** không phải là đại từ nhân xưng, mà là đại từ phản thân hoặc chỉ thân thể.  
> → **Tuyệt đối không được thay "mình" bằng đại từ của nhân vật.**

**Ví dụ:**
- \`Cô ấy ôm lấy mình.\` → ✅ Giữ nguyên  
  (❌ Không được sửa thành: \`Cô ấy ôm lấy cô.\`)
  ---
### 🚫 QUY TẮC NGHIÊM NGẶT – KHÔNG ĐƯỢC THAY TÊN RIÊNG HOẶC BIỆT DANH BẰNG ĐẠI TỪ

> ⚠️ Đây là lỗi nghiêm trọng nhất cần tuyệt đối tránh.  
> Gemini không được phép thay thế **tên riêng**, **biệt danh**, **chức danh**, hoặc **mô tả nhân vật hợp lệ** bằng **đại từ ngôi thứ ba** (cô, hắn, anh ta, cậu ta, v.v.).

**Các loại tên/danh xưng phải GIỮ NGUYÊN:**

- Họ tên thật: *Hạ Ngôn*, *Tang Du*, *Chử Vạn Phu*, *Tô Mai*, *Bạch Tá*...
- Biệt danh / chức danh: *Bà chủ Hạ*, *Tướng quân Chử*, *Quản lý Hùng Hùng*, *Lâm đội trưởng*...
- Mô tả nhân vật: *Cậu bé*, *Người đàn ông trung niên*, *Cô gái áo đỏ*, *Ông cụ*, *Bà cụ*, *Thiếu niên kia*...

**Các đại từ bị cấm thay thế:**

> “cô”, “hắn”, “anh ta”, “cô ta”, “bà ta”, “ông ta”, “nó”, “gã”, “ả”, “cậu ta”, “chị ta”, “hắn ta”, “nàng”, “chàng”, “mụ ta”, “lão ta”, v.v.

---

### 🔒 Quy tắc áp dụng:

- If trong câu đã có **tên riêng / biệt danh / chức danh / mô tả nhân vật**,  
  👉 **giữ nguyên y hệt, không đổi sang đại từ.**.
- If đại từ gốc sai giới tính, **chỉ sửa đại từ đó**, KHÔNG đổi phần tên riêng.
- If có cả tên riêng and đại từ trong cùng câu → giữ nguyên cả hai, không lược bỏ tên riêng.
- If bản gốc chỉ có tên riêng, không có đại từ → giữ nguyên, không thêm đại từ.

---

### 📘 Ví dụ minh họa:

| Trường hợp | Câu gốc | Được phép làm | Bị cấm |
|-------------|----------|----------------|--------|
| Tên riêng | *Hạ Ngôn tỉnh dậy trong ánh bình minh.* | ✅ Giữ nguyên *Hạ Ngôn* | ❌ “Cô tỉnh dậy trong ánh bình minh.” |
| Biệt danh | *Bà chủ Hạ nhìn quanh.* | ✅ Giữ nguyên *Bà chủ Hạ* | ❌ “Cô nhìn quanh.” |
| Mô tả nhân vật | *Cậu bé ngơ ngác nhìn quanh.* | ✅ Giữ nguyên *Cậu bé* | ❌ “Cậu ta ngơ ngác nhìn quanh.” |
| Đại từ sai giới tính | *Hắn bước vào (nói về nhân vật nữ)* | ✅ Sửa *Hắn* → *Cô* | ❌ Không được thay *Hạ Ngôn* → *Cô* |

---

### 🔐 Ghi nhớ bắt buộc:

> * If có nghi ngờ — giữ nguyên tên riêng gốc.  
> * Tuyệt đối không “rút gọn” hoặc “tự nhiên hóa” bằng cách thay tên riêng thành đại từ.  
> * Vi phạm quy tắc này xem như **lỗi biên tập nghiêm trọng**.
${project.pronounRules}
--- HẾT QUY TẮC ĐẠI TỪ CỤ THỂ ---

--- BẢNG QUY TẮC XƯNG HÔ CỤ THỂ ---
Đây là quy tắc xưng hô khi các nhân vật đối thoại. Bạn phải tuân thủ chặt chẽ theo các quy tắc đã nêu ở trên.
${project.addressingRules}
---
### 🔹 PHẠM VI ÁP DỤNG – XƯNG HÔ

> ✅ **Chỉ sửa cách xưng hô trong CÂU THOẠI** (nằm giữa dấu ngoặc kép \`" "\` hoặc dấu ngoặc vuông \`[ ]\`).

**Bắt buộc:**
- ✅ Chỉ áp dụng sửa xưng hô **trong câu thoại** giữa các nhân vật.
- 🚫 Không được sửa hoặc thêm xưng hô trong **câu miêu tả, câu tường thuật** (ngoài dấu ngoặc kép).
- 🚫 Không thay đổi xưng hô trong lời kể của người thứ ba.

**Ví dụ:**

| Tình huống | Câu gốc | Gemini phải làm |
|------------|----------|----------------|
| Trong thoại (được phép sửa) | *“Cậu đang làm gì vậy?” Hạ Ngôn hỏi.* | ✅ Sửa “Cậu” theo quy tắc nếu sai (ví dụ: “Cô đang làm gì vậy?”) |
| Ngoài thoại (bị cấm sửa) | *Hạ Ngôn hỏi cậu đang làm gì.* | ❌ Giữ nguyên, không sửa “cậu”. |
| Trong thoại với ngoặc vuông | *[Anh có nghe thấy không?]* | ✅ Sửa “Anh” nếu sai xưng hô. |
| Ngoài thoại | *Tang Du nghĩ, hắn có nghe thấy không?* | ❌ Không sửa “hắn”, vì nằm ngoài thoại. |
--- HẾT BẢNG QUY TẮC XƯNG HÔ CỤ THỂ ---

--- VĂN BẢN GỐC CẦN BIÊN TẬP ---
${chapterContent}
--- HẾT VĂN BẢN GỐC ---

Hãy trả về duy nhất nội dung đã được biên tập.
`;
};
// --- CAPITALIZATION LOGIC ---
const capitalizeSentences = (text: string) => {
    if (!text) return text;

    // 0) Sau dấu ... CHỈ thêm cách nếu ký tự tiếp theo là chữ
    text = text.replace(/\.{3}([A-Za-zÀ-ỹ])/g, (m, p1) => `... ${p1.toUpperCase()}`);

    // 1) Viết hoa sau dấu . ? !
    text = text.replace(
        /([.!?])\s+([a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳỵỷỹđ])/g,
        (match, p1, p2) => p1 + " " + p2.toUpperCase()
    );

    // 2) Viết hoa chữ đầu trong "..." chỉ khi có dấu kết
    text = text.replace(/"([^"]+)"/g, (match, inner) => {
        if (!/[.!?…]$/.test(inner.trim())) return match; 
        return `"${inner.charAt(0).toUpperCase() + inner.slice(1)}"`;
    });

    // 3) Viết hoa chữ đầu trong [...] chỉ khi có dấu kết
    text = text.replace(/\[([^\]]+)\]/g, (match, inner) => {
        if (!/[.!?…]$/.test(inner.trim())) return match; 
        return `[${inner.charAt(0).toUpperCase() + inner.slice(1)}]`;
    });

    // 4) Viết hoa đầu đoạn (sau xuống dòng)
    text = text.replace(
        /(^|\n)([a-zàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳỵỷỹđ])/g,
        (match, p1, p2) => p1 + p2.toUpperCase()
    );

    // --- NEW LOGIC ---
    // A1) If dấu , dính sát " → thành ...
    text = text.replace(/,"/g, '..."');

    // A2) If dấu , dính sát ] → thành ...
    text = text.replace(/,]/g, '...]');

    // B1) Chỉ đổi , → : trước " khi CÓ khoảng trắng (để tránh xung đột case A)
    text = text.replace(
        /,(\s+)"([^"]*[.!?…])"/g,
        (match, space, inner) =>
            `:${space}"${inner.charAt(0).toUpperCase() + inner.slice(1)}"`
    );

    // B2) Chỉ đổi , → : trước [ khi CÓ khoảng trắng
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
    // Clamp index to be within bounds
    const safeIndex = Math.max(0, Math.min(index, text.length));
    const terminators = ['.', '!', '?', '\n', '…'];
    let start = -1;

    // Find the last terminator before or at the start of the change
    for (const t of terminators) {
      const lastIdx = text.lastIndexOf(t, safeIndex - 1);
      if (lastIdx > start) {
        start = lastIdx;
      }
    }
    // If no terminator found before, start is 0. Otherwise, start is after the terminator.
    start = (start === -1) ? 0 : start + 1;

    let end = text.length;
    // Find the first terminator after the change
    for (const t of terminators) {
      // Look for terminator starting from the current position
      const firstIdx = text.indexOf(t, safeIndex);
      if (firstIdx !== -1 && firstIdx < end) {
        end = firstIdx;
      }
    }
    // The end of the sentence is at the terminator.
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

// --- MODAL COMPONENTS ---
const CompletionModal: React.FC<CompletionModalProps> = ({ isOpen, onClose, stats }) => {
  if (!isOpen || !stats) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: '440px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Biên Tập Hoàn Tất</h2>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
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
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--primary-color)' }}>{stats.totalChapters}</div>
            </div>
            <div style={{ backgroundColor: 'var(--card-bg)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-color-muted)' }}>Lượt gọi AI</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--success-color)' }}>{stats.totalRequests}</div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Xác nhận & Xem kết quả</button>
        </div>
      </div>
    </div>
  );
};

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const HelpModal: React.FC<HelpModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" style={{ maxWidth: '680px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <HelpCircle size={20} color="var(--primary-color)" />
            <h2>Hướng Dẫn Sử Dụng</h2>
          </div>
          <button className="btn-icon" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p>Tham khảo prompt để xem hướng dẫn sử dụng chi tiết.</p>
        </div>
      </div>
    </div>
  );
};

export const App: React.FC = () => {
  const [isBatchOpen, setIsBatchOpen] = useState(false);
  // STATE DEFINITIONS HERE
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [notification, setNotification] = useState<Notification | null>(null);
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(true);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(true);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [isAppLogsModalOpen, setIsAppLogsModalOpen] = useState(false);
  const [fileName, setFileName] = useState('');
  const [project, setProject] = useState<Project>({ title: '', pronounRules: '', addressingRules: '', chapters: [] });
  const [exchangeRate, setExchangeRate] = useState(() => {
    const saved = Number(localStorage.getItem(EXCHANGE_RATE_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_EXCHANGE_RATE;
  });
  const [argonCacheDiagnostic, setArgonCacheDiagnostic] = useState<VertexArgonCacheDiagnostic | null>(null);
  const [isCheckingArgonCache, setIsCheckingArgonCache] = useState(false);
  const argonCacheCheckRef = useRef<AbortController | null>(null);
  
  const [selectedModelName, setSelectedModelName] = useState('Gemini 4 Argon');
  const [provider, setProvider] = useState<AIProvider>('vertex-ai');
  const [vertexApiKey, setVertexApiKey] = useState('');
  const [vertexApiKeyProjectId, setVertexApiKeyProjectId] = useState('');
  const [vertexProjectId, setVertexProjectId] = useState('');
  const [vertexRegion, setVertexRegion] = useState('us-central1');
  const [vertexServiceAccountJson, setVertexServiceAccountJson] = useState('');
  const [vertexServiceAccountEmail, setVertexServiceAccountEmail] = useState('');
  const [vertexKeyFileName, setVertexKeyFileName] = useState('');
  const [vertexKeyError, setVertexKeyError] = useState('');
  const [isAIConfigLoaded, setIsAIConfigLoaded] = useState(false);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
  const [connectionTestResult, setConnectionTestResult] = useState<{status: 'success' | 'error', message: string} | null>(null);
  const [isSoundEnabled, setIsSoundEnabled] = useState(false);
  const [isCompletionModalOpen, setIsCompletionModalOpen] = useState(false);
  const [completionStats, setCompletionStats] = useState<CompletionStats | null>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState('rules');
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
  
  const [isPromptLogsModalOpen, setIsPromptLogsModalOpen] = useState(false);
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
          // Requests from a previous page session cannot still be running.
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
      } catch(e) {
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
        setVertexApiKey(keyConfig.vertexApiKey);
        setVertexApiKeyProjectId(keyConfig.vertexApiKeyProjectId);
        if (config.selectedModelName && Object.hasOwn(modelMapping, config.selectedModelName)) {
          setSelectedModelName(config.selectedModelName);
        }
        setVertexRegion(config.vertexRegion || 'us-central1');
        const savedServiceAccountJson = typeof config.vertexServiceAccountJson === 'string'
          ? config.vertexServiceAccountJson
          : '';
        if (savedServiceAccountJson) {
          const credentials = JSON.parse(savedServiceAccountJson);
          if (
            credentials?.type !== 'service_account'
            || !credentials.project_id
            || !credentials.client_email
            || !credentials.private_key
          ) {
            throw new Error('Service Account Key đã lưu không còn hợp lệ.');
          }
          setVertexProjectId(credentials.project_id);
          setVertexServiceAccountEmail(credentials.client_email);
          setVertexServiceAccountJson(savedServiceAccountJson);
          setVertexKeyFileName(config.vertexKeyFileName || 'service-account.json');
        } else {
          // Older versions only persisted display metadata, not the actual key.
          setVertexProjectId('');
          setVertexServiceAccountEmail('');
          setVertexKeyFileName('');
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
      vertexApiKey,
      vertexApiKeyProjectId,
      selectedModelName,
      vertexProjectId,
      vertexRegion: vertexRegion || 'us-central1',
      vertexServiceAccountEmail,
      vertexKeyFileName,
      vertexServiceAccountJson,
    };
    sessionStorage.setItem(AI_CONNECTION_CONFIG_KEY, JSON.stringify(config));
  }, [
    isAIConfigLoaded,
    provider,
    vertexApiKey,
    vertexApiKeyProjectId,
    selectedModelName,
    vertexProjectId,
    vertexRegion,
    vertexServiceAccountEmail,
    vertexKeyFileName,
    vertexServiceAccountJson,
  ]);

  useEffect(() => {
    setConnectionTestResult(null);
    setIsCheckingConnection(false);
    return () => {
      // Cancel checks for the previous configuration and ignore their late results.
      connectionCheckRef.current?.abort();
      connectionCheckRef.current = null;
    };
  }, [provider, vertexApiKey, vertexApiKeyProjectId, selectedModelName, vertexProjectId, vertexRegion, vertexServiceAccountJson]);

  useEffect(() => {
    const modelId = modelMapping[selectedModelName];
    if (provider === 'vertex-ai' && GLOBAL_VERTEX_MODELS.has(modelId) && vertexRegion !== 'global') {
      setVertexRegion('global');
    }
  }, [provider, selectedModelName, vertexRegion]);

  const aiConnectionConfig: AIConnectionConfig = {
    provider, vertexApiKey, vertexApiKeyProjectId, selectedModelName, vertexProjectId, vertexRegion,
    vertexServiceAccountEmail, vertexKeyFileName, vertexServiceAccountJson,
  };
  const providerLabel = provider === 'vertex-api-key' ? 'Vertex AI (API Key)' : 'Vertex AI (file JSON)';
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
          // The Standard tariff must never be applied to an asynchronous Batch response.
          translationCostUsd: undefined,
          cacheObservation: {
            model: batchRunModel(run),
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
    const value = event.target.value;
    setProject(prev => ({ ...prev, pronounRules: value }));
  };

  const handlePronounRulesBlur = (event: React.FocusEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setProject(prev => prev.pronounRules === value ? prev : { ...prev, pronounRules: value });
  };

  const handleAddressingRulesChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setProject(prev => ({ ...prev, addressingRules: value }));
  };
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
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error('Trình duyệt từ chối truy cập Clipboard.');
      }
      showNotification('Đã sao chép nội dung chương!', 'success');
    } catch (error) {
      console.error('Không thể sao chép nội dung:', error);
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
    const value = event.target.value;
    setEditorFont(value);
    localStorage.setItem(EDITOR_FONT_FAMILY_KEY, value);
  };

  const handleFontSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = Number(event.target.value);
    if (!Number.isFinite(value)) return;
    setEditorFontSize(value);
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(value));
  };

  const handleFontWeightChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value;
    setEditorFontWeight(value);
    localStorage.setItem(EDITOR_FONT_WEIGHT_KEY, value);
  };
const [rightSidebarWidth, setRightSidebarWidth] = useState(300);
  
  const addAppLog = (message: string, type: 'success'|'error'|'info') => {
    setAppLogs(prev => [{id: Math.random().toString(), timestamp: new Date().toISOString(), type, message}, ...prev]);
  };

  const showNotification = (
    message: string,
    type: 'success'|'error',
    durationMs = 3000,
    syncErrorToLog = true,
  ) => {
    if (notificationTimeoutRef.current !== null) {
      window.clearTimeout(notificationTimeoutRef.current);
    }
    setNotification({message, type});
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
    } catch (error) {
      console.warn('Trình duyệt không thể phát âm báo:', error);
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
          throw new Error('Tệp không phải Service Account Key hợp lệ (cần type, project_id, client_email và private_key).');
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
        const message = err.message || 'Lỗi khi đọc tệp JSON.';
        setVertexKeyError(message);
        addAppLog(`Không thể nạp Service Account Key: ${message}`, 'error');
      }
    };
    reader.onerror = () => {
      setVertexProjectId('');
      setVertexServiceAccountEmail('');
      setVertexServiceAccountJson('');
      setVertexKeyFileName('');
      setConnectionTestResult(null);
      setVertexKeyError('Không thể đọc tệp JSON đã chọn.');
      addAppLog('Không thể đọc tệp Service Account Key đã chọn.', 'error');
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
      showNotification('Không kiểm tra được Cache Argon. Xem Nhật ký ứng dụng.', 'error');
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
      const message = aiConfigurationError;
      setConnectionTestResult({ status: 'error', message });
      showNotification(message, 'error');
      return;
    }
    const modelId = modelMapping[selectedModelName];
    if (!modelId) {
      const message = `Không tìm thấy Model ID cho ${selectedModelName}.`;
      setConnectionTestResult({ status: 'error', message });
      showNotification(message, 'error');
      return;
    }
    const controller = new AbortController();
    connectionCheckRef.current = controller;
    const timeoutId = window.setTimeout(() => {
      controller.abort(new Error('Kiểm tra kết nối quá thời gian chờ (2 phút). Vui lòng thử lại.'));
    }, CONNECTION_CHECK_TIMEOUT_MS);
    setIsCheckingConnection(true);
    setConnectionTestResult(null);
    const connectionTarget = provider === 'vertex-ai'
      ? `${modelId}, ${resolveVertexRegion(modelId, vertexRegion)}` : `${modelId}, global`;
    addAppLog(`Đang kiểm tra ${providerLabel} với model ${connectionTarget}...`, 'info');
    try {
      await checkAIConnectionInBrowser(aiConnectionConfig, modelId, controller.signal);
      if (connectionCheckRef.current !== controller) return;
      const message = `Kết nối ${providerLabel} thành công (${connectionTarget}).`;
      setConnectionTestResult({ status: 'success', message });
      addAppLog(message, 'success');
      showNotification(`Kết nối ${providerLabel} thành công!`, 'success');
    } catch (err: any) {
      if (connectionCheckRef.current !== controller) return;
      const message = formatAIErrorMessage(controller.signal.aborted ? controller.signal.reason : err, 'Kết nối thất bại.');
      setConnectionTestResult({ status: 'error', message });
      addAppLog(`Kiểm tra ${providerLabel} thất bại: ${message}`, 'error');
      showNotification(`Kết nối ${providerLabel} thất bại: ${message}`, 'error', 10_000, false);
    } finally {
      window.clearTimeout(timeoutId);
      if (connectionCheckRef.current === controller) {
        connectionCheckRef.current = null;
        setIsCheckingConnection(false);
      }
    }
  };

  const handleCancelConnectionCheck = () => {
    connectionCheckRef.current?.abort();
    connectionCheckRef.current = null;
    setIsCheckingConnection(false);
    setConnectionTestResult(null);
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
        addAppLog(`Không thể tải tệp trống: ${file.name}`, 'error');
        showNotification('Tệp văn bản đang trống.', 'error', 3000, false);
        return;
      }
      const loaded = parseContentAndSetChapters(content, file.name);
      if (!loaded) return;
      setFileName(file.name);
      addAppLog(`Đã tải lên tệp: ${file.name}`, 'success');
      showNotification(`Tải tệp "${file.name}" thành công!`, 'success');
    };
    reader.onerror = () => {
      addAppLog(`Không thể đọc tệp: ${file.name}`, 'error');
      showNotification('Đã xảy ra lỗi khi đọc tệp.', 'error', 3000, false);
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
  
  const activeChapter = project.chapters.find(c => c.id === activeChapterId);

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
    let activeTooltipGroup = '';

    const hideTooltip = () => {
      activeTooltipGroup = '';
      tooltip.style.display = 'none';
      tooltip.replaceChildren();
    };

    const getChangeGroupKey = (changeMark: HTMLElement): string => (
      changeMark.dataset.changeGroup
      || `legacy-sentence-${changeMark.dataset.sentence || ''}`
    );

    const renderTooltip = (mark: HTMLElement) => {
      const groupId = getChangeGroupKey(mark);
      const availableMarks = Array.from(
        editor.querySelectorAll('mark.diff-change'),
      ) as HTMLElement[];
      const groupMarks = availableMarks.filter(candidate => getChangeGroupKey(candidate) === groupId);
      const anchorMark = groupMarks[0] || mark;
      const originalSentence = anchorMark.dataset.sentence || anchorMark.dataset.original || '';
      tooltip.replaceChildren();

      interface TooltipAnnotation {
        text: string;
        offset: number;
        pointLabel?: string;
      }

      const appendSentence = (
        labelText: string,
        sentence: string,
        annotations: TooltipAnnotation[],
      ) => {
        const label = document.createElement('strong');
        label.textContent = labelText;
        tooltip.appendChild(label);

        const normalizedAnnotations = annotations
          .map(annotation => {
            const preferredOffset = Number.isFinite(annotation.offset)
              ? Math.max(0, Math.min(annotation.offset, sentence.length))
              : 0;
            if (!annotation.text) return { ...annotation, offset: preferredOffset };
            const exactOffset = sentence.slice(
              preferredOffset,
              preferredOffset + annotation.text.length,
            ) === annotation.text
              ? preferredOffset
              : sentence.indexOf(annotation.text);
            return exactOffset >= 0 ? { ...annotation, offset: exactOffset } : null;
          })
          .filter((annotation): annotation is TooltipAnnotation => annotation !== null)
          .filter((annotation, index, all) => all.findIndex(candidate => (
            candidate.offset === annotation.offset
            && candidate.text === annotation.text
            && candidate.pointLabel === annotation.pointLabel
          )) === index)
          .sort((left, right) => left.offset - right.offset || right.text.length - left.text.length);

        let cursor = 0;
        normalizedAnnotations.forEach(annotation => {
          if (annotation.offset < cursor) return;
          tooltip.appendChild(document.createTextNode(sentence.slice(cursor, annotation.offset)));
          if (annotation.text) {
            const highlightedChange = document.createElement('span');
            highlightedChange.className = 'tooltip-highlight';
            highlightedChange.textContent = annotation.text;
            tooltip.appendChild(highlightedChange);
            cursor = annotation.offset + annotation.text.length;
          } else {
            const changePoint = document.createElement('span');
            changePoint.className = 'tooltip-insertion-point';
            changePoint.setAttribute('aria-label', annotation.pointLabel || 'Vị trí thay đổi');
            tooltip.appendChild(changePoint);
            cursor = annotation.offset;
          }
        });
        tooltip.appendChild(document.createTextNode(sentence.slice(cursor)));

        if (!sentence && normalizedAnnotations.length === 0) {
          tooltip.appendChild(document.createTextNode('(không có nội dung)'));
        }
      };

      const originalAnnotations: TooltipAnnotation[] = [];
      groupMarks.forEach(groupMark => {
        const kind = groupMark.dataset.changeKind;
        const originalText = groupMark.dataset.original || '';
        const originalOffset = Number(groupMark.dataset.originalOffset);

        originalAnnotations.push(kind === 'insertion'
          ? { text: '', offset: originalOffset, pointLabel: 'Vị trí AI thêm' }
          : { text: originalText, offset: originalOffset });
      });

      appendSentence(
        'Nội dung gốc: ',
        originalSentence,
        originalAnnotations,
      );
      activeTooltipGroup = groupId;
      tooltip.style.display = 'block';
    };

    const positionTooltip = (clientX: number, clientY: number) => {
      const margin = 10;
      const offset = 14;
      const rect = tooltip.getBoundingClientRect();
      const left = Math.min(
        window.innerWidth - rect.width - margin,
        Math.max(margin, clientX + offset),
      );
      const top = Math.min(
        window.innerHeight - rect.height - margin,
        Math.max(margin, clientY + offset),
      );
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
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
      const groupKey = getChangeGroupKey(mark);
      if (activeTooltipGroup !== groupKey) {
        renderTooltip(mark);
      }
      positionTooltip(event.clientX, event.clientY);
    };

    const handleFocusIn = (event: FocusEvent) => {
      const mark = findChangeMark(event.target);
      if (!mark) return;
      const groupKey = getChangeGroupKey(mark);
      if (activeTooltipGroup !== groupKey) {
        renderTooltip(mark);
      }
      const rect = mark.getBoundingClientRect();
      positionTooltip(rect.right, rect.bottom);
    };

    editor.addEventListener('mousemove', handleMouseMove);
    editor.addEventListener('mouseleave', hideTooltip);
    editor.addEventListener('focusin', handleFocusIn);
    editor.addEventListener('focusout', hideTooltip);

    return () => {
      editor.removeEventListener('mousemove', handleMouseMove);
      editor.removeEventListener('mouseleave', hideTooltip);
      editor.removeEventListener('focusin', handleFocusIn);
      editor.removeEventListener('focusout', hideTooltip);
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
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
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
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
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
      addAppLog('Tệp không có nội dung chương hợp lệ.', 'error');
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
      const message = 'Không tìm thấy chương cần biên tập.';
      addAppLog(message, 'error');
      return { success: false, message };
    }
    if (aiConfigurationError) {
      const message = aiConfigurationError;
      addAppLog(`Không thể biên tập "${chapter.title}": ${message}`, 'error');
      if (reportFailure) showNotification(message, 'error', 10_000, false);
      setIsSettingsModalOpen(true);
      return { success: false, message, fatal: true };
    }

    const modelId = modelMapping[selectedModelName];
    if (!modelId) {
      const message = `Không tìm thấy Model ID cho ${selectedModelName}.`;
      addAppLog(`Không thể biên tập "${chapter.title}": ${message}`, 'error');
      if (reportFailure) showNotification(message, 'error', 10_000, false);
      return { success: false, message, fatal: true };
    }

    const prompt = getPromptForChapter(chapter.originalContent, project);
    if (!isRetry) {
      setPromptLogs(prev => [{
        id: `${Date.now()}-${Math.random()}`,
        timestamp: new Date().toISOString(),
        chapterTitle: chapter.title,
        prompt,
        model: selectedModelName,
      }, ...prev].slice(0, 200));
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
      if (response.cacheWarning) addAppLog(response.cacheWarning, 'error');
      const cacheLabel = response.cacheMode === 'explicit' ? 'Explicit Cache'
        : response.cacheMode === 'implicit' ? 'Implicit Cache' : 'Cache';
      addAppLog(`${cacheLabel} "${chapter.title}": ${describeChapterCache({ cachedTokens: cachedTokens ?? undefined, cacheObservation })} usageMetadata: ${JSON.stringify(cacheObservation.usageMetadata)}`, 'info');
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
      const logPrefix = isRetry ? 'Lỗi khi thử lại' : 'Lỗi khi biên tập';
      addAppLog(`${logPrefix} "${chapter.title}": ${details.message}`, 'error');
      if (reportFailure) {
        showNotification(details.message || 'Dịch vụ AI không thể tạo nội dung.', 'error', 10_000, false);
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
    setSaveStatus('');
    setLastSaveTime(null);
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
    let stoppedMessage = '';
    try {
      chapterQueue: for (const chapter of pendingChapters) {
        let lastResult: ChapterEditResult = { success: false };
        const maximumAttempts = BULK_EDIT_RETRY_DELAYS_MS.length + 1;

        for (let attemptIndex = 0; attemptIndex < maximumAttempts; attemptIndex += 1) {
          if (attemptIndex > 0) {
            const fallbackDelay = BULK_EDIT_RETRY_DELAYS_MS[attemptIndex - 1];
            const retryDelay = lastResult.retryAfterMs ?? fallbackDelay;
            const retrySeconds = Math.max(1, Math.ceil(retryDelay / 1000));
            const retryMessage = `"${chapter.title}" gặp lỗi tạm thời. Tự thử lại lần ${attemptIndex + 1}/${maximumAttempts} sau ${retrySeconds} giây.`;
            addAppLog(retryMessage, 'info');
            showNotification(retryMessage, 'error', Math.max(3_000, Math.min(10_000, retryDelay)), false);
            await waitFor(retryDelay);
          }

          totalRequests += 1;
          lastResult = await handleReloadChapter(
            chapter.id,
            false,
            false,
            attemptIndex > 0,
          );

          if (lastResult.success) {
            completed += 1;
            continue chapterQueue;
          }

          const failureMessage = lastResult.message || 'Dịch vụ AI không thể tạo nội dung.';
          if (lastResult.fatal) {
            failedChapters.push({ id: chapter.id, title: chapter.title, message: failureMessage });
            stoppedMessage = `Lỗi cấu hình hoặc phân quyền tại "${chapter.title}": ${failureMessage}`;
            addAppLog(stoppedMessage, 'error');
            break chapterQueue;
          }

          const canRetry = lastResult.retryable && attemptIndex < maximumAttempts - 1;
          if (canRetry) continue;

          failedChapters.push({ id: chapter.id, title: chapter.title, message: failureMessage });
          const skipMessage = lastResult.retryable
            ? `"${chapter.title}" vẫn lỗi sau ${maximumAttempts} lần thử: ${failureMessage} Đã bỏ qua và tiếp tục chương kế tiếp.`
            : `Không thể biên tập "${chapter.title}": ${failureMessage} Đã bỏ qua và tiếp tục chương kế tiếp.`;
          addAppLog(skipMessage, 'error');
          showNotification(skipMessage, 'error', 10_000, false);
          continue chapterQueue;
        }
      }
    } catch (error: any) {
      stoppedMessage = `Tiến trình gặp lỗi ngoài dự kiến: ${error?.message || String(error)}`;
      addAppLog(stoppedMessage, 'error');
    } finally {
      setIsLoading(false);
    }

    if (stoppedMessage) {
      const summary = `Đã dừng sau ${completed}/${pendingChapters.length} chương. ${stoppedMessage}`;
      addAppLog(summary, 'error');
      showNotification(summary, 'error', 15_000, false);
      if (failedChapters[0]) setActiveChapterId(failedChapters[0].id);
      return;
    }

    if (failedChapters.length > 0) {
      const summary = `Đã chạy hết danh sách: ${completed} chương thành công, ${failedChapters.length} chương lỗi. Các chương lỗi vẫn ở trạng thái Chưa biên.`;
      addAppLog(summary, 'error');
      showNotification(summary, 'error', 15_000, false);
      setActiveChapterId(failedChapters[0].id);
      return;
    }

    addAppLog(`Đã xử lý ${completed}/${pendingChapters.length} chương với ${totalRequests} request.`, 'success');
    if (completed === pendingChapters.length) {
      showNotification(`Đã xử lý ${completed} chương.`, 'success');
      setCompletionStats({ totalChapters: project.chapters.length, totalRequests });
      setIsCompletionModalOpen(true);
      playCompletionSound();
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
      <BatchPanel open={isBatchOpen} onClose={() => setIsBatchOpen(false)}
        onSettings={() => setIsSettingsModalOpen(true)}
        chapters={project.chapters} rules={project} title={project.title || fileName}
        credentials={vertexServiceAccountJson}
        promptFor={text => getPromptForChapter(text, project)}
        onImport={handleImportBatch} />
      <HelpModal isOpen={isHelpModalOpen} onClose={() => setIsHelpModalOpen(false)} />
      <CompletionModal
        isOpen={isCompletionModalOpen}
        onClose={() => setIsCompletionModalOpen(false)}
        stats={completionStats}
      />
      
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
                    <div key={log.id} style={{ padding: '8px', borderLeft: `4px solid ${log.type === 'error' ? 'var(--error-color)' : log.type === 'success' ? 'var(--success-color)' : 'var(--primary-color)'}`, backgroundColor: 'var(--bg-color-secondary)', borderRadius: '4px' }}>
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
                      <div style={{ fontSize: '13px', backgroundColor: 'var(--bg-color-secondary)', padding: '8px', borderRadius: '4px', whiteSpace: 'pre-wrap' }}>
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
                <h2>Cài Đặt</h2>
              </div>
              <button className="btn-icon" onClick={() => setIsSettingsModalOpen(false)}><X size={18} /></button>
            </div>
            <div className="modal-body" style={{ overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', paddingBottom: '16px' }}>
                {/* SECTION 1: AI CONFIGURATION */}
                <section>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-color)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Sparkles size={16} color="var(--primary-color)" />
                    Cấu hình Trí tuệ Nhân tạo (AI)
                  </h3>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="input-group">
                      <label htmlFor="modal-provider-select">Provider / AI Service</label>
                      <select
                        id="modal-provider-select"
                        className="styled-input styled-select"
                        value={provider}
                        onChange={e => setProvider(e.target.value as AIProvider)}
                      >
                        <option value="vertex-ai">Vertex AI / Agent Platform — file JSON</option>
                        <option value="vertex-api-key">Vertex AI / Agent Platform — dán API Key</option>
                      </select>
                    </div>

                    <div className="input-group">
                      <label htmlFor="modal-model-select">Mô Hình AI</label>
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

                    <div style={{ padding: '16px', backgroundColor: 'var(--bg-color-secondary)', borderRadius: '8px', border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <div className={`vertex-status-banner ${connectionTestResult?.status === 'success' ? 'connected' : 'unconfigured'}`} style={{ marginTop: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          {connectionTestResult?.status === 'success'
                            ? <CheckCircle2 size={14} />
                            : <AlertCircle size={14} />}
                          {connectionTestResult?.status === 'success'
                            ? `Đã kết nối ${providerLabel}${provider === 'vertex-ai' ? ` (${vertexProjectId})` : ''}`
                            : !isAIConfigLoaded
                              ? `${providerLabel}: Đang khôi phục cấu hình đã lưu...`
                            : isAIConfigured
                              ? `Đã nạp cấu hình ${providerLabel} — chưa kiểm tra kết nối`
                              : `${providerLabel}: ${provider === 'vertex-api-key' ? 'Cần nhập API Key' : 'Cần nạp Service Account Key'}`}
                        </span>
                      </div>

                      {provider === 'vertex-api-key' ? (
                      <>
                        <div className="input-group">
                          <label htmlFor="vertex-api-key">Vertex AI API Key</label>
                          <div className="file-picker-row">
                            <input
                              id="vertex-api-key"
                              type="password"
                              className="styled-input"
                              value={vertexApiKey}
                              onChange={e => setVertexApiKey(e.target.value.trim())}
                              placeholder="Dán API Key từ Google Cloud Console (AIza...)"
                              autoComplete="off"
                              spellCheck={false}
                              style={{ flex: 1, minWidth: 0 }}
                            />
                            {vertexApiKey && (
                              <button type="button" className="btn-icon" title="Xóa Vertex AI API Key" onClick={() => setVertexApiKey('')}>
                                <X size={14} />
                              </button>
                            )}
                          </div>
                          <span className="label-hint">API key dùng cho biên tập trực tiếp. Batch API cần file Service Account JSON. Khóa chỉ lưu trong phiên tab.</span>
                          <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="label-hint">
                            Quản lý API Key trong Google Cloud Console
                          </a>
                        </div>
                        <div className="input-group">
                          <label htmlFor="vertex-api-key-project">Project ID của API Key (không bắt buộc)</label>
                          <input
                            id="vertex-api-key-project"
                            type="text"
                            className="styled-input"
                            value={vertexApiKeyProjectId}
                            onChange={e => setVertexApiKeyProjectId(e.target.value.trim())}
                            placeholder="Mã dự án Google Cloud của key"
                            autoComplete="off"
                            spellCheck={false}
                          />
                          <span className="label-hint">Có thể để trống để thử kết nối chỉ bằng key. Điền mã dự án nếu dùng key cho project riêng hoặc muốn tạo Explicit Cache cho model hỗ trợ. Argon dùng implicit cache.</span>
                        </div>
                      </>
                      ) : (
                      <>
                      {/* Service Account Key (JSON) */}
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
                        {vertexServiceAccountJson && (
                          <span className="label-hint">Khóa chỉ lưu trong phiên tab; mở phiên mới cần nạp lại. Không đưa file khóa lên GitHub.</span>
                        )}
                        {vertexKeyError && (
                          <span className="label-hint" style={{ color: 'var(--error-color)' }}>{vertexKeyError}</span>
                        )}
                      </div>

                      {/* Project ID */}
                      <div className="input-group">
                        <div className="input-label-row">
                          <label htmlFor="vertex-project-id">Project ID</label>
                          <span className="label-hint">Tự động điền từ JSON</span>
                        </div>
                        <input
                          id="vertex-project-id"
                          type="text"
                          className="styled-input"
                          value={vertexProjectId}
                          readOnly
                          placeholder="Sẽ xuất hiện khi nạp tệp JSON"
                          style={{ backgroundColor: 'var(--bg-color)', color: 'var(--text-color-muted)' }}
                        />
                      </div>

                      {/* Region / Location */}
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
                      </>
                      )}

                      {/* Test Connection */}
                      <div className="input-group" style={{ marginTop: '8px' }}>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={handleTestConnection}
                          disabled={isCheckingConnection || !isAIConfigLoaded}
                          style={{ width: '100%', justifyContent: 'center' }}
                        >
                          <RefreshCw size={14} className={isCheckingConnection ? 'icon-spin' : ''} />
                          <span>{isCheckingConnection ? 'Đang kiểm tra kết nối...' : `Kiểm tra kết nối ${providerLabel}`}</span>
                        </button>
                        {isCheckingConnection && (
                          <button type="button" className="btn btn-secondary" onClick={handleCancelConnectionCheck}>
                            <X size={14} /> Hủy kiểm tra kết nối
                          </button>
                        )}
                        {connectionTestResult && (
                          <div className={`vertex-status-banner ${connectionTestResult.status === 'success' ? 'connected' : 'unconfigured'}`}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {connectionTestResult.status === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                              {connectionTestResult.message}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <div style={{ height: '1px', backgroundColor: 'var(--border-color)', margin: '4px 0' }} />

                {/* SECTION 2: GENERAL SETTINGS */}
                <section>
                  <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-color)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Settings size={16} color="var(--primary-color)" />
                    Cài đặt chung
                  </h3>
                  
                  <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <label style={{ marginBottom: 2, display: 'block', fontWeight: 500, fontSize: '13px' }}>Âm Báo Hoàn Thành</label>
                      <div style={{ fontSize: '12px', color: 'var(--text-color-muted)' }}>Phát âm thanh tinh tế khi AI biên tập xong 1 chương</div>
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
                </section>

              </div>
            </div>
            <div className="modal-footer" style={{ position: 'sticky', bottom: 0, backgroundColor: 'var(--bg-color)', zIndex: 10, borderTop: '1px solid var(--border-color)' }}>
              <button className="btn" onClick={() => setIsSettingsModalOpen(false)}>Lưu & Đóng</button>
            </div>
          </div>
        </div>
      )}

      {notification && (
        <div className={`notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* --- WEBSITE HEADER NAVBAR --- */}
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
          <button className="btn btn-primary" onClick={() => setIsBatchOpen(true)}><Layers size={16} /> Batch API</button>
          {/* File Upload Hidden Input */}
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

          {/* Export Dropdown Popover */}
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
              <div
                className="export-dropdown-menu"
                style={{
                  position: 'absolute',
                  top: '100%',
                  right: 0,
                  marginTop: '6px',
                  backgroundColor: 'var(--card-bg)',
                  border: '1px solid var(--border-color)',
                  borderRadius: '8px',
                  boxShadow: 'var(--shadow-md)',
                  zIndex: 200,
                  minWidth: '180px',
                  padding: '6px'
                }}
              >
                <button
                  className="dropdown-item"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 12px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-color)',
                    fontSize: '13px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderRadius: '6px'
                  }}
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
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    width: '100%',
                    padding: '8px 12px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-color)',
                    fontSize: '13px',
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderRadius: '6px'
                  }}
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
            title="Hướng dẫn sử dụng & Quy tắc"
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

      <div className="app-main-layout">


      {/* --- WEBSITE MAIN APPLICATION CONTAINER --- */}
      <div className="app-container" style={{ height: isFocusMode ? "calc(100vh - 2rem)" : undefined }}>
        {/* --- LEFT SIDEBAR (TOOLS & RULES) --- */}
        {!isFocusMode && isLeftSidebarOpen && (
          <>
            <aside className="sidebar" style={{ width: `${sidebarWidth}px` }}>
              {/* Navigation Tabs */}
          <div className="sidebar-nav-tabs">
            <button
              className={`sidebar-tab-btn ${activeSidebarTab === 'rules' ? 'active' : ''}`}
              onClick={() => setActiveSidebarTab('rules')}
            >
              <span>📜 Quy tắc</span>
            </button>
            <button
              className={`sidebar-tab-btn ${activeSidebarTab === 'stats' ? 'active' : ''}`}
              onClick={() => setActiveSidebarTab('stats')}
            >
              <span>📊 Thống kê</span>
            </button>
          </div>

          <div className="sidebar-content">
            {/* TAB 1: RULES */}
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
                    <span className="label-hint">Tên: đại từ (ngôi thứ 3 ngoài thoại)</span>
                  </div>
                  <textarea
                    id="pronoun-rules"
                    className="styled-textarea"
                    value={project.pronounRules}
                    onChange={handlePronounRulesChange}
                    onBlur={handlePronounRulesBlur}
                    placeholder="Hạ Ngôn: cô&#10;Hùng Hùng: anh&#10;Tướng quân Chử: ông"
                    rows={4}
                  />
                </div>

                <div className="input-group">
                  <div className="input-label-row">
                    <label htmlFor="addressing-rules">Quy tắc Xưng hô (Addressing)</label>
                    <span className="label-hint">Chỉ áp dụng trong câu thoại (\"...\" hoặc [...])</span>
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
                  <p>
                    • Mọi từ ngoại lai (tiếng Trung, Anh) chưa dịch như <em>"nghiêm陣以待"</em> sẽ được AI tự động chuyển sang thuần Việt.
                  </p>
                  <p>
                    • Đại từ chỉ đổi ngoài câu thoại. Xưng hô chỉ đổi trong câu thoại.
                  </p>
                </div>


              </>
            )}
            {/* TAB 2: AI PROVIDER / VERTEX AI CONNECTION */}

            {/* TAB 3: STATS & PROJECT */}
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

                {unknownCacheCount > 0 && (
                  <p className="cache-status-note">{unknownCacheCount} chương chưa có số liệu cache được xác nhận. Tổng cache chỉ cộng số token đã ghi nhận.</p>
                )}

                <div style={{ marginTop: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '8px' }}>
                    <span style={{ fontWeight: 600 }}>Chương Đang Chọn</span>
                  </div>
                  {activeChapter ? (
                    <div style={{ padding: '8px', border: '1px solid var(--border-color)', borderRadius: '4px', backgroundColor: 'var(--bg-color-secondary)' }}>
                      <div style={{ fontSize: '13px', fontWeight: 500, marginBottom: '8px', color: 'var(--primary-color)' }}>
                        {activeChapter.title}
                      </div>
                      <div className="chapter-stats-row">
                        <span>Input: {(activeChapter.inputTokens || 0).toLocaleString('vi-VN')}</span>
                        <span>Output: {(activeChapter.outputTokens || 0).toLocaleString('vi-VN')}</span>
                      </div>
                      <div className="chapter-stats-row">
                        <span>Cache: {activeChapter.cachedTokens === undefined ? '—' : activeChapter.cachedTokens.toLocaleString('vi-VN')}</span>
                        <span>Chi phí dịch: {activeChapter.translationCostUsd === undefined ? '—' : formatVnd(activeChapter.translationCostUsd, exchangeRate)}</span>
                      </div>
                      <p className="cache-status-note">{describeChapterCache(activeChapter)}</p>
                      {activeChapter.cacheObservation && (
                        <details className="cache-response-details">
                          <summary>Chi tiết phản hồi Google</summary>
                          <div>Model: {activeChapter.cacheObservation.model}</div>
                          <div>Lần biên tập: {new Date(activeChapter.cacheObservation.recordedAt).toLocaleString('vi-VN')}</div>
                          <div>Cách gửi: {activeChapter.cacheObservation.mode === 'explicit'
                            ? 'Tham chiếu Explicit Cache'
                            : 'Prompt đầy đủ; Google quyết định Implicit Cache'}</div>
                          {activeChapter.cacheObservation.warning && <p>{activeChapter.cacheObservation.warning}</p>}
                          <pre>{JSON.stringify({ usageMetadata: activeChapter.cacheObservation.usageMetadata }, null, 2)}</pre>
                        </details>
                      )}
                    </div>
                  ) : (
                    <div style={{ padding: '8px', fontSize: '12px', color: 'var(--text-color-muted)', fontStyle: 'italic', border: '1px solid var(--border-color)', borderRadius: '4px' }}>
                      Hãy chọn một chương để xem chi tiết.
                    </div>
                  )}
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
                    onChange={event => {
                      const value = Number(event.target.value);
                      if (Number.isFinite(value) && value > 0) setExchangeRate(value);
                    }}
                  />
                  <small>Chi phí dịch ước tính theo giá Standard trả phí của Google, gồm input mới, output và cache được dùng lại; chưa gồm phí tạo/lưu Explicit Cache. “—” nghĩa là thiếu số liệu, không phải 0. Chưa tính chi phí khi không xác định được số token cache.</small>
                </div>

                {provider === 'vertex-ai' && selectedModelName === 'Gemini 4 Argon' && (
                  <div className="argon-cache-diagnostic">
                    <button className="btn btn-secondary" type="button" onClick={handleInspectArgonCache} disabled={isCheckingArgonCache || !vertexServiceAccountJson}>
                      {isCheckingArgonCache ? 'Đang kiểm tra điều kiện cache...' : 'Kiểm tra điều kiện Cache Argon'}
                    </button>
                    <small>Chỉ kiểm tra độ dài prompt và cấu hình project. Kết quả trúng cache của từng chương nằm ở phía trên.</small>
                    {argonCacheDiagnostic && (
                      <div className="argon-cache-result">
                        <div>Phần prompt chung: {argonCacheDiagnostic.prefixTokens === null
                          ? `chưa đo được (${argonCacheDiagnostic.prefixError || 'không rõ lỗi'})`
                          : `${argonCacheDiagnostic.prefixTokens.toLocaleString('vi-VN')} token / tối thiểu 6.144 token trên Vertex`}</div>
                        <div>Quyền dùng cache của project: {argonCacheDiagnostic.projectCaching === 'enabled'
                          ? 'đang bật (chưa xác nhận trúng cache)'
                          : argonCacheDiagnostic.projectCaching === 'disabled'
                            ? 'đã tắt'
                            : `chưa kiểm tra được (${argonCacheDiagnostic.projectError || 'không rõ lỗi'})`}</div>
                        {argonCacheDiagnostic.prefixTokens !== null && argonCacheDiagnostic.prefixTokens < 6_144 && (
                          <div>Phần đầu lặp lại chưa đủ ngưỡng để Argon dùng Implicit Cache.</div>
                        )}
                        {argonCacheDiagnostic.prefixTokens !== null && argonCacheDiagnostic.prefixTokens >= 6_144
                          && argonCacheDiagnostic.projectCaching === 'enabled' && (
                            <div>Prompt đủ ngưỡng và project đang bật cache. Google vẫn có thể không cho cache hit ở từng yêu cầu.</div>
                          )}
                      </div>
                    )}
                  </div>
                )}

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
          </div>
          {/* Sidebar Footer with Bulk Action */}
          <div className="sidebar-footer">
            <button
              className="btn btn-primary btn-large"
              onClick={() => setIsBatchOpen(true)}
              disabled={isLoading}
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
                  <span>Biên tập bằng Batch API</span>
                </>
              )}
            </button>
          </div>
        </aside>

        {/* Resizer Handle */}
        <div className="resizer" onMouseDown={handleMouseDownOnResizer} />
        </>
        )}

        {/* --- CENTER WORKSPACE (NOVEL EDITOR) --- */}
        <main className="editor-pane">
          {project.chapters.length === 0 ? (
            /* --- HERO LANDING VIEW (EMPTY STATE) --- */
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

                {/* Drag and Drop Zone */}
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

                {/* Quick Sample Demo Button */}
                <div className="hero-sample-action">
                  <span style={{ fontSize: '13px', color: 'var(--text-color-muted)' }}>Chưa có tệp truyện sẵn sàng?</span>
                  <button type="button" className="btn btn-secondary" onClick={loadSampleProject}>
                    <Sparkles size={15} color="var(--primary-color)" />
                    <span>Dùng thử với chương truyện mẫu</span>
                  </button>
                </div>

                {/* Feature Highlights Grid */}
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
            /* --- ACTIVE NOVEL CHAPTER VIEW --- */
            <div className="chapter-workspace">
              {/* Chapter Top Action Bar */}
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
                    title={isFocusMode ? "Thoát chế độ tập trung" : "Chế độ tập trung (Reading Focus)"}
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
                    title="Phông chữ đọc tiểu thuyết"
                  >
                    {fontOptions.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>

                  <select
                    className="styled-input styled-select small-select"
                    value={editorFontSize}
                    onChange={handleFontSizeChange}
                    title="Cỡ chữ đọc"
                  >
                    {fontSizeOptions.map(size => (
                      <option key={size} value={size}>{size}px</option>
                    ))}
                  </select>

                  <select
                    className="styled-input styled-select small-select"
                    value={editorFontWeight}
                    onChange={handleFontWeightChange}
                    title="Độ đậm văn bản"
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

          {/* Floating Find & Replace Panel */}
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

        {!isFocusMode && isRightSidebarOpen && (
          <>
            {/* Right Resizer Handle */}
            <div className="resizer resizer-right" onMouseDown={handleMouseDownOnRightResizer} />

            {/* --- RIGHT SIDEBAR: CHAPTER EXPLORER DIRECTORY --- */}
            <aside className="sidebar sidebar-right" style={{ width: `${rightSidebarWidth}px` }}>
              <div className="chapter-explorer-header">
            <div className="explorer-title-row">
              <span className="explorer-title">Mục lục chương</span>
              <span className="explorer-badge">{project.chapters.length} chương</span>
            </div>

            {/* Chapter Search Bar */}
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

            {/* Filter Chips */}
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

          {/* Chapter Cards List */}
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
                    className={`chapter-item-card ${chapter.id === activeChapterId ? 'active' : ''} ${deletingChapterId === chapter.id ? 'confirming-delete' : ''}`}
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

          {/* Right Sidebar Footer */}
          <div className="sidebar-footer">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', width: '100%' }}>
              <button
                className="btn btn-secondary btn-small"
                onClick={handleDownload}
                disabled={project.chapters.length === 0}
                style={{ justifyContent: 'center' }}
                title="Tải toàn bộ truyện định dạng văn bản thô"
              >
                <FileText size={14} />
                <span>Tải .TXT</span>
              </button>
              <button
                className="btn btn-secondary btn-small"
                onClick={handleDownloadDocx}
                disabled={project.chapters.length === 0}
                style={{ justifyContent: 'center' }}
                title="Tải toàn bộ truyện định dạng Microsoft Word"
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

      </div>
      {/* --- FOOTER STATUS BAR --- */}
      <footer className="app-footer-bar">
        <div className="footer-status-left">
          <span
            className="status-dot"
            style={{
              backgroundColor: 'var(--success-color)'
            }}
          />
          <span>
            {`Sẵn sàng: ${selectedModelName} · ${providerLabel}`}
          </span>
        </div>

        <div className="footer-status-center">
          {project.chapters.length > 0 && (
            <span>
              {completedChaptersCount}/{totalChaptersCount} chương ({progressPercent}%) • Tổng {totalEditedWords.toLocaleString()} từ
            </span>
          )}
        </div>

        <div className="footer-status-right">
          <span>Ctrl + Enter: Thay thế nhanh</span>
          <span>•</span>
          <span>Beta Batch Web 0.1</span>
        </div>
      </footer>
    </>
  );

};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);
