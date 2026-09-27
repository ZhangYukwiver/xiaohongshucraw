import assert from "node:assert/strict";
import test from "node:test";

import { normalizeList, normalizeNote, parseCount } from "./records.mjs";

test("展示计数转数字", () => {
  assert.equal(parseCount("1.2万"), 12000);
  assert.equal(parseCount("1万+"), 10000);
  assert.equal(parseCount("10+"), 10);
  assert.equal(parseCount("3k"), 3000);
  assert.equal(parseCount("999"), 999);
  assert.equal(parseCount(42), 42);
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("赞"), null);
});

test("页面状态里的驼峰卡片，只留要存的字段", () => {
  const record = normalizeNote({
    id: "66f0a1b2000000001a02b3c4",
    xsecToken: "tok",
    noteCard: {
      type: "video",
      displayTitle: "周末去哪儿",
      user: { userId: "u1", nickname: "阿青", avatar: "http://sns-avatar-qc.xhscdn.com/a.jpg" },
      interactInfo: { liked: false, likedCount: "2.3万", sticky: true },
      cover: { urlDefault: "http://sns-webpic-qc.xhscdn.com/c.jpg" },
      time: 1727337600000,
    },
  });
  assert.deepEqual(record, {
    id: "66f0a1b2000000001a02b3c4",
    type: "video",
    title: "周末去哪儿",
    author: "阿青",
    likes: 23000,
    xsecToken: "tok",
  });
});

test("接口原始的下划线条目", () => {
  const record = normalizeNote({
    note_id: "64a3b2c1000000001203f1e2",
    display_title: "咖啡豆怎么选",
    user: { user_id: "u2", nick_name: "豆子" },
    interact_info: { liked_count: "88" },
    xsec_token: "tok2",
  });
  assert.deepEqual(record, { id: "64a3b2c1000000001203f1e2", type: "normal", title: "咖啡豆怎么选", author: "豆子", likes: 88, xsecToken: "tok2" });
});

test("访客看到的空 ID 丢掉，重复的只留一条", () => {
  const records = normalizeList([
    { id: "", noteCard: { noteId: "", displayTitle: "看不到 ID" } },
    { id: "a", noteCard: { displayTitle: "一" } },
    { id: "a", noteCard: { displayTitle: "一（重复）" } },
  ]);
  assert.deepEqual(records.map((record) => record.title), ["一"]);
});
