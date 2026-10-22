import type { VertexBrowserResponse } from './vertex-browser';
import {
  CACHE_TTL_SECONDS, invalidateCachedPrompt, isInvalidCachedContentError,
  prepareCachedPrompt, type PreparedPrompt,
} from './context-cache';

export interface VertexAPIKeyRequest {
  apiKey: string;
  projectId?: string;
  model: string;
  prompt: string;
  systemInstruction?: string;
  signal?: AbortSignal;
}

export class VertexAPIKeyError extends Error {
  constructor(message: string, public status: number, public retryAfterMs?: number) {
    super(message);
    this.name = 'VertexAPIKeyError';
  }
}

function getRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.min(Math.max(0, retryAt - Date.now()), 120_000) : undefined;
}

// Shared by browser and server. API-key credentials never use the JSON/OAuth path.
export async function generateVertexAPIKeyContent(request: VertexAPIKeyRequest): Promise<VertexBrowserResponse> {
  const apiKey = request.apiKey?.trim();
  const model = request.model?.trim();
  const projectId = request.projectId?.trim() || '';
  if (!apiKey) throw new VertexAPIKeyError('Vui lòng nhập Vertex AI API Key trong Cài đặt.', 400);
  if (projectId && !/^[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new VertexAPIKeyError('Project ID của API Key không hợp lệ. Hãy nhập mã dự án, không nhập tên hiển thị hoặc đường dẫn.', 400);
  }
  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new VertexAPIKeyError('Model Vertex AI không hợp lệ.', 400);
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new VertexAPIKeyError('Nội dung gửi tới Vertex AI đang trống.', 400);
  }

  const headers = { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey };
  const apiBase = 'https://aiplatform.googleapis.com/v1';
  const parent = projectId ? `projects/${encodeURIComponent(projectId)}/locations/global` : '';
  const modelResource = `${parent ? `${parent}/` : ''}publishers/google/models/${encodeURIComponent(model)}`;
  const prepared = await prepareCachedPrompt({
    provider: 'vertex-api-key', scope: JSON.stringify([apiKey, projectId, 'global']), model, prompt: request.prompt,
    systemInstruction: request.systemInstruction,
    explicitCacheUnavailableReason: projectId ? undefined
      : 'Chưa dùng Explicit Cache: hãy điền Project ID của API Key trong Cài đặt. Đang gửi prompt đầy đủ.',
    createCache: async (prefix, systemInstruction) => {
      const cacheBody: Record<string, unknown> = {
        model: modelResource,
        contents: [{ role: 'user', parts: [{ text: prefix }] }],
        ttl: `${CACHE_TTL_SECONDS}s`,
      };
      if (systemInstruction?.trim()) {
        cacheBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }
      const response = await fetch(`${apiBase}/${parent}/cachedContents`, {
        method: 'POST', signal: request.signal, headers, body: JSON.stringify(cacheBody),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new VertexAPIKeyError(`Vertex AI (API Key): ${data?.error?.message || `Lỗi HTTP ${response.status}.`}`,
          response.status, getRetryAfterMs(response));
      }
      return { name: data?.name, expireTime: data?.expireTime };
    },
  });

  const send = async (active: PreparedPrompt) => {
    request.signal?.throwIfAborted();
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: active.prompt }] }],
    };
    if (active.cachedContent) body.cachedContent = active.cachedContent;
    else if (request.systemInstruction?.trim()) {
      body.systemInstruction = { parts: [{ text: request.systemInstruction }] };
    }
    const response = await fetch(
      `${apiBase}/${modelResource}:generateContent`,
      { method: 'POST', signal: request.signal, headers, body: JSON.stringify(body) },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data?.error?.message || `Lỗi HTTP ${response.status}.`;
      const hint = response.status === 401 || response.status === 403
        ? ' Hãy kiểm tra key trong Google Cloud Console: key phải được phép dùng Vertex AI API; nếu key gắn với tài khoản dịch vụ, tài khoản đó phải có quyền dùng Vertex AI. Nếu dùng project riêng, hãy điền Project ID của API Key.'
        : '';
      throw new VertexAPIKeyError(`Vertex AI (API Key): ${message}${hint}`, response.status, getRetryAfterMs(response));
    }
    return data;
  };

  let active = prepared;
  let data: any;
  try {
    data = await send(active);
  } catch (error: any) {
    if (!active.cacheKey || !isInvalidCachedContentError(error)) throw error;
    invalidateCachedPrompt(active.cacheKey);
    active = { prompt: request.prompt, cacheMode: 'none', cacheWarning: 'Context cache không còn hợp lệ; đã gửi lại prompt đầy đủ.' };
    data = await send(active);
  }

  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS' || data?.continuationToken || data?.continuation_token) {
    throw new VertexAPIKeyError('Vertex AI đã đạt giới hạn đầu ra. Hãy chia chương thành các phần ngắn hơn rồi thử lại.', 422);
  }
  if (data?.promptFeedback?.blockReason || (candidate?.finishReason && candidate.finishReason !== 'STOP')) {
    throw new VertexAPIKeyError(`Vertex AI không hoàn tất nội dung (${data?.promptFeedback?.blockReason || candidate.finishReason}).`, 422);
  }
  const text = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts
        .filter((part: { thought?: boolean }) => !part.thought)
        .map((part: { text?: unknown }) => typeof part.text === 'string' ? part.text : '')
        .join('')
    : '';
  if (!text.trim()) {
    throw new VertexAPIKeyError('Vertex AI trả về nội dung rỗng hoặc yêu cầu đã bị bộ lọc an toàn chặn.', 422);
  }
  return { text, usageMetadata: data.usageMetadata, cacheMode: active.cacheMode, cacheWarning: active.cacheWarning };
}
