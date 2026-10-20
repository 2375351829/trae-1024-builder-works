#!/usr/bin/env node
/**
 * 抓取楼层-fetch-floors.mjs
 * ---------------------------------------------------------------------------
 * 用途：把 TRAE 社区 1024 盖楼主帖的**全部楼层**抓下来，生成一份「楼层镜像」
 *       （data/floors.json），供《1024 楼层实况墙》页面**自主探查**读取。
 *
 * 为什么需要它：浏览器对 forum.trae.cn 的跨域请求会被同源策略拦截（无 ACAO 头），
 *   页面自己无法直连。本脚本跑在 **GitHub Actions** 里（不受同源策略约束），
 *   把数据落到 GitHub Pages 上；Pages 对静态资源返回 `access-control-allow-origin: *`，
 *   于是页面可以像访问自家数据一样自主拉取 —— **全程无需人工复制粘贴**。
 *
 * 判定口径：**本脚本不判定有效性**，只搬运原始纯文本；
 *   「宽松 / 严格」两套口径一律由页面用同一套正则现场计算（单一事实来源）。
 *   这一点很重要：若脚本与页面各判各的，两边的 213/201/12 迟早会打架。
 *
 * 用法：
 *   node 抓取楼层-fetch-floors.mjs                       # 输出到 ../data/floors.json
 *   node 抓取楼层-fetch-floors.mjs --out path.json
 *   node 抓取楼层-fetch-floors.mjs --topic 325833 --max-pages 40
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------ 参数 ------------------------------ */
const argv = process.argv.slice(2);
function arg(name, dflt) {
  const i = argv.indexOf('--' + name);
  return (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : dflt;
}
const TOPIC_ID = arg('topic', '325833');
const MAX_PAGES = parseInt(arg('max-pages', '40'), 10);
const OUT = resolve(arg('out', resolve(__dirname, '..', 'data', 'floors.json')));
const PAGE_SIZE = 20;
const TEXT_MAX = 400;          // 每层保留的纯文本长度（判定只需开头，400 足够覆盖）

/* --------------------------- 纯文本清洗 --------------------------- */
/** 与页面 stripHTML 保持一致：去标签 → 解实体 → 压空白 */
function stripHTML(html) {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------ 抓取 ------------------------------ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

async function getJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' @ ' + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const posts = new Map();      // post_number -> row
let meta = { highest: 0, participants: 0, postsCount: 0, topicCreatedAt: 0, lastPostedAt: 0 };

function absorb(topicJson) {
  if (!topicJson) return 0;
  if (typeof topicJson.highest_post_number === 'number') meta.highest = topicJson.highest_post_number;
  if (typeof topicJson.participant_count === 'number') meta.participants = topicJson.participant_count;
  if (typeof topicJson.posts_count === 'number') meta.postsCount = topicJson.posts_count;
  if (topicJson.created_at) {
    const c = Date.parse(topicJson.created_at);
    if (isFinite(c)) meta.topicCreatedAt = c;
  }
  if (topicJson.last_posted_at) {
    const l = Date.parse(topicJson.last_posted_at);
    if (isFinite(l)) meta.lastPostedAt = l;
  }
  const stream = topicJson.post_stream;
  if (!stream || !Array.isArray(stream.posts)) return 0;
  let n = 0;
  for (const p of stream.posts) {
    if (!p || typeof p.post_number !== 'number') continue;
    if (posts.has(p.post_number)) continue;
    const ms = Date.parse(p.created_at);
    posts.set(p.post_number, [
      p.post_number,
      isFinite(ms) ? ms : 0,
      String(p.username || p.display_username || p.name || '匿名'),
      stripHTML(p.cooked).slice(0, TEXT_MAX),
    ]);
    n++;
  }
  return n;
}

async function main() {
  console.log(`[fetch-floors] 主题 ${TOPIC_ID}｜最多 ${MAX_PAGES} 页｜每页 ${PAGE_SIZE} 层`);

  // 第 1 页拿元信息 + 前 20 层
  const first = await getJSON(`https://forum.trae.cn/t/${TOPIC_ID}.json`);
  let added = absorb(first);
  console.log(`[fetch-floors] 第 1 页：+${added} 层，累计 ${posts.size}，最高 ${meta.highest} 楼`);

  // 继续翻页直到连续两页没有新层
  let emptyStreak = 0;
  for (let page = 2; page <= MAX_PAGES; page++) {
    let json;
    try {
      json = await getJSON(`https://forum.trae.cn/t/${TOPIC_ID}.json?page=${page}`);
    } catch (err) {
      console.warn(`[fetch-floors] 第 ${page} 页失败：${err.message}（停止翻页）`);
      break;
    }
    const n = absorb(json);
    added += n;
    console.log(`[fetch-floors] 第 ${page} 页：+${n} 层，累计 ${posts.size}`);
    emptyStreak = (n === 0) ? emptyStreak + 1 : 0;
    if (emptyStreak >= 2) { console.log(`[fetch-floors] 连续两页无新增，停止`); break; }
    await new Promise(r => setTimeout(r, 400));      // 温和限速，别给论坛添压力
  }

  const rows = [...posts.values()].sort((a, b) => a[0] - b[0]);
  const now = Date.now();
  const payload = {
    v: 1,
    topic: TOPIC_ID,
    source: 'forum.trae.cn/t/' + TOPIC_ID + '.json',
    fetchedAt: now,
    fetchedAtISO: new Date(now).toISOString(),
    highest: meta.highest,
    participants: meta.participants,
    postsCount: meta.postsCount || rows.length,
    topicCreatedAt: meta.topicCreatedAt,
    lastPostedAt: meta.lastPostedAt,
    rows,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  // 与上一份镜像对比，给出「新增了多少层」的增量信息
  let delta = '';
  if (existsSync(OUT.replace(/floors\.json$/, '.prev.json'))) { /* 占位：预留 */ }
  const size = (JSON.stringify(payload).length / 1024).toFixed(1);
  console.log(`[fetch-floors] ✅ 写出 ${OUT}`);
  console.log(`[fetch-floors]    ${rows.length} 层 · 最高 ${meta.highest} 楼 · 参与者 ${meta.participants} · ${size} KB`);
  console.log(`[fetch-floors]    采样时刻 ${new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
}

main().catch(err => {
  console.error('[fetch-floors] ❌ 失败：', err && err.message ? err.message : err);
  process.exitCode = 1;
});
