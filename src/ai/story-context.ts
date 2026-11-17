export const STORY_CONTEXTS = [
  { value: 'modern', label: 'Hiện đại' },
  { value: 'ancient', label: 'Cổ đại' },
  { value: 'future', label: 'Tương lai (viễn tưởng)' },
] as const;

export type StoryContext = '' | typeof STORY_CONTEXTS[number]['value'];
export interface EditingRules {
  pronounRules: string;
  addressingRules: string;
  storyContext?: StoryContext;
}

// Existing projects and Batch backups have no context; do not assign them an era.
export function normalizeStoryContext(value: unknown): StoryContext {
  return STORY_CONTEXTS.some(option => option.value === value) ? value as StoryContext : '';
}

const guidance: Record<Exclude<StoryContext, ''>, string> = {
  modern: 'Ưu tiên từ vựng và cách diễn đạt tự nhiên trong đời sống hiện đại, phù hợp môi trường xã hội, nghề nghiệp và quan hệ nhân vật trong nguyên tác. Tránh tự đưa lối nói cổ phong vào lời kể hoặc hội thoại hiện đại.',
  ancient: 'Ưu tiên từ vựng và cách diễn đạt phù hợp xã hội, lễ nghi và quan hệ tôn ti của bối cảnh cổ đại trong nguyên tác; giữ câu văn rõ ràng, tự nhiên. Tránh tiếng lóng, cách ví von hoặc khái niệm hiện đại không có trong nguyên tác. Không lạm dụng từ Hán Việt hoặc tự đổi mọi đại từ thành ta, ngươi.',
  future: 'Ưu tiên cách diễn đạt phù hợp bối cảnh tương lai, khoa học viễn tưởng của nguyên tác. Giữ nhất quán tên gọi, thuật ngữ công nghệ, thiết bị, tổ chức và khái niệm giả tưởng khi dịch hoặc thay từ. Không tự thêm công nghệ, kiến thức khoa học hoặc thiết lập thế giới mới.',
};

export function storyContextInstruction(value: unknown): string {
  const context = normalizeStoryContext(value);
  if (!context) return '';
  const label = STORY_CONTEXTS.find(option => option.value === context)!.label;
  return `--- BỐI CẢNH TÁC PHẨM: ${label} ---
${guidance[context]}
Chỉ chọn từ thay thế và chỉnh sửa câu khi phù hợp ý nghĩa gốc, giọng kể, người nói và tình huống cụ thể. Bối cảnh này định hướng biên tập, không phải yêu cầu chuyển tác phẩm sang thời đại khác.
Giữ nguyên tên riêng, chức danh, đồ vật, sự kiện và đặc trưng thế giới của nguyên tác. Nếu tác phẩm đan xen nhiều thời đại, giữ đúng bối cảnh từng đoạn; không ép mọi đoạn theo một thời đại.
Quy tắc đại từ và bảng xưng hô cụ thể do người dùng cung cấp được ưu tiên khi chọn đại từ/xưng hô; không tự đổi cách xưng hô chỉ dựa vào bối cảnh.
--- HẾT BỐI CẢNH TÁC PHẨM ---

`;
}
