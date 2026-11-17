// A single catalog feeds both direct editing and Batch model pickers.
export const modelMapping: Record<string, string> = {
  'Gemini 4 Argon': 'gemini-4-argon',
  'Gemini 3.8 Flash': 'gemini-3.8-flash',
  'Gemini 3.1 Flash Lite': 'gemini-3.1-flash-lite',
  'Gemini 3.5 Flash': 'gemini-3.5-flash',
  'Gemini 3.1 Pro Preview': 'gemini-3.1-pro-preview',
  'Gemini 2.5 Pro': 'gemini-2.5-pro',
  'Gemini 2.5 Flash': 'gemini-2.5-flash',
};
export const MODEL_OPTIONS = Object.entries(modelMapping).map(([label, id]) => ({ label, id }));
export const isSelectableModel = (id: string) => MODEL_OPTIONS.some(model => model.id === id);
