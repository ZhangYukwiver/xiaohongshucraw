// 直播间弹幕采集：在独立登录态的 Chrome 里打开直播间，记下网页自己收到的弹幕（WebSocket），
// 再逐个打开发言用户的主页，读小红书号、IP 属地、作品和公开的收藏。只读：不发弹幕、不关注、不私信。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { DATA_DIR, SITE, UserError, launch, profileOf, snapshot, waitForLogin, waitIfVerifying } from "./collect.mjs";
import { isoTime, normalizeList, text } from "./records.mjs";

const LIVE_FILE = path.join(DATA_DIR, "live.json");
const CSV_FILE = path.join(DATA_DIR, "live.csv");
// ponytail: 查主页固定 5–10 秒开一页，发言的人多了会排队；真被限流再调大
const pause = () => delay(5000 + Math.random() * 5000);
let interrupted = false;

// 直播间 WebSocket 的一帧：外层 JSON 的 b.d.b[].d 是 base64 编码的 JSON，里面的 customData 又是一层 JSON 字符串。
// 只要 type 为 text 的弹幕，进场、点赞、礼物等消息都跳过。结构是 2026-09-26 在网页直播间实测的。
export function parseFrame(payload) {
  let frame;
  try {
    frame = JSON.parse(payload);
  } catch {
    return [];
  }
  const items = frame?.b?.d?.biz === "room" ? frame.b.d.b : null;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    try {
      const message = JSON.parse(Buffer.from(item.d, "base64").toString("utf8"));
      const data = JSON.parse(message.customData);
      const userId = text(data?.profile?.user_id);
      if (data?.type !== "text" || !userId) return [];
      return [{
        id: text(data.commentId) || text(message.msgId) || text(message.uuid),
        roomId: text(message.roomId),
        userId,
        nickname: text(data.profile.nickname),
        text: text(data.desc),
        at: isoTime(data.current_time ?? message.ts) ?? new Date().toISOString(),
      }];
    } catch {
      return [];
    }
  });
}

// 认浏览器地址栏里的链接、App 分享文案里的 xhslink 短链，以及纯房间号
export function roomUrl(input) {
  const link = /https?:\/\/[\x21-\x7e]+/.exec(input)?.[0];
  if (link) return link;
  return /^\d{15,}$/.test(input.trim()) ? `${SITE}/livestream/${input.trim()}` : null;
}

