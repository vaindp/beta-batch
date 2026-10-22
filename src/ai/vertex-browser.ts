import {
  CACHE_TTL_SECONDS, invalidateCachedPrompt, isInvalidCachedContentError,
  prepareCachedPrompt, splitChapterPrompt, type PreparedPrompt,
} from './context-cache';

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_VERTEX_REGION = 'us-central1';

interface ServiceAccountCredentials {
  type: 'service_account';
  project_id: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
}

interface VertexBrowserRequest {
  projectId?: string;
  region?: string;
  serviceAccountJson: string;
  model: string;
  prompt: string;
  systemInstruction?: string;
  signal?: AbortSignal;
  enableExplicitCache?: boolean;
}

export interface VertexBrowserResponse {
  text: string;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  cacheMode?: 'explicit' | 'implicit' | 'none';
  cacheWarning?: string;
}

export interface VertexArgonCacheDiagnostic {
  prefixTokens: number | null;
  prefixError?: string;
  projectCaching: 'enabled' | 'disabled' | 'unknown';
  projectError?: string;
}

interface CachedAccessToken {
  credentialId: string;
  token: string;
  expiresAt: number;
}

let cachedAccessToken: CachedAccessToken | null = null;

export class VertexBrowserError extends Error {
  status: number;
  retryAfterMs?: number;

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'VertexBrowserError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function getRetryAfterMs(response: Response): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return undefined;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 120_000);
  }

  const retryAt = Date.parse(retryAfter);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(0, retryAt - Date.now()), 120_000);
  }
  return undefined;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Service Account Key thiếu trường "${fieldName}".`);
  }
  return value.trim();
}

function parseServiceAccount(rawJson: string): ServiceAccountCredentials {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('Service Account Key không phải JSON hợp lệ.');
  }

  if (!parsed || typeof parsed !== 'object' || parsed.type !== 'service_account') {
    throw new Error('File JSON không phải Service Account Key của Google Cloud.');
  }

  return {
    type: 'service_account',
    project_id: requireNonEmptyString(parsed.project_id, 'project_id'),
    private_key_id: typeof parsed.private_key_id === 'string' ? parsed.private_key_id.trim() : undefined,
    private_key: requireNonEmptyString(parsed.private_key, 'private_key'),
    client_email: requireNonEmptyString(parsed.client_email, 'client_email'),
  };
}

export async function getVertexBatchAuth(rawJson: string): Promise<{ projectId: string; token: string }> {
  const credentials = parseServiceAccount(rawJson);
  return { projectId: credentials.project_id, token: await getAccessToken(credentials) };
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function privateKeyPemToBuffer(privateKeyPem: string): ArrayBuffer {
  const base64 = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s/g, '');

  if (!base64) {
    throw new Error('private_key trong Service Account Key đang trống.');
  }

  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    throw new Error('private_key trong Service Account Key không đúng định dạng PKCS#8.');
  }
}

async function createSignedJwt(credentials: ServiceAccountCredentials): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('Trình duyệt không hỗ trợ Web Crypto. Hãy mở website bằng HTTPS hoặc localhost.');
  }

  let signingKey: CryptoKey;
  try {
    signingKey = await globalThis.crypto.subtle.importKey(
      'pkcs8',
      privateKeyPemToBuffer(credentials.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch {
    throw new Error('Không thể đọc private_key trong Service Account Key.');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const header: Record<string, string> = { alg: 'RS256', typ: 'JWT' };
  if (credentials.private_key_id) header.kid = credentials.private_key_id;

  const claimSet = {
    iss: credentials.client_email,
    scope: GOOGLE_CLOUD_SCOPE,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: issuedAt - 30,
    exp: issuedAt + 3570,
  };

  const unsignedJwt = `${jsonToBase64Url(header)}.${jsonToBase64Url(claimSet)}`;
  const signature = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(unsignedJwt),
  );
  return `${unsignedJwt}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const data = await response.json();
    return data?.error?.message || data?.error_description || data?.message || fallback;
  } catch {
    return fallback;
  }
}

