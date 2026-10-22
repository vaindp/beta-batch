// Paid Standard text rates, USD per 1M tokens.
interface TokenPrices {
  input: number;
  output: number;
  cached: number;
  longInput?: number;
  longOutput?: number;
  longCached?: number;
}

const PRICES: Record<string, TokenPrices> = {
  'gemini-2.5-pro': { input: 1.25, output: 10, cached: 0.125, longInput: 2.5, longOutput: 15, longCached: 0.25 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cached: 0.03 },
  'gemini-3.1-pro-preview': { input: 2, output: 12, cached: 0.2, longInput: 4, longOutput: 18, longCached: 0.4 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cached: 0.15 },
  'gemini-3.8-flash': { input: 0.5, output: 3.0, cached: 0.05 },
  'gemini-3.1-flash-lite': { input: 0.1, output: 0.4, cached: 0.01 },
};

export interface TokenUsage {
  promptTokenCount?: number;
  cachedContentTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export interface CacheObservation {
  model: string;
  mode: 'explicit' | 'implicit' | 'none';
  recordedAt: string;
  usageMetadata: TokenUsage | null;
  warning?: string;
}

export interface SavedTranslationStatistics {
  cachedTokens?: number;
  translationCostUsd?: number;
  cacheObservation?: CacheObservation;
}

export function restoreTranslationStatistics<T extends SavedTranslationStatistics>(saved: T): T {
  if (!saved.cacheObservation && saved.cachedTokens === 0) {
    return { ...saved, cachedTokens: undefined, translationCostUsd: undefined };
  }
  return saved;
}

export function describeChapterCache(saved: SavedTranslationStatistics): string {
  if (saved.cachedTokens === undefined) {
    return saved.cacheObservation
      ? 'Google chưa trả số token cache hợp lệ; chưa xác nhận được lần này có trúng cache hay không.'
      : 'Chưa có số liệu cache được xác nhận cho chương này. Chương cũ cần biên tập lại để lấy số liệu mới.';
  }
  return saved.cachedTokens > 0
    ? `Đã ghi nhận ${saved.cachedTokens.toLocaleString('vi-VN')} token trúng cache.`
    : 'Google báo 0 token cache cho lần biên tập này.';
}

export interface TranslationUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  newInputTokens: number | null;
  costUsd: number | null;
}

function count(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : 0;
}

export function calculateTranslationUsage(model: string, usage: TokenUsage | undefined, at = new Date()): TranslationUsage {
  const inputTokens = count(usage?.promptTokenCount);
  const reportedCache = usage?.cachedContentTokenCount;
  const hasInput = Number.isInteger(usage?.promptTokenCount) && usage!.promptTokenCount! >= 0;
  
  const cachedTokens = Number.isInteger(reportedCache) && reportedCache! >= 0
    && (!hasInput || reportedCache! <= inputTokens) ? reportedCache! : null;
  const newInputTokens = hasInput && cachedTokens !== null ? inputTokens - cachedTokens : null;
  const outputTokens = count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount);
  const argonIntro = at.getTime() < Date.UTC(2026, 11, 1);
  const prices = model === 'gemini-4-argon'
    ? { input: argonIntro ? 2 : 4, output: argonIntro ? 10 : 20, cached: argonIntro ? 0.1 : 0.2 }
    : PRICES[model];
  if (!hasInput || newInputTokens === null || cachedTokens === null || !prices) {
    return { inputTokens, outputTokens, cachedTokens, newInputTokens, costUsd: null };
  }
  const longContext = inputTokens > 200_000 && prices.longInput !== undefined;
  const inputRate = longContext ? prices.longInput! : prices.input;
  const outputRate = longContext ? prices.longOutput! : prices.output;
  const cachedRate = longContext ? prices.longCached! : prices.cached;
  const costUsd = (newInputTokens * inputRate + outputTokens * outputRate + cachedTokens * cachedRate) / 1_000_000;
  return { inputTokens, outputTokens, cachedTokens, newInputTokens, costUsd };
}

export function formatVnd(costUsd: number, exchangeRate: number): string {
  if (costUsd > 0 && costUsd * exchangeRate < 0.5) return '<1 ₫';
  return `${Math.round(costUsd * exchangeRate).toLocaleString('vi-VN')} ₫`;
}
