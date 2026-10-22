import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '50mb' }));

// Server-side GoogleGenAI instance
const getAi = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY chưa được cấu hình trên máy chủ. Vui lòng thiết lập trong mục Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
};

const serverCacheMap = new Map<string, { name: string; expiresAt: number }>();

const EXPLICIT_CACHE_MODELS = new Set([
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
]);
const CHAPTER_MARKER = '--- VĂN BẢN GỐC CẦN BIÊN TẬP ---\n';

// API: Health check and status
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
  });
});

// API: Clear server cache
app.post('/api/gemini/clear-cache', (req, res) => {
  serverCacheMap.clear();
  res.json({ ok: true, message: 'Đã làm mới bộ nhớ tạm cache máy chủ.' });
});

// API: Server-side chapter translation/editing proxy with explicit caching support
app.post('/api/gemini/edit-chapter', async (req, res) => {
  try {
    const { prompt, model, enableExplicitCache } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'Nội dung prompt đang trống.' });
    }

    const ai = getAi();
    const chosenModel = model || 'gemini-3.8-flash';

    const isEligible = enableExplicitCache !== false && EXPLICIT_CACHE_MODELS.has(chosenModel);
    const markerIndex = prompt.indexOf(CHAPTER_MARKER);

    if (isEligible && markerIndex > 0) {
      const splitIndex = markerIndex + CHAPTER_MARKER.length;
      const prefix = prompt.slice(0, splitIndex);
      const chapterContent = prompt.slice(splitIndex);

      if (chapterContent.trim()) {
        const cacheKey = `${chosenModel}:${prefix}`;
        let cacheEntry = serverCacheMap.get(cacheKey);

        if (!cacheEntry || cacheEntry.expiresAt <= Date.now() + 60_000) {
          try {
            const created = await ai.caches.create({
              model: chosenModel,
              config: {
                displayName: 'chapter-rules-cache',
                contents: [{ role: 'user', parts: [{ text: prefix }] }],
                ttl: '1800s',
              },
            });
            if (created?.name) {
              cacheEntry = {
                name: created.name,
                expiresAt: Date.now() + 1800 * 1000,
              };
              serverCacheMap.set(cacheKey, cacheEntry);
            }
          } catch (cacheCreateErr: any) {
            console.warn('ai.caches.create failed on server (e.g. under min tokens), using full prompt:', cacheCreateErr.message);
          }
        }

        if (cacheEntry?.name) {
          try {
            const response = await ai.models.generateContent({
              model: chosenModel,
              contents: [{ role: 'user', parts: [{ text: chapterContent }] }],
              config: {
                cachedContent: cacheEntry.name,
              },
            });

            return res.json({
              text: response.text || '',
              usageMetadata: response.usageMetadata,
              cacheMode: 'explicit',
            });
          } catch (cachedCallErr: any) {
            console.warn('Generate with cachedContent failed, invalidating cache and falling back:', cachedCallErr.message);
            serverCacheMap.delete(cacheKey);
          }
        }
      }
    }

    // Default call with full prompt
    const response = await ai.models.generateContent({
      model: chosenModel,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    res.json({
      text: response.text || '',
      usageMetadata: response.usageMetadata,
      cacheMode: chosenModel === 'gemini-4-argon' ? 'implicit' : 'none',
    });
  } catch (err: any) {
    console.error('Server chapter edit error:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi gọi Gemini từ máy chủ.' });
  }
});

// Setup Vite middleware in dev or static files in production
async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server listening on port ${port} (mode: ${isProduction ? 'prod' : 'dev'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
