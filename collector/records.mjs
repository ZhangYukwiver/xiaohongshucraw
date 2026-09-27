// 把小红书页面状态里的笔记卡片归一成直播采集要存的几个字段。
// 页面状态是驼峰（noteCard.displayTitle），接口原始数据是下划线（display_title），两种都认。

export const text = (value) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

// 「1.2万」「10+」「3k」这类展示用计数转成数字，认不出返回 null
export function parseCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = /^(\d+(?:\.\d+)?)\s*(万|w|千|k|亿)?\+?$/i.exec(text(value));
  if (!match) return null;
  const unit = { 万: 1e4, w: 1e4, 千: 1e3, k: 1e3, 亿: 1e8 }[match[2]?.toLowerCase()] ?? 1;
  return Math.round(Number(match[1]) * unit);
}

export function isoTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return new Date(number < 1e12 ? number * 1000 : number).toISOString();
}

export function normalizeNote(item) {
  const card = item?.noteCard ?? item;
  if (!card || typeof card !== "object") return null;
  const id = text(item.id) || text(card.noteId) || text(card.note_id) || text(card.id);
  if (!id) return null;
  const user = card.user ?? {};
  const interact = card.interactInfo ?? card.interact_info ?? {};
  return {
    id,
    type: card.type === "video" ? "video" : "normal",
    title: text(card.displayTitle ?? card.display_title ?? card.title),
    author: text(user.nickname ?? user.nickName ?? user.nick_name),
    likes: parseCount(interact.likedCount ?? interact.liked_count),
    xsecToken: text(item.xsecToken ?? card.xsecToken ?? card.xsec_token),
  };
}

export function normalizeList(items) {
  const seen = new Set();
  return (items ?? []).flatMap((item) => {
    const record = normalizeNote(item);
    if (!record || seen.has(record.id)) return [];
    seen.add(record.id);
    return [record];
  });
}