async function getAccessToken(credentials: ServiceAccountCredentials, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const credentialId = `${credentials.project_id}:${credentials.client_email}:${credentials.private_key_id || ''}`;
  if (
    cachedAccessToken
    && cachedAccessToken.credentialId === credentialId
    && cachedAccessToken.expiresAt > Date.now() + 60_000
  ) {
    return cachedAccessToken.token;
  }

  const assertion = await createSignedJwt(credentials);
  const requestBody = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: requestBody,
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, 'Google OAuth từ chối Service Account Key.');
    throw new VertexBrowserError(
      `Không thể xác thực Service Account: ${message}`,
      response.status,
      getRetryAfterMs(response),
    );
  }

  const tokenData = await response.json();
  if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
    throw new Error('Google OAuth không trả về access token.');
  }

  cachedAccessToken = {
    credentialId,
    token: tokenData.access_token,
    expiresAt: Date.now() + Math.max(60, Number(tokenData.expires_in) || 3600) * 1000,
  };
  return tokenData.access_token;
}

function vertexApiBaseUrl(region: string): string {
  return region === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${region}-aiplatform.googleapis.com`;
}

export async function inspectVertexArgonCache(request: Pick<VertexBrowserRequest, 'projectId' | 'serviceAccountJson' | 'prompt' | 'signal'>): Promise<VertexArgonCacheDiagnostic> {
  const credentials = parseServiceAccount(request.serviceAccountJson);
  const projectId = request.projectId?.trim() || credentials.project_id;
  if (projectId !== credentials.project_id) {
    throw new Error(`Project ID không khớp với project_id trong file JSON (${credentials.project_id}).`);
  }
  const parts = splitChapterPrompt(request.prompt);
  if (!parts) throw new Error('Không tìm thấy phần quy tắc chung trong prompt chương.');
  const accessToken = await getAccessToken(credentials, request.signal);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const resource = `projects/${encodeURIComponent(projectId)}`;
  const [countResult, configResult] = await Promise.allSettled([
    fetch(`${vertexApiBaseUrl('global')}/v1/${resource}/locations/global/publishers/google/models/gemini-4-argon:countTokens`, {
      method: 'POST', signal: request.signal, headers,
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: parts.prefix }] }] }),
    }),
    fetch(`${vertexApiBaseUrl('us-central1')}/v1/${resource}/cacheConfig`, {
      method: 'GET', signal: request.signal, headers,
    }),
  ]);
  const diagnostic: VertexArgonCacheDiagnostic = { prefixTokens: null, projectCaching: 'unknown' };
  if (countResult.status === 'fulfilled') {
    if (countResult.value.ok) {
      const data = await countResult.value.json();
      diagnostic.prefixTokens = Number.isFinite(data?.totalTokens) ? data.totalTokens : null;
      if (diagnostic.prefixTokens === null) diagnostic.prefixError = 'Google không trả số token.';
    } else {
      diagnostic.prefixError = `HTTP ${countResult.value.status}`;
    }
  } else {
    diagnostic.prefixError = 'Không kết nối được CountTokens API.';
  }
  if (configResult.status === 'fulfilled') {
    if (configResult.value.ok) {
      const data = await configResult.value.json();
      diagnostic.projectCaching = data?.disableCache === true ? 'disabled' : 'enabled';
    } else {
      diagnostic.projectError = `HTTP ${configResult.value.status}`;
    }
  } else {
    diagnostic.projectError = 'Không kết nối được cacheConfig API.';
  }
  return diagnostic;
}

export async function generateVertexContentInBrowser(
  request: VertexBrowserRequest,
): Promise<VertexBrowserResponse> {
  const credentials = parseServiceAccount(request.serviceAccountJson);
  const projectId = request.projectId?.trim() || credentials.project_id;
  const region = request.region?.trim() || DEFAULT_VERTEX_REGION;
  const model = request.model?.trim();
  const prompt = request.prompt;

  if (projectId !== credentials.project_id) {
    throw new Error(`Project ID không khớp với project_id trong file JSON (${credentials.project_id}).`);
  }
  if (!/^[a-z0-9-]+$/.test(region)) {
    throw new Error('Region / Location không hợp lệ.');
  }
  if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) {
    throw new Error('Model Vertex AI không hợp lệ.');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Nội dung gửi tới Vertex AI đang trống.');
  }

  const accessToken = await getAccessToken(credentials, request.signal);
  const resourcePath = [
    'v1',
    'projects',
    projectId,
    'locations',
    region,
    'publishers',
    'google',
    'models',
    model,
  ].map(segment => encodeURIComponent(segment)).join('/');
  const endpoint = `${vertexApiBaseUrl(region)}/${resourcePath}:generateContent`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const prepared = await prepareCachedPrompt({
    provider: 'vertex-ai', scope: `${projectId}:${region}:${credentials.client_email}:${credentials.private_key_id || ''}`,
    model, prompt, systemInstruction: request.systemInstruction,
    enableExplicitCache: request.enableExplicitCache,
    createCache: async (prefix, systemInstruction) => {
      const cacheBody: Record<string, unknown> = {
        model: `projects/${projectId}/locations/${region}/publishers/google/models/${model}`,
        contents: [{ role: 'user', parts: [{ text: prefix }] }],
        ttl: `${CACHE_TTL_SECONDS}s`,
      };
      if (systemInstruction?.trim()) {
        cacheBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }
      const cacheResponse = await fetch(
        `${vertexApiBaseUrl(region)}/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(region)}/cachedContents`,
        { method: 'POST', signal: request.signal, headers, body: JSON.stringify(cacheBody) },
      );
      if (!cacheResponse.ok) {
        throw new VertexBrowserError(
          `Vertex AI: ${await readErrorMessage(cacheResponse, `Lỗi HTTP ${cacheResponse.status}.`)}`,
          cacheResponse.status, getRetryAfterMs(cacheResponse),
        );
      }
      const data = await cacheResponse.json();
      return { name: data?.name, expireTime: data?.expireTime };
    },
  });

  const send = async (active: PreparedPrompt) => {
    request.signal?.throwIfAborted();
    const apiBody: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: active.prompt }] }],
    };
    if (active.cachedContent) apiBody.cachedContent = active.cachedContent;
    else if (request.systemInstruction?.trim()) {
      apiBody.systemInstruction = { parts: [{ text: request.systemInstruction }] };
    }
    const response = await fetch(endpoint, {
      method: 'POST', signal: request.signal, headers, body: JSON.stringify(apiBody),
    });
    if (!response.ok) {
      const message = await readErrorMessage(response, `Vertex AI trả về lỗi HTTP ${response.status}.`);
      if (response.status === 403) {
        throw new VertexBrowserError(`Lỗi phân quyền Vertex AI (403): ${message}`,
          response.status, getRetryAfterMs(response));
      }
      throw new VertexBrowserError(`Vertex AI: ${message}`, response.status, getRetryAfterMs(response));
    }
    return response.json();
  };

  let active = prepared;
  let data: any;
  try {
    data = await send(active);
  } catch (error: any) {
    if (!active.cacheKey || !isInvalidCachedContentError(error)) throw error;
    invalidateCachedPrompt(active.cacheKey);
    active = { prompt, cacheMode: 'none', cacheWarning: 'Context cache không còn hợp lệ; đã gửi lại prompt đầy đủ.' };
    data = await send(active);
  }
  const text = Array.isArray(data?.candidates?.[0]?.content?.parts)
    ? data.candidates[0].content.parts
        .map((part: { text?: unknown }) => typeof part?.text === 'string' ? part.text : '')
        .join('')
    : '';
  if (!text.trim()) {
    throw new Error('Vertex AI trả về nội dung rỗng hoặc yêu cầu đã bị bộ lọc an toàn chặn.');
  }

  return { text, usageMetadata: data.usageMetadata, cacheMode: active.cacheMode, cacheWarning: active.cacheWarning };
}

export async function checkVertexConnectionInBrowser(
  request: Omit<VertexBrowserRequest, 'prompt'>,
): Promise<void> {
  await generateVertexContentInBrowser({
    ...request,
    prompt: 'Reply with exactly: OK',
  });
}
