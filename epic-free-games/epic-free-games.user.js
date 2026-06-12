// ==UserScript==
// @name         Epic 免费游戏提醒
// @namespace    https://huimeng.dpdns.org
// @version      1.1.0
// @author       洛诗
// @description  每天检查 Epic Games Store 免费游戏，弹窗提醒 + 一键跳转自动领取
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      store-site-backend-static-ipv4.ak.epicgames.com
// @updateURL    https://raw.githubusercontent.com/LHuiMeng/tampermonkey-scripts/main/epic-free-games/epic-free-games.user.js
// @downloadURL  https://raw.githubusercontent.com/LHuiMeng/tampermonkey-scripts/main/epic-free-games/epic-free-games.user.js
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
  const AUTO_CLAIM_FLAG = 'epic_auto_claim_slug';

  const IS_EPIC =
    location.hostname === 'store.epicgames.com' ||
    location.hostname === 'www.epicgames.com';

  // ── 存储读写 ──────────────────────────────────────────
  function loadState() {
    const raw = GM_getValue(STORAGE_KEY, null);
    if (!raw) return { lastCheckDate: '', reminders: {} };
    try { return JSON.parse(raw); } catch (_) { return { lastCheckDate: '', reminders: {} }; }
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
          if (r.status !== 200) return reject(new Error(`HTTP ${r.status}`));
          try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
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
      onclick() { window.focus(); },
    });
  }

  // ═══════════════════════════════════════════════════════
  //  自动领取（仅在 store.epicgames.com 下运行）
  // ═══════════════════════════════════════════════════════

  /** 查找页面上"获取"类按钮 */
  function findClaimButton() {
    // 遍历所有可见按钮，匹配"获取"/"GET"/"Free"等文字
    const keywords = ['获取', 'get', 'free', '免费', '立即获取', '入库'];
    const allBtns = document.querySelectorAll('button, a[role="button"], span[role="button"]');

    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim().toLowerCase();
      // 排除"已在库中"/"in library"等已领取标识
      if (/已在库中|in library|已拥有|owned/i.test(text)) return null;

      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          // 确认按钮可见且可点击
          if (btn.offsetParent !== null && !btn.disabled) {
            return btn;
          }
        }
      }
    }
    return null;
  }

  /** 查找确认弹窗中的"下单"/"确认"按钮 */
  function findConfirmButton() {
    const keywords = ['下单', '确认', 'place order', 'confirm', '提交订单', '购买', 'purchase', 'checkout'];
    const allBtns = document.querySelectorAll('button, a[role="button"], span[role="button"]');

    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim().toLowerCase();
      for (const kw of keywords) {
        if (text.includes(kw.toLowerCase())) {
          if (btn.offsetParent !== null && !btn.disabled) {
            return btn;
          }
        }
      }
    }
    return null;
  }

  /** 查找确认弹窗中的下单按钮（iframe 内） */
  function findConfirmInIframe() {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc) continue;
        const btns = doc.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (/下单|确认|place order|confirm|purchase|checkout/.test(text)) {
            if (btn.offsetParent !== null && !btn.disabled) {
              return btn;
            }
          }
        }
      } catch (_) {
        // 跨域 iframe 无法访问，跳过
      }
    }
    return null;
  }

  /** 等待元素出现 */
  function waitFor(fn, timeout = 8000, interval = 300) {
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const result = fn();
        if (result) {
          clearInterval(timer);
          resolve(result);
        } else if (Date.now() - start > timeout) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  /** 核心：自动领取流程 */
  async function autoClaim(targetSlug) {
    console.log('[Epic免费提醒] 开始自动领取:', targetSlug);

    // Step 1: 等页面渲染完成，找"获取"按钮
    const claimBtn = await waitFor(findClaimButton, 10000, 500);
    if (!claimBtn) {
      console.log('[Epic免费提醒] 未找到"获取"按钮 — 可能已登录但游戏非免费、或已拥有');
      return 'NO_BUTTON';
    }

    console.log('[Epic免费提醒] 找到获取按钮，点击...');
    claimBtn.click();

    // Step 2: 等待确认弹窗出现（可能在 iframe 或主页面 overlay 中）
    // 先等一小段让弹窗渲染
    await new Promise((r) => setTimeout(r, 1500));

    const confirmBtn =
      (await waitFor(findConfirmButton, 6000, 400)) ||
      (await waitFor(findConfirmInIframe, 4000, 400));

    if (!confirmBtn) {
      console.log('[Epic免费提醒] 未找到确认按钮 — 可能弹窗未出现或需要手动操作');
      return 'NO_CONFIRM';
    }

    console.log('[Epic免费提醒] 找到确认按钮，点击下单...');
    confirmBtn.click();

    // Step 3: 等待结果（成功/失败提示）
    await new Promise((r) => setTimeout(r, 2000));

    // 清除自动领取标记
    sessionStorage.removeItem(AUTO_CLAIM_FLAG);
    console.log('[Epic免费提醒] 自动领取流程完成 ✓');
    return 'OK';
  }

  // ── 弹窗 UI ──────────────────────────────────────────
  function createPanel(currentGames, upcomingGames, state) {
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
          .map((g) => {
            const claimed = state.reminders[g.id]?.claimed;
            const btnLabel = claimed ? '✓ 已领' : '去领取';
            const btnClass = claimed ? 'epic-btn-done' : 'epic-btn-go';
            return `
            <div class="epic-game-row">
              <span class="epic-game-title" title="${escapeHTML(g.title)}">${escapeHTML(g.title)}</span>
              <span class="epic-game-price">原¥${g.originalPrice}</span>
              <button class="${btnClass}" data-action="go" data-id="${g.id}" data-slug="${g.slug}">${btnLabel}</button>
              ${claimed ? '' : `<button class="epic-btn-claim" data-action="claim" data-id="${g.id}">标记已领</button>`}
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
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const action = btn.dataset.action;
      const gameId = btn.dataset.id;

      if (action === 'go') {
        const game = currentGames.find((g) => g.id === gameId);
        if (game) {
          // 设置自动领取标记
          sessionStorage.setItem(AUTO_CLAIM_FLAG, game.slug);
          window.open(STORE_BASE + game.slug, '_blank');
        }
      }

      if (action === 'claim') {
        state.reminders[gameId] = { notified: true, claimed: true };
        saveState(state);
        createPanel(currentGames, [], state);
      }

      if (action === 'close') panel.remove();

      if (action === 'minimize') {
        panel.classList.toggle('epic-minimized');
        btn.textContent = panel.classList.contains('epic-minimized') ? '▶' : '◀';
      }
    });

    // 拖拽
    let dragging = false, ox, oy;
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

  // ═══════════════════════════════════════════════════════
  //  主流程
  // ═══════════════════════════════════════════════════════

  // ── Epic 页面：检测自动领取标记 ──
  async function epicPageMain() {
    const targetSlug = sessionStorage.getItem(AUTO_CLAIM_FLAG);
    if (!targetSlug) return; // 没有自动领取标记，正常浏览

    // 验证当前页面 URL 是否匹配目标
    if (!location.pathname.includes(targetSlug)) return;

    // 延迟等页面加载
    await new Promise((r) => setTimeout(r, 2000));

    // 先检查是否已登录
    const loginBtn = document.querySelector('[data-testid="sign-in-link"], a[href*="login"]');
    // 简单检测：有登录按钮 = 未登录，有用户头像/名称 = 已登录
    const loggedIn = !document.querySelector('a[href*="/login"]');

    if (!loggedIn) {
      // 未登录：清除标记，不做操作（用户需要手动登录后再领取）
      sessionStorage.removeItem(AUTO_CLAIM_FLAG);
      console.log('[Epic免费提醒] 未登录，跳过自动领取');
      return;
    }

    const result = await autoClaim(targetSlug);

    if (result === 'OK') {
      // 自动标记为已领取
      const state = loadState();
      // 从当前 URL 反查 game id...实际上我们只有 slug，那就遍历存储找匹配
      const cachedCurrent = state._cachedCurrent || [];
      const matchedGame = cachedCurrent.find((g) => g.slug === targetSlug);
      if (matchedGame) {
        state.reminders[matchedGame.id] = { notified: true, claimed: true };
        saveState(state);
      }
      notify('✅ Epic 已领取', `成功领取免费游戏！`);
    } else if (result === 'NO_BUTTON') {
      console.log('[Epic免费提醒] 未找到获取按钮，可能需要手动操作');
    }
  }

  // ── 第三方页面：检查 API + 展示面板 ──
  async function thirdPartyMain() {
    const state = loadState();
    const today = todayStr();

    if (state.lastCheckDate === today) {
      const cachedCurrent = state._cachedCurrent || [];
      const cachedUpcoming = state._cachedUpcoming || [];
      if (cachedCurrent.length > 0) {
        createPanel(cachedCurrent, cachedUpcoming, state);
      }
      return;
    }

    try {
      const data = await fetchFreeGames();
      const { current, upcoming } = parseFreeGames(data);

      state.lastCheckDate = today;
      state._cachedCurrent = current;
      state._cachedUpcoming = upcoming;

      const newGames = current.filter((g) => {
        const r = state.reminders[g.id];
        return !r || (!r.claimed && !r.notified);
      });

      const currentIds = new Set(current.map((g) => g.id));
      for (const id of Object.keys(state.reminders)) {
        if (!currentIds.has(id)) delete state.reminders[id];
      }

      for (const g of newGames) {
        state.reminders[g.id] = { notified: true, claimed: false };
      }
      saveState(state);

      if (newGames.length === 1) {
        const g = newGames[0];
        notify(`🎮 Epic 限免: ${g.title}`, `原价 ¥${g.originalPrice} → 免费！截止 ${g.endDate.slice(0, 10)}`);
      } else if (newGames.length >= 2) {
        const names = newGames.map((g) => g.title).join('、');
        notify(`🎮 Epic 本周限免 (${newGames.length}款)`, `${names} — 快去领取！`);
      }

      createPanel(current, upcoming, state);
    } catch (err) {
      console.warn('[Epic免费提醒] API请求失败:', err.message);
    }
  }

  // ── 入口 ──────────────────────────────────────────────
  if (IS_EPIC) {
    setTimeout(epicPageMain, 2000);
  } else {
    setTimeout(thirdPartyMain, 3000);
  }
})();
