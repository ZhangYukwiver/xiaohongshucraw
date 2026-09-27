import assert from "node:assert/strict";
import test from "node:test";

import { parseFrame, roomUrl, toCsv } from "./live.mjs";

process.env.TZ = "Asia/Shanghai";

// 按网页直播间 WebSocket 的真实结构造数据：外层 JSON → base64 JSON → customData JSON 字符串
const encode = (message) => Buffer.from(JSON.stringify(message)).toString("base64");
const frame = (...messages) => JSON.stringify({
  v: 1, t: 4, m: "0ac8", b: { d: { a: 0, biz: "room", t: 1790436915321, b: messages.map((message, index) => ({ d: typeof message === "string" ? message : encode(message), e: {}, m: String(index) })) } },
});
const message = (customData, extra = {}) => ({
  command: 1, customData: JSON.stringify(customData), msgId: "m1", priority: 2, roomId: "500000000000000001", roomType: "LIVE", ts: 1790436915304, uuid: "uuid-1", ...extra,
});

test("一帧里只取文字弹幕", () => {
  const payload = frame(
    message({ type: "text", commentId: "c1", current_time: 1790436915217, desc: " 好起来了 ", profile: { user_id: "u1", nickname: "阿青", role: 0 } }),
    message({ type: "praise", profile: { user_id: "u2" }, praise_info: { count: 21 } }),
    message({ type: "audience_join_v2", profile: { user_id: "u3", nickname: "路人" } }),
    "不是 base64",
  );
  assert.deepEqual(parseFrame(payload), [
    { id: "c1", roomId: "500000000000000001", userId: "u1", nickname: "阿青", text: "好起来了", at: "2026-09-26T15:35:15.217Z" },
  ]);
});

test("缺 commentId 用 msgId，缺发言时间用消息时间", () => {
  const [comment] = parseFrame(frame(message({ type: "text", desc: "来了", profile: { user_id: "u1", nickname: "阿青" } })));
  assert.equal(comment.id, "m1");
  assert.equal(comment.at, "2026-09-26T15:35:15.304Z");
});

test("心跳回执、坏数据、没有用户的消息都不算弹幕", () => {
  assert.deepEqual(parseFrame('{"v":1,"t":2,"m":"a","b":{"a":{"b":{"time":1},"c":0,"m":"success"}}}'), []);
  assert.deepEqual(parseFrame("not json"), []);
  assert.deepEqual(parseFrame(frame(message({ type: "text", desc: "没有用户" }))), []);
});

test("直播间链接：地址栏、分享文案、房间号", () => {
  const link = "https://www.xiaohongshu.com/livestream/500000000000000001?track_id=t&source=web_feed&xsec_token=AB1-_x";
  assert.equal(roomUrl(link), link);
  assert.equal(roomUrl("【阿青的直播】快来看 http://xhslink.com/m/AbC123 复制本条信息，打开【小红书】App观看"), "http://xhslink.com/m/AbC123");
  assert.equal(roomUrl("http://xhslink.com/m/AbC123，复制本条信息"), "http://xhslink.com/m/AbC123");
  assert.equal(roomUrl(" 500000000000000001 "), "https://www.xiaohongshu.com/livestream/500000000000000001");
  assert.equal(roomUrl("阿青的直播"), null);
});

test("表格：一行一条弹幕，没查到的留空，公式开头的当文本", () => {
  const csv = toCsv({
    rooms: { r1: { hostName: "主播A" } },
    comments: [
      { id: "c1", roomId: "r1", userId: "u1", nickname: "旧昵称", text: '=HYPERLINK("http://x","点我")', at: "2026-09-26T15:35:15.217Z" },
      { id: "c2", roomId: "r1", userId: "u2", nickname: "还没查", text: "你好,世界", at: "2026-09-26T15:35:16.000Z" },
      { id: "c3", roomId: "r2", userId: "u3", nickname: "豆子", text: "来了", at: "2026-09-26T15:35:17.000Z" },
    ],
    users: {
      u1: { nickname: "阿青", redId: "123456", ipLocation: "上海", posted: 2, notes: [{ title: "周末去哪儿" }, { title: "" }], collected: null, collectedCount: null },
      u3: { nickname: "豆子", redId: "654321", ipLocation: "四川", posted: 0, notes: [], collected: [{ title: "咖啡" }, { title: "露营" }], collectedCount: 61 },
    },
  });
  assert.ok(csv.startsWith("﻿时间,直播间,主播,名字,小红书号,弹幕内容,IP属地,"));
  const [, ...rows] = csv.slice(1).trimEnd().split("\r\n");
  assert.deepEqual(rows, [
    `2026-09-26 23:35:15,r1,主播A,阿青,123456,"'=HYPERLINK(""http://x"",""点我"")",上海,2,周末去哪儿,未公开,,https://www.xiaohongshu.com/user/profile/u1`,
    `2026-09-26 23:35:16,r1,主播A,还没查,,"你好,世界",,,,,,https://www.xiaohongshu.com/user/profile/u2`,
    `2026-09-26 23:35:17,r2,,豆子,654321,来了,四川,0,,61,咖啡 | 露营,https://www.xiaohongshu.com/user/profile/u3`,
  ]);
});
