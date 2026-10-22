export const CACHE_TTL_SECONDS = 1800;

const CACHE_STORAGE_KEY = 'ai-beta-context-caches-v1';
const CHAPTER_MARKER = '--- VĂN BẢN GỐC CẦN BIÊN TẬP ---\n';
const EXPLICIT_CACHE_MODELS = new Set([
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
]);

interface CacheEntry {
  name: string;
  expiresAt: number;
}

export interface PreparedPrompt {
  prompt: string;
  cachedContent?: string;
  cacheMode: 'explicit' | 'implicit' | 'none';
  cacheKey?: string;
  cacheWarning?: string;
}

interface PrepareOptions {
  provider: 'vertex-api-key' | 'vertex-ai';
  scope: string;
  model: string;
  prompt: string;
  systemInstruction?: string;
  explicitCacheUnavailableReason?: string;
  createCache: (prefix: string, systemInstruction?: string) => Promise<{ name: string; expireTime?: string }>;
}

const memoryCache = new Map<string, CacheEntry>();
const pendingCache = new Map<string, Promise<CacheEntry>>();
const unavailableCache = new Map<string, { retryAt: number; warning: string }>();

function readStoredCache(key: string): CacheEntry | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_STORAGE_KEY);
    const entry = raw ? JSON.parse(raw)[key] as CacheEntry : undefined;
    return entry && typeof entry.name === 'string' && typeof entry.expiresAt === 'number' ? entry : undefined;
  } catch {
    return undefined;
  }
}

function writeStoredCache(key: string, entry?: CacheEntry): void {
  try {
    if (!globalThis.localStorage) return;
    const raw = globalThis.localStorage.getItem(CACHE_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) as Record<string, CacheEntry> : {};
    for (const [savedKey, value] of Object.entries(saved)) {
      if (!value || value.expiresAt <= Date.now()) delete saved[savedKey];
    }
    if (entry) saved[key] = entry;
    else delete saved[key];
    globalThis.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Browser storage can be disabled; the in-memory cache still works.
  }
}

async function cacheKey(options: PrepareOptions, prefix: string): Promise<string> {
  const source = JSON.stringify([
    options.provider, options.scope, options.model, prefix, options.systemInstruction || '',
  ]);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function splitChapterPrompt(prompt: string): { prefix: string; chapter: string } | null {
  const markerIndex = prompt.indexOf(CHAPTER_MARKER);
  if (markerIndex < 0) return null;
  const splitIndex = markerIndex + CHAPTER_MARKER.length;
  const chapter = prompt.slice(splitIndex);
  return chapter.trim() ? { prefix: prompt.slice(0, splitIndex), chapter } : null;
}

export async function prepareCachedPrompt(options: PrepareOptions): Promise<PreparedPrompt> {
  if (options.model === 'gemini-4-argon') {
    return { prompt: options.prompt, cacheMode: 'implicit' };
  }
  const parts = splitChapterPrompt(options.prompt);
  if (!EXPLICIT_CACHE_MODELS.has(options.model) || !parts) {
    return { prompt: options.prompt, cacheMode: 'none' };
  }
  if (options.explicitCacheUnavailableReason) {
    return { prompt: options.prompt, cacheMode: 'none', cacheWarning: options.explicitCacheUnavailableReason };
  }
  if (!globalThis.crypto?.subtle) {
    return { prompt: options.prompt, cacheMode: 'none', cacheWarning: 'Trình duyệt không hỗ trợ tạo mã cache an toàn.' };
  }

  const key = await cacheKey(options, parts.prefix);
  const unavailable = unavailableCache.get(key);
  if (unavailable && unavailable.retryAt > Date.now()) {
    return { prompt: options.prompt, cacheMode: 'none', cacheWarning: unavailable.warning };
  }
  unavailableCache.delete(key);
  let entry = memoryCache.get(key) || readStoredCache(key);
  if (!entry || entry.expiresAt <= Date.now() + 60_000) {
    try {
      let pending = pendingCache.get(key);
      if (!pending) {
        pending = options.createCache(parts.prefix, options.systemInstruction).then(created => {
          if (!created?.name) throw new Error('Google không trả về tên context cache.');
          const remoteExpiry = created.expireTime ? Date.parse(created.expireTime) : NaN;
          const expiresAt = Number.isFinite(remoteExpiry)
            ? remoteExpiry
            : Date.now() + CACHE_TTL_SECONDS * 1000;
          const nextEntry = { name: created.name, expiresAt };
          memoryCache.set(key, nextEntry);
          writeStoredCache(key, nextEntry);
          return nextEntry;
        }).finally(() => pendingCache.delete(key));
        pendingCache.set(key, pending);
      }
      entry = await pending;
    } catch (error: any) {
      const status = Number(error?.status);
      if (![400, 403, 404, 501].includes(status)) throw error;
      const warning = `Không tạo được Explicit Cache (${status}); đã gửi prompt đầy đủ. Sẽ thử tạo cache lại sau 1 phút.`;
      unavailableCache.set(key, { retryAt: Date.now() + 60_000, warning });
      return {
        prompt: options.prompt,
        cacheMode: 'none',
        cacheWarning: warning,
      };
    }
  } else {
    memoryCache.set(key, entry);
  }
  return { prompt: parts.chapter, cachedContent: entry.name, cacheMode: 'explicit', cacheKey: key };
}

export function invalidateCachedPrompt(key: string): void {
  memoryCache.delete(key);
  unavailableCache.delete(key);
  writeStoredCache(key);
}

export function isInvalidCachedContentError(error: { status?: number; message?: string }): boolean {
  return (error.status === 400 || error.status === 403 || error.status === 404)
    && /cache|cachedContent|cached content|cachedContents/i.test(error.message || '');
}
