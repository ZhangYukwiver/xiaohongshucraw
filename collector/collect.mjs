// 浏览器这一侧：用本机 Chrome 和独立登录态打开小红书网页，等登录、等验证、读页面状态。
// 只读页面已经拿到的数据，不伪造签名，出现验证只等你自己在窗口里完成。
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { chromium } from "playwright-core";

export const DATA_DIR = path.resolve(import.meta.dirname, "../.local-data");
const PROFILE_DIR = path.join(DATA_DIR, "browser-profile");
export const SITE = "https://www.xiaohongshu.com";
const LOGIN_WAIT_MS = 10 * 60_000;
const VERIFY_WAIT_MS = 5 * 60_000;

export class UserError extends Error {}

// 在页面里执行。Pinia 的实时状态优先；__INITIAL_STATE__ 是首屏注入的同一批 ref，拿来兜底。
// index 是用户主页上的列表：0 笔记、1 收藏；不给就只看登录状态和主页资料。
export function readPage(index) {
  const un = (value) => (value && typeof value === "object" && "_rawValue" in value ? value._rawValue : value);
  const root = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia?.state?.value
    ?? window.__INITIAL_STATE__;
  if (!root?.user) return null;
  const info = un(root.user.userInfo) ?? {};
  const page = un(root.user.userPageData) ?? {};
  const items = un(root.user.notes)?.[index];
  return {
    userId: un(root.user.loggedIn) && !info.guest ? info.userId ?? null : null,
    basic: page.basicInfo ?? null,
    interactions: page.interactions ?? [],
    // 笔记总数、收藏是否公开
    posted: page.posted ?? null,
    tabPublic: page.tabPublic ?? null,
    hasMore: un(root.user.noteQueries)?.[index]?.hasMore,
    items: JSON.parse(JSON.stringify((Array.isArray(items) ? items : []).map((item) => ({
      id: item.id, xsecToken: item.xsecToken, noteCard: item.noteCard,
    })))),
  };
}

export const snapshot = (page, index) => page.evaluate(readPage, index).catch(() => null);

// ponytail: 只用有界面的 Chrome。实测无头模式会被小红书风控直接拦成「安全限制 300012」，
// 继续硬试可能连累账号，所以不提供无界面读取。
export async function launch() {
  const options = { headless: false, locale: "zh-CN", viewport: null, args: ["--window-size=1280,900"] };
  if (process.env.XHS_CHROME_PATH) {
    return chromium.launchPersistentContext(PROFILE_DIR, { ...options, executablePath: process.env.XHS_CHROME_PATH });
  }
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { ...options, channel });
    } catch (error) {
      if (/ProcessSingleton|already in use/i.test(error.message)) {
        throw new UserError("独立浏览器还开着（可能上一次采集没退出），关掉那个窗口再运行");
      }
      if (!/is not found at/.test(error.message)) throw error;
    }
  }
  throw new UserError("没找到 Chrome 或 Edge。装一个，或用环境变量 XHS_CHROME_PATH 指定 Chromium 内核浏览器的路径");
}

// 风控页（安全限制、访问频繁）不是等一等就能过的，直接停下，别再刷
function assertNotRestricted(page) {
  const url = new URL(page.url());
  if (!url.pathname.startsWith("/website-login/error")) return;
  const code = url.searchParams.get("error_code") ?? "";
  const reason = url.searchParams.get("error_msg") ?? "安全限制";
  throw new UserError(`小红书返回风控页：${reason}（${code}）。已记下的都会保存，隔一段时间或换个网络再试`);
}

const isVerifying = async (page) => /captcha|verify/i.test(new URL(page.url()).pathname)
  || page.locator('[class*="captcha"], iframe[src*="captcha"]').first().isVisible().catch(() => false);

// 小红书弹验证时停下来等你手动完成，工具不替你过验证
export async function waitIfVerifying(page) {
  assertNotRestricted(page);
  if (!await isVerifying(page)) return;
  console.log("\n小红书弹出了验证，请在浏览器窗口里手动完成，完成后自动继续…");
  const deadline = Date.now() + VERIFY_WAIT_MS;
  while (await isVerifying(page)) {
    assertNotRestricted(page);
    if (Date.now() > deadline) throw new UserError("验证等待超时（5 分钟），稍后重新运行");
    await delay(2000);
  }
}

export async function waitForLogin(page) {
  const deadline = Date.now() + LOGIN_WAIT_MS;
  let hinted = false;
  for (;;) {
    assertNotRestricted(page);
    // 页面状态还没就绪时读到 null，先等，别急着判定没登录
    const state = await snapshot(page);
    if (state?.userId) return state.userId;
    if (state && !hinted) {
      console.log("请在弹出的浏览器里登录小红书（扫码或手机号），登录后自动继续…");
      hinted = true;
    }
    if (Date.now() > deadline) {
      throw new UserError(state ? "等待登录超时（10 分钟），重新运行即可" : "读不到小红书页面数据：网络打不开，或网页改版了");
    }
    await delay(2000);
  }
}

export function profileOf(userId, { basic, interactions }) {
  const counts = Object.fromEntries(interactions.map((item) => [item.type, item.count]));
  return {
    id: userId,
    nickname: basic.nickname ?? "",
    redId: basic.redId ?? "",
    avatar: String(basic.images ?? "").replace(/^http:\/\//, "https://"),
    desc: basic.desc ?? "",
    ipLocation: basic.ipLocation ?? "",
    follows: counts.follows ?? "",
    fans: counts.fans ?? "",
    interaction: counts.interaction ?? "",
  };
}
