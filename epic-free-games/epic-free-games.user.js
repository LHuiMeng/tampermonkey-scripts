// ==UserScript==
// @name         Epic 免费游戏提醒
// @namespace    https://huimeng.dpdns.org
// @version      1.0.1
// @author       洛诗
// @description  每天检查 Epic Games Store 免费游戏，新游戏弹窗提醒；标记已领取后不再重复提醒。
// @match        https://*/*
// @exclude      https://*.epicgames.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      store-site-backend-static-ipv4.ak.epicgames.com
// @icon         https://www.epicgames.com/favicon.ico
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  // ── 常量 ──────────────────────────────────────────────
  const API_URL =
    'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN';
  const STORE_BASE = 'https://store.epicgames.com/zh-CN/p/';
  const STORAGE_KEY = 'epic_free_games_state';
  const NOTIFICATION_TAG = 'epic-free-games';

  // ── 存储读写 ──────────────────────────────────────────
  function loadState() {
    const raw = GM_getValue(STORAGE_KEY, null);
    if (!raw) {
      return { lastCheckDate: '', reminders: {} };
    }
    try {
      return JSON.parse(raw);
    } catch (_) {
      return { lastCheckDate: '', reminders: {} };
    }
  }

  function saveState(state) {
    GM_setValue(STORAGE_KEY, JSON.stringify(state));
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // ── API 请求 ──────────────────────────────────────────
  function fetchFreeGames() {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: API_URL,
        timeout: 15000,
        onload(r) {
          if (r.status !== 200) {
            reject(new Error(`HTTP ${r.status}`));
            return;
          }
          try {
            const data = JSON.parse(r.responseText);
            resolve(data);
          } catch (e) {
            reject(e);
          }
        },
        onerror() { reject(new Error('网络请求失败')); },
        ontimeout() { reject(new Error('请求超时')); },
      });
    });
  }

  // ── 解析免费游戏 ──────────────────────────────────────
  function parseFreeGames(data) {
    const elements = data?.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(elements)) return { current: [], upcoming: [] };

    const current = [];
    const upcoming = [];

    for (const game of elements) {
      const title = game.title || '未知游戏';
      const priceInfo = game.price?.totalPrice || {};
      const originalPrice = (priceInfo.originalPrice || 0) / 100;

      const promotions = game.promotions;
      if (!promotions) continue;

      // 当前免费
      for (const og of promotions.promotionalOffers || []) {
        for (const offer of og.promotionalOffers || []) {
          if (offer.discountSetting?.discountPercentage === 0) {
            const slug =
              game.productSlug ||
              (game.offerMappings || [{}])[0].pageSlug ||
              (game.catalogNs?.mappings || [{}])[0].pageSlug ||
              game.id;
            current.push({
              id: game.id,
              title,
              slug,
              originalPrice,
              startDate: offer.startDate,
              endDate: offer.endDate,
            });
          }
        }
      }

      // 即将免费
      for (const og of promotions.upcomingPromotionalOffers || []) {
        for (const offer of og.promotionalOffers || []) {
          if (offer.discountSetting?.discountPercentage === 0) {
            upcoming.push({
              id: game.id,
              title,
              originalPrice,
              startDate: offer.startDate,
              endDate: offer.endDate,
            });
          }
        }
      }
    }

    return { current, upcoming };
  }

  // ── 通知 ──────────────────────────────────────────────
  function notify(title, body) {
    GM_notification({
      title,
      text: body,
      tag: NOTIFICATION_TAG,
      timeout: 8000,
      onclick() {
        // 点击通知 → 聚焦/打开第一个免费游戏链接
        window.focus();
      },
    });
  }

  // ── 弹窗 UI ──────────────────────────────────────────
  function createPanel(currentGames, upcomingGames, state) {
    // 移除旧面板
    const old = document.getElementById('epic-free-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'epic-free-panel';
    panel.innerHTML = buildPanelHTML(currentGames, upcomingGames, state);
    document.body.appendChild(panel);

    bindPanelEvents(panel, currentGames, state);
  }

  function buildPanelHTML(current, upcoming, state) {
    const curHTML = current.length
      ? current
          .map((g, i) => {
            const claimed = state.reminders[g.id]?.claimed;
            const btnLabel = claimed ? '✓ 已领' : '去领取';
            const btnClass = claimed ? 'epic-btn-done' : 'epic-btn-go';
            return `
            <div class="epic-game-row">
              <span class="epic-game-title" title="${escapeHTML(g.title)}">${escapeHTML(g.title)}</span>
              <span class="epic-game-price">原¥${g.originalPrice}</span>
              <button class="${btnClass}" data-action="go" data-idx="${i}" data-id="${g.id}">${btnLabel}</button>
              ${claimed ? '' : `<button class="epic-btn-claim" data-action="claim" data-idx="${i}" data-id="${g.id}">标记已领</button>`}
            </div>`;
          })
          .join('')
      : '<div class="epic-no-game">今日暂无免费游戏</div>';

    const upHTML = upcoming.length
      ? upcoming
          .map((g) => {
            const start = g.startDate.slice(0, 10);
            return `
            <div class="epic-game-row epic-upcoming">
              <span class="epic-game-title">${escapeHTML(g.title)}</span>
              <span class="epic-game-price">原¥${g.originalPrice}</span>
              <span class="epic-game-start">${start} 开始</span>
            </div>`;
          })
          .join('')
      : '';

    return `
    <style>
      #epic-free-panel {
        position: fixed; bottom: 16px; right: 16px; z-index: 99999;
        width: 340px; max-height: 480px; overflow-y: auto;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid #0078F2; border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,120,242,0.25);
        font-family: -apple-system, 'Microsoft YaHei', sans-serif;
        font-size: 13px; color: #e0e0e0;
        padding: 16px; user-select: none;
        transition: transform 0.3s, opacity 0.3s;
      }
      #epic-free-panel.epic-minimized { transform: translateX(320px); }
      .epic-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 12px; cursor: move;
      }
      .epic-header-left { display: flex; align-items: center; gap: 8px; }
      .epic-logo { width: 24px; height: 24px; border-radius: 4px; }
      .epic-title { font-size: 15px; font-weight: 700; color: #fff; }
      .epic-btns { display: flex; gap: 6px; }
      .epic-btn-icon {
        background: none; border: 1px solid #444; color: #aaa;
        border-radius: 6px; cursor: pointer; padding: 2px 6px; font-size: 12px;
        transition: all 0.15s;
      }
      .epic-btn-icon:hover { background: #333; color: #fff; }
      .epic-section-label {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        color: #0078F2; margin: 10px 0 6px; letter-spacing: 0.5px;
      }
      .epic-game-row {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; margin: 4px 0;
        background: rgba(255,255,255,0.04); border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.06);
      }
      .epic-upcoming { opacity: 0.6; }
      .epic-game-title {
        flex: 1; font-weight: 500; color: #fff;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .epic-game-price { color: #999; font-size: 11px; min-width: 48px; }
      .epic-game-start { color: #0078F2; font-size: 11px; }
      .epic-btn-go, .epic-btn-claim, .epic-btn-done {
        border: none; border-radius: 6px; padding: 4px 10px;
        font-size: 12px; font-weight: 600; cursor: pointer;
        transition: all 0.15s; white-space: nowrap;
      }
      .epic-btn-go       { background: #0078F2; color: #fff; }
      .epic-btn-go:hover { background: #005ecb; }
      .epic-btn-claim    { background: transparent; color: #888; border: 1px solid #555; }
      .epic-btn-claim:hover { color: #fff; border-color: #fff; }
      .epic-btn-done     { background: #1b5e20; color: #a5d6a7; cursor: default; }
      .epic-no-game { text-align: center; color: #666; padding: 20px 0; }
      .epic-close { cursor: pointer; color: #666; font-size: 16px; line-height: 1; }
      .epic-close:hover { color: #f44336; }
    </style>
    <div class="epic-header">
      <div class="epic-header-left">
        <img class="epic-logo" src="https://www.epicgames.com/favicon.ico" alt="Epic">
        <span class="epic-title">🎮 Epic 限免</span>
      </div>
      <div class="epic-btns">
        <button class="epic-btn-icon" data-action="minimize" title="最小化">◀</button>
        <button class="epic-btn-icon epic-close" data-action="close" title="关闭">✕</button>
      </div>
    </div>
    <div class="epic-section-label">▼ 本周免费</div>
    ${curHTML}
    ${upcoming ? `<div class="epic-section-label">▼ 下周预告</div>${upHTML}` : ''}
    `;
  }

  function bindPanelEvents(panel, currentGames, state) {
    // 按钮事件
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const gameId = btn.dataset.id;

      if (action === 'go') {
        // 构造 Epic Store 领取链接：id 就是 product slug 的一部分
        // 实际跳转到搜索页或直接打开 store 页面
        const game = currentGames.find((g) => g.id === gameId);
        if (game) {
          window.open(STORE_BASE + game.slug, '_blank');
        }
      }

      if (action === 'claim') {
        state.reminders[gameId] = { notified: true, claimed: true };
        saveState(state);
        // 刷新面板
        createPanel(currentGames, [], state);
      }

      if (action === 'close') {
        panel.remove();
      }

      if (action === 'minimize') {
        panel.classList.toggle('epic-minimized');
        const btnEl = btn;
        btnEl.textContent = panel.classList.contains('epic-minimized') ? '▶' : '◀';
      }
    });

    // 拖拽
    let dragging = false,
      ox,
      oy;
    const header = panel.querySelector('.epic-header');
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      ox = e.clientX - panel.offsetLeft;
      oy = e.clientY - panel.offsetTop;
      panel.style.transition = 'none';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = e.clientX - ox + 'px';
      panel.style.top = e.clientY - oy + 'px';
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
      panel.style.transition = '';
    });
  }

  function escapeHTML(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ── 主流程 ────────────────────────────────────────────
  async function main() {
    const state = loadState();
    const today = todayStr();

    // 今天已检查过 → 只展示静态面板（不请求 API）
    if (state.lastCheckDate === today) {
      // 从存储中恢复上次的展示数据
      const cachedCurrent = state._cachedCurrent || [];
      const cachedUpcoming = state._cachedUpcoming || [];
      if (cachedCurrent.length > 0) {
        createPanel(cachedCurrent, cachedUpcoming, state);
      }
      return;
    }

    // 需要检查
    try {
      const data = await fetchFreeGames();
      const { current, upcoming } = parseFreeGames(data);

      // 更新存储
      state.lastCheckDate = today;
      state._cachedCurrent = current;
      state._cachedUpcoming = upcoming;

      // 找出新出现的免费游戏（之前没提醒过的）
      const newGames = current.filter((g) => {
        const r = state.reminders[g.id];
        return !r || (!r.claimed && !r.notified);
      });

      // 清理已过期的提醒记录
      const currentIds = new Set(current.map((g) => g.id));
      for (const id of Object.keys(state.reminders)) {
        if (!currentIds.has(id)) {
          delete state.reminders[id];
        }
      }

      // 标记新游戏为已通知
      for (const g of newGames) {
        state.reminders[g.id] = { notified: true, claimed: false };
      }
      saveState(state);

      // 弹通知
      if (newGames.length === 1) {
        const g = newGames[0];
        notify(
          `🎮 Epic 限免: ${g.title}`,
          `原价 ¥${g.originalPrice} → 免费！截止 ${g.endDate.slice(0, 10)}`
        );
      } else if (newGames.length >= 2) {
        const names = newGames.map((g) => g.title).join('、');
        notify(
          `🎮 Epic 本周限免 (${newGames.length}款)`,
          `${names} — 快去领取！`
        );
      }

      // 展示面板
      createPanel(current, upcoming, state);
    } catch (err) {
      console.warn('[Epic免费提醒] API请求失败:', err.message);
      // 失败不打扰用户，静默跳过
    }
  }

  // ── 启动 ──────────────────────────────────────────────
  // 延迟 3 秒启动，避免阻塞页面加载
  setTimeout(main, 3000);
})();
