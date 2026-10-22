import { generateVertexContentInBrowser, type VertexBrowserResponse } from './vertex-browser';

export type AIProvider = 'vertex-ai' | 'server-gemini';

export interface AIConnectionConfig {
  provider: AIProvider;
  selectedModelName?: string;
  vertexProjectId: string;
  vertexRegion: string;
  vertexServiceAccountEmail: string;
  vertexKeyFileName: string;
  vertexServiceAccountJson: string;
  enableExplicitCache?: boolean;
}

export function restoreAPIKeyConfig(saved: Record<string, unknown>) {
  let provider: AIProvider = 'vertex-ai';
  if (saved.provider === 'vertex-ai' || saved.provider === 'server-gemini') {
    provider = 'vertex-ai';
  }
  return {
    provider,
  };
}

export const modelMapping: Record<string, string> = {
  'Gemini 4 Argon': 'gemini-4-argon',
  'Gemini 3.8 Flash': 'gemini-3.8-flash',
  'Gemini 3.1 Flash Lite': 'gemini-3.1-flash-lite',
  'Gemini 3.5 Flash': 'gemini-3.5-flash',
  'Gemini 3.1 Pro Preview': 'gemini-3.1-pro-preview',
  'Gemini 2.5 Pro': 'gemini-2.5-pro',
  'Gemini 2.5 Flash': 'gemini-2.5-flash',
};

export const GLOBAL_VERTEX_MODELS = new Set(['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-4-argon']);

export const resolveVertexRegion = (modelId: string, selectedRegion: string): string => (
  GLOBAL_VERTEX_MODELS.has(modelId) ? 'global' : (selectedRegion || 'us-central1')
);

export function getAIConfigurationError(config: AIConnectionConfig): string | null {
  if (config.provider === 'server-gemini') {
    return 'Phương thức Gemini API Key đã ngưng hỗ trợ. Vui lòng sử dụng Vertex AI Service Account JSON trong Cài đặt.';
  }
  if (config.provider !== 'vertex-ai') return 'Provider không được hỗ trợ.';
  return config.vertexProjectId && config.vertexServiceAccountJson
    ? null
    : 'Vui lòng nạp Service Account Key trong Cài đặt.';
}

export async function generateAIContentInBrowser(
  config: AIConnectionConfig,
  request: { model: string; prompt: string; systemInstruction?: string; signal?: AbortSignal },
): Promise<VertexBrowserResponse> {
  const error = getAIConfigurationError(config);
  if (error) throw new Error(error);

  if (config.provider === 'server-gemini') {
    const res = await fetch('/api/gemini/edit-chapter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: request.prompt,
        model: request.model,
        enableExplicitCache: config.enableExplicitCache,
      }),
      signal: request.signal,
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Server trả về lỗi HTTP ${res.status}`);
    }
    const data = await res.json();
    return {
      text: data.text || '',
      usageMetadata: data.usageMetadata,
      cacheMode: data.cacheMode || 'implicit',
    };
  }

  return generateVertexContentInBrowser({
    ...request,
    projectId: config.vertexProjectId,
    region: resolveVertexRegion(request.model, config.vertexRegion),
    serviceAccountJson: config.vertexServiceAccountJson,
    enableExplicitCache: config.enableExplicitCache,
  });
}

export async function checkAIConnectionInBrowser(config: AIConnectionConfig, model: string, signal?: AbortSignal): Promise<void> {
  await generateAIContentInBrowser(config, { model, prompt: 'Reply with exactly: OK', signal });
}