// 弹幕、昵称、标题都是别人写的：= + - @ 开头的会被表格软件当公式执行，前面加 ' 当成文本
function csvCell(value) {
  const cell = String(value ?? "").replace(/^[=+\-@\t\r]/, "'$&");
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

const CSV_HEAD = ["时间", "直播间", "主播", "名字", "小红书号", "弹幕内容", "IP属地", "作品数", "作品（首屏标题）", "收藏数", "收藏（首屏标题）", "主页"];

// 一行一条弹幕，带上发言用户的资料；还没查到主页的，资料列留空
export function toCsv({ rooms, comments, users }) {
  const titles = (notes) => (notes ?? []).map((note) => note.title).filter(Boolean).join(" | ");
  const rows = comments.map((comment) => {
    const user = users[comment.userId];
    return [
      new Date(comment.at).toLocaleString("sv-SE"),
      comment.roomId,
      rooms[comment.roomId]?.hostName,
      user?.nickname || comment.nickname,
      user?.redId,
      comment.text,
      user?.ipLocation,
      user?.posted,
      titles(user?.notes),
      user ? (user.collected ? user.collectedCount : "未公开") : "",
      titles(user?.collected),
      `${SITE}/user/profile/${comment.userId}`,
    ];
  });
  // 带 BOM，Excel 直接打开中文不乱码
  return `﻿${[CSV_HEAD, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

// 在页面里执行。liveStatus 一打开就是 success，要等 pageStatus 变成 success 才是真加载完；
// 直播结束时页面把 liveStatus 改成 end（roomStatus ≥ 3）
function readRoom() {
  const un = (value) => (value && typeof value === "object" && "_rawValue" in value ? value._rawValue : value);
  const live = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value?.liveStream;
  if (!un(live?.roomId)) return null;
  const { roomInfo = {}, hostInfo = {} } = un(live.roomData) ?? {};
  return {
    id: String(un(live.roomId)),
    title: roomInfo.roomTitle ?? "",
    hostId: hostInfo.userId ?? "",
    hostName: hostInfo.nickName ?? "",
    loaded: un(live.pageStatus) === "success",
    error: un(live.errorMessage) || "",
    ended: un(live.liveStatus) === "end",
  };
}

const roomEnded = async (page) => page.isClosed() || (await page.evaluate(readRoom).catch(() => null))?.ended === true;

export async function openRoom(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const deadline = Date.now() + 30_000;
  for (;;) {
    await waitIfVerifying(page);
    const room = await page.evaluate(readRoom).catch(() => null);
    if (room?.loaded) {
      if (room.ended) throw new UserError("这场直播已经结束了，网页上没有弹幕可记");
      return room;
    }
    if (room?.error) throw new UserError(`打不开这个直播间：${room.error}`);
    if (Date.now() > deadline) throw new UserError("打不开这个直播间：确认链接没错、直播正在进行；都没问题的话可能是网页改版了");
    await delay(1000);
  }
}

// 等页面状态里有这位用户的资料，并且列表首屏到了（或者确定是空的）
async function waitForList(page, index) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    await waitIfVerifying(page);
    const state = await snapshot(page, index);
    if (state && !state.userId) throw new UserError("登录状态失效了，重新运行并登录");
    if (state?.basic && (state.items.length > 0 || state.hasMore === false)) return state;
    if (Date.now() > deadline) return state?.basic ? state : null;
    await delay(1000);
  }
}

// ponytail: 作品、收藏都只读页面第一批（2026-09-27 实测作品 30 条左右、收藏 10 条）加总数，不往下翻，
// 少开页面也少被风控；要全量再加滚动
async function lookupUser(page, userId) {
  await page.goto(`${SITE}/user/profile/${userId}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  const home = await waitForList(page, 0);
  if (!home) return null;
  const open = home.tabPublic?.collection === true;
  const user = {
    ...profileOf(userId, home),
    posted: home.posted,
    notes: normalizeList(home.items),
    collectedCount: open ? home.tabPublic.collectionNote?.count ?? null : null,
    collected: null, // null 表示收藏没公开
    fetchedAt: new Date().toISOString(),
  };
  if (open) {
    await pause();
    await page.goto(`${SITE}/user/profile/${userId}?tab=fav&subTab=note`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    user.collected = normalizeList((await waitForList(page, 1))?.items);
  }
  return user;
}

function load() {
  try {
    return JSON.parse(readFileSync(LIVE_FILE, "utf8"));
  } catch (error) {
    // 文件坏了就报错停下，绝不拿空数据覆盖
    if (error.code === "ENOENT") return { version: 1, rooms: {}, comments: [], users: {} };
    throw new UserError(`读不了 ${LIVE_FILE}：${error.message}`);
  }
}

// 同步写，Ctrl+C 退出前也来得及存完；JSON 先写临时文件再改名，写一半断掉也不坏
function save(data) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(`${LIVE_FILE}.tmp`, JSON.stringify(data), { mode: 0o600 });
  renameSync(`${LIVE_FILE}.tmp`, LIVE_FILE);
  writeFileSync(CSV_FILE, toCsv(data), { mode: 0o600 });
}

async function main() {
  const input = parseArgs({ allowPositionals: true }).positionals.join(" ").trim();
  const url = input ? roomUrl(input) : null;
  if (input && !url) throw new UserError("认不出直播间链接：从浏览器地址栏或 App 分享里复制完整链接，或者直接给房间号");

  const data = load();
  const context = await launch();
  // Ctrl+C 时 Playwright 会自己关浏览器再退出，这里先同步存一次，刚收到的弹幕也不丢
  process.once("SIGINT", () => {
    interrupted = true;
    save(data);
    console.log(`\n已保存：${CSV_FILE}`);
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${SITE}/explore`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await waitForLogin(page);

    // 待查的人不单独存：弹幕里出现过、还没查过主页的就是。上次没查完的这次接着查
    const queue = new Set(data.comments.map((comment) => comment.userId).filter((id) => !data.users[id]));
    const before = data.comments.length;
    if (url) {
      const seen = new Set(data.comments.map((comment) => comment.id));
      page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
        for (const comment of parseFrame(payload)) {
          if (seen.has(comment.id)) continue;
          seen.add(comment.id);
          data.comments.push(comment);
          if (!data.users[comment.userId]) queue.add(comment.userId);
        }
      }));
      const room = await openRoom(page, url);
      data.rooms[room.id] = { title: room.title, hostId: room.hostId, hostName: room.hostName };
      console.log(`已进入「${room.hostName}」的直播间：${room.title}`);
      console.log("直播结束、发言的人主页都查完后自动退出；也可以随时按 Ctrl+C 结束，已记下的都会保存");
    } else {
      console.log(`没给直播间链接，只补查上次没查完的主页：${queue.size} 人`);
    }

    const profilePage = url ? await context.newPage() : page;
    let looked = 0;
    let stopped = false;
    let saved = data.comments.length;
    for (;;) {
      process.stdout.write(`\r  本次弹幕 ${data.comments.length - before} 条 · 查了 ${looked} 人的主页 · 还有 ${queue.size} 人待查   `);
      const next = stopped ? undefined : queue.values().next().value;
      if (next === undefined) {
        if (!url || await roomEnded(page)) break;
        await waitIfVerifying(page); // 直播间也被风控就停下，已记下的在 finally 里保存
        if (data.comments.length !== saved) {
          save(data);
          saved = data.comments.length;
        }
        await delay(2000);
        continue;
      }
      queue.delete(next);
      try {
        const user = await lookupUser(profilePage, next);
        if (user) data.users[next] = user;
        else console.log(`\n  ${next} 的主页打不开，跳过`);
        looked += 1;
      } catch (error) {
        if (profilePage.isClosed()) throw new UserError("浏览器窗口被关掉了，已经记下的都保存了");
        if (error.name === "TimeoutError") {
          console.log(`\n  ${next} 的主页加载超时，跳过，下次运行再查`);
        } else if (error instanceof UserError) {
          // 风控、登录失效：别再开主页了，弹幕照常记
          stopped = true;
          console.log(`\n${error.message}\n已停止查主页${url ? "，弹幕继续记录" : ""}`);
        } else {
          throw error;
        }
      }
      save(data);
      saved = data.comments.length;
      await pause();
    }
    const pending = new Set(data.comments.map((comment) => comment.userId).filter((id) => !data.users[id])).size;
    console.log(`\n共 ${data.comments.length} 条弹幕、${Object.keys(data.users).length} 人的主页资料${pending ? `；还有 ${pending} 人没查，运行 npm run live 补查` : ""}`);
  } finally {
    save(data);
    await context.close().catch(() => undefined);
  }
  console.log(`已保存：${CSV_FILE}（原始数据 ${LIVE_FILE}）`);
}

if (import.meta.main) {
  main().catch((error) => {
    if (interrupted) return;
    const message = error instanceof UserError ? error.message
      : error.name === "TimeoutError" ? "小红书网页加载超时，检查网络后重试" : error.stack;
    console.error(`\n${message}`);
    process.exitCode = 1;
  });
}
