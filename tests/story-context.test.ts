import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPromptForChapter } from '../src/ai/editing-prompt';
import { STORY_CONTEXTS, normalizeStoryContext, type EditingRules } from '../src/ai/story-context';
import { splitChapterPrompt, prepareCachedPrompt } from '../src/ai/context-cache';
import { prepareRun, toJSONL, validateBackup, importDisposition } from '../src/batch/batch-core';

const chapter = { id: '1', title: 'Chương 1', originalContent: 'Đoạn văn nguyên tác.', editedContent: '', status: 'ready' };
const rules: EditingRules = { pronounRules: 'An: cô', addressingRules: 'An ↔ Bình: tôi - cậu' };
const createRun = (selected: EditingRules) => prepareRun({
  chapters: [chapter], rules: selected, title: 'Truyện', projectId: 'test-project', bucket: 'test-bucket', thinking: 'MEDIUM',
  promptFor: text => getPromptForChapter(text, selected),
});

for (const context of STORY_CONTEXTS) {
  test(`${context.label}: direct and Batch prompts share the selected context and preserve explicit rules`, async () => {
    const selected = { ...rules, storyContext: context.value };
    const direct = getPromptForChapter(chapter.originalContent, selected);
    assert.ok(direct.includes(`BỐI CẢNH TÁC PHẨM: ${context.label}`));
    assert.ok(direct.includes(rules.pronounRules));
    assert.ok(direct.includes(rules.addressingRules));
    assert.ok(direct.includes('không phải yêu cầu chuyển tác phẩm sang thời đại khác'));
    assert.ok(direct.includes('được ưu tiên khi chọn đại từ/xưng hô'));
    const split = splitChapterPrompt(direct)!;
    assert.ok(split.prefix.includes(`BỐI CẢNH TÁC PHẨM: ${context.label}`));
    assert.ok(split.chapter.includes(chapter.originalContent));
    const run = await createRun(selected);
    const sent = JSON.parse(toJSONL(run).trim()).request.contents[0].parts[0].text;
    assert.ok(sent.startsWith(direct));
    assert.equal(run.rules.storyContext, context.value);
    selected.storyContext = context.value === 'modern' ? 'ancient' : 'modern';
    assert.equal(run.rules.storyContext, context.value, 'saved Batch context is a snapshot');
    assert.equal((await validateBackup(JSON.parse(JSON.stringify(run)))).rules.storyContext, context.value);
  });
}

test('legacy projects do not receive an arbitrary era and old Batch backups remain importable', async () => {
  for (const value of [undefined, null, '', 'invalid', 123, {}]) assert.equal(normalizeStoryContext(value), '');
  const prompt = getPromptForChapter(chapter.originalContent, rules);
  assert.ok(!prompt.includes('BỐI CẢNH TÁC PHẨM'));
  assert.equal(prompt, getPromptForChapter(chapter.originalContent, { ...rules, storyContext: '' }));
  const run = await validateBackup(JSON.parse(JSON.stringify(await createRun(rules))));
  assert.equal(importDisposition(run, run.rows[0], chapter, { ...rules, storyContext: '' }), 'ready');
  assert.equal(importDisposition(run, run.rows[0], chapter, { ...rules, storyContext: 'modern' }), 'conflict');
});

test('changing context while a Batch job runs prevents importing results under different rules', async () => {
  const selected: EditingRules = { ...rules, storyContext: 'ancient' };
  const run = await createRun(selected);
  assert.equal(importDisposition(run, run.rows[0], chapter, selected), 'ready');
  for (const storyContext of ['modern', 'future', ''] as const) {
    assert.equal(importDisposition(run, run.rows[0], chapter, { ...selected, storyContext }), 'conflict');
  }
  for (const storyContext of ['invalid', null, 42]) {
    await assert.rejects(validateBackup({ ...run, rules: { ...run.rules, storyContext } }), /không hợp lệ/);
  }
});

test('a new context creates a distinct explicit cache instead of reusing the previous era', async () => {
  const prefixes: string[] = [];
  const common = {
    provider: 'vertex-ai' as const, scope: 'story-context-test', model: 'gemini-2.5-pro', enableExplicitCache: true,
    createCache: async (prefix: string) => {
      prefixes.push(prefix);
      return { name: `context-cache-${prefixes.length}`, expireTime: new Date(Date.now() + 1_800_000).toISOString() };
    },
  };
  // Long shared instructions pass the application's cache-size threshold.
  const longRules = { ...rules, pronounRules: rules.pronounRules.repeat(4000) };
  const modern = getPromptForChapter(chapter.originalContent, { ...longRules, storyContext: 'modern' });
  const ancient = getPromptForChapter(chapter.originalContent, { ...longRules, storyContext: 'ancient' });
  const first = await prepareCachedPrompt({ ...common, prompt: modern });
  const second = await prepareCachedPrompt({ ...common, prompt: ancient });
  assert.equal(prefixes.length, 2);
  assert.notEqual(first.cachedContent, second.cachedContent);
  assert.ok(prefixes[0].includes('BỐI CẢNH TÁC PHẨM: Hiện đại'));
  assert.ok(prefixes[1].includes('BỐI CẢNH TÁC PHẨM: Cổ đại'));
});
