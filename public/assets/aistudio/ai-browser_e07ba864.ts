import { generateVertexAPIKeyContent } from './vertex-api-key';
import { generateVertexContentInBrowser } from './vertex-browser';

export type AIProvider = 'vertex-ai' | 'vertex-api-key';

export interface AIConnectionConfig {
  provider: AIProvider;
  vertexApiKey: string;
  vertexApiKeyProjectId: string;
  selectedModelName?: string;
  vertexProjectId: string;
  vertexRegion: string;
  vertexServiceAccountEmail: string;
  vertexKeyFileName: string;
  vertexServiceAccountJson: string;
}

// Migrate the old lower menu option while keeping JSON credentials independent.
export function restoreAPIKeyConfig(saved: Record<string, unknown>) {
  return {
    provider: (saved.provider === 'vertex-api-key' || saved.provider === 'gemini-api'
      ? 'vertex-api-key' : 'vertex-ai') as AIProvider,
    vertexApiKey: typeof saved.vertexApiKey === 'string' ? saved.vertexApiKey
      : typeof saved.geminiApiKey === 'string' ? saved.geminiApiKey : '',
    vertexApiKeyProjectId: typeof saved.vertexApiKeyProjectId === 'string' ? saved.vertexApiKeyProjectId : '',
  };
}

export const modelMapping: Record<string, string> = {
  'Gemini 2.5 Pro': 'gemini-2.5-pro',
  'Gemini 2.5 Flash': 'gemini-2.5-flash',
  'Gemini 3.1 Pro Preview': 'gemini-3.1-pro-preview',
  'Gemini 3.5 Flash': 'gemini-3.5-flash',
  'Gemini 4 Argon': 'gemini-4-argon',
};

export const GLOBAL_VERTEX_MODELS = new Set(['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-4-argon']);

export const resolveVertexRegion = (modelId: string, selectedRegion: string): string => (
  GLOBAL_VERTEX_MODELS.has(modelId) ? 'global' : (selectedRegion || 'us-central1')
);

export function getAIConfigurationError(config: AIConnectionConfig): string | null {
  if (config.provider === 'vertex-api-key') {
    return config.vertexApiKey.trim() ? null : 'Vui lòng nhập Vertex AI API Key trong Cài đặt.';
  }
  if (config.provider !== 'vertex-ai') return 'Provider không được hỗ trợ.';
  return config.vertexProjectId && config.vertexServiceAccountJson
    ? null
    : 'Vui lòng nạp Service Account Key trong Cài đặt.';
}

export async function generateAIContentInBrowser(
  config: AIConnectionConfig,
  request: { model: string; prompt: string; systemInstruction?: string; signal?: AbortSignal },
) {
  const error = getAIConfigurationError(config);
  if (error) throw new Error(error);
  if (config.provider === 'vertex-api-key') {
    return generateVertexAPIKeyContent({ ...request, apiKey: config.vertexApiKey, projectId: config.vertexApiKeyProjectId });
  }
  return generateVertexContentInBrowser({
    ...request,
    projectId: config.vertexProjectId,
    region: resolveVertexRegion(request.model, config.vertexRegion),
    serviceAccountJson: config.vertexServiceAccountJson,
  });
}

export async function checkAIConnectionInBrowser(config: AIConnectionConfig, model: string, signal?: AbortSignal): Promise<void> {
  await generateAIContentInBrowser(config, { model, prompt: 'Reply with exactly: OK', signal });
}
