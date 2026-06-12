// ==UserScript==
// @name         Epic 免费游戏提醒
// @namespace    https://huimeng.dpdns.org
// @version      2.0.2
// @author       洛诗
// @description  每天检查 Epic Games Store 免费游戏，弹窗提醒 + 一键跳转自动领取。支持倒计时、通知降级、触屏拖拽。
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

  // ═══════════════════════════════════════════════════════
  //  常量 & 配置
  // ═══════════════════════════════════════════════════════
  const CONFIG = {
    API_URL:
      'https://store-site-backend-static-ipv4.ak.epicgames.com/freeGamesPromotions?locale=zh-CN&country=CN&allowCountries=CN',
    STORE_BASE: 'https://store.epicgames.com/zh-CN/p/',
    STORAGE_KEY: 'epic_free_games_state',
    NOTIFICATION_TAG: 'epic-free-games',
    AUTO_CLAIM_FLAG: 'epic_auto_claim_slug',
    // 可配置项（通过 GM_setValue 覆写）
    RECHECK_INTERVAL_MIN: 180,   // 同一日内最小重新检查间隔（分钟）
    PANEL_DEFAULT_POS: { bottom: '16px', right: '16px' },
    REQUEST_TIMEOUT: 15000,
    MAX_RETRIES: 2,
    RETRY_DELAY: 2000,
  };

  const IS_EPIC =
    location.hostname === 'store.epicgames.com' ||
    location.hostname === 'www.epicgames.com';

  // 加载用户配置覆写
  function loadConfig() {
    const saved = GM_getValue('epic_config', null);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        Object.assign(CONFIG, parsed);
      } catch (_) { /* ignore */ }
    }
  }
  loadConfig();

  // ═══════════════════════════════════════════════════════
  //  存储读写
  // ═══════════════════════════════════════════════════════
  function loadState() {
    const raw = GM_getValue(CONFIG.STORAGE_KEY, null);
    if (!raw) return { lastCheckDate: '', lastCheckMs: 0, reminders: {} };
    try { return JSON.parse(raw); } catch (_) { return { lastCheckDate: '', lastCheckMs: 0, reminders: {} }; }
  }

  function saveState(state) {
    GM_setValue(CONFIG.STORAGE_KEY, JSON.stringify(state));
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  // ═══════════════════════════════════════════════════════
  //  API 请求（带重试）
  // ═══════════════════════════════════════════════════════
  function fetchFreeGames(retries = CONFIG.MAX_RETRIES) {
    return new Promise((resolve, reject) => {
      function attempt(n) {
        GM_xmlhttpRequest({
          method: 'GET',
          url: CONFIG.API_URL,
          timeout: CONFIG.REQUEST_TIMEOUT,
          onload(r) {
            if (r.status !== 200) {
              if (n > 0) return setTimeout(() => attempt(n - 1), CONFIG.RETRY_DELAY);
              return reject(new Error(`HTTP ${r.status}`));
            }
            try { resolve(JSON.parse(r.responseText)); } catch (e) { reject(e); }
          },
          onerror() {
            if (n > 0) return setTimeout(() => attempt(n - 1), CONFIG.RETRY_DELAY);
            reject(new Error('网络请求失败'));
          },
          ontimeout() {
            if (n > 0) return setTimeout(() => attempt(n - 1), CONFIG.RETRY_DELAY);
            reject(new Error('请求超时'));
          },
        });
      }
      attempt(retries);
    });
  }

  // ═══════════════════════════════════════════════════════
  //  解析免费游戏
  // ═══════════════════════════════════════════════════════
  function parseFreeGames(data) {
    const elements = data?.data?.Catalog?.searchStore?.elements;
    if (!Array.isArray(elements)) return { current: [], upcoming: [] };

    const current = [];
    const upcoming = [];
    const now = new Date();

    for (const game of elements) {
      // 跳过非游戏类目（DLC/捆绑包/编辑器等）
      const categories = (game.categories || []).map((c) => c.path);
      const isGame =
        categories.includes('games') ||
        categories.includes('games/edition') ||
        categories.includes('games/edition/base') ||
        (!categories.includes('addons') &&
          !categories.includes('editors') &&
          !categories.includes('bundles') &&
          !categories.includes('applications') &&
          game.offerType === 'BASE_GAME');
      if (!isGame) continue;

      const title = game.title || '未知游戏';
      const priceInfo = game.price?.totalPrice || {};
      const originalPrice = (priceInfo.originalPrice || 0) / 100;
      const discountPrice = (priceInfo.discountPrice || 0) / 100;
      const promotions = game.promotions;
      if (!promotions) continue;

      // 辅助：提取 slug
      function extractSlug(g) {
        return (
          g.productSlug ||
          (g.offerMappings || [{}])[0].pageSlug ||
          (g.catalogNs?.mappings || [{}])[0].pageSlug ||
          g.id
        );
      }

      // 当前免费：promotionalOffers + discountPrice === 0
      for (const og of promotions.promotionalOffers || []) {
        for (const offer of og.promotionalOffers || []) {
          const discountPct = offer.discountSetting?.discountPercentage ?? -1;
          // 双重验证：折扣百分比为 0（或 100）且实际售价为 0
          if ((discountPct === 0 || discountPct === 100) && discountPrice === 0) {
            const slug = extractSlug(game);
            const endDate = new Date(offer.endDate);
            current.push({
              id: game.id,
              title,
              slug,
              originalPrice,
              endDate: offer.endDate,
              startDate: offer.startDate,
              endMs: endDate.getTime(),
            });
          }
        }
      }

      // 即将免费：upcomingPromotionalOffers + discountPrice === 0
      for (const og of promotions.upcomingPromotionalOffers || []) {
        for (const offer of og.promotionalOffers || []) {
          const discountPct = offer.discountSetting?.discountPercentage ?? -1;
          if ((discountPct === 0 || discountPct === 100) && discountPrice === 0) {
            const startDate = new Date(offer.startDate);
            // 排除已过开始时间的（已经是当前免费了）
            if (startDate > now) {
              upcoming.push({
                id: game.id,
                title,
                originalPrice,
                startDate: offer.startDate,
                endDate: offer.endDate,
                startMs: startDate.getTime(),
              });
            }
          }
        }
      }
    }

    // 按结束时间排序当前免费，按开始时间排序即将免费
    current.sort((a, b) => a.endMs - b.endMs);
    upcoming.sort((a, b) => a.startMs - b.startMs);

    return { current, upcoming };
  }

  // ═══════════════════════════════════════════════════════
  //  通知系统（GM_notification + 页面 toast 降级）
  // ═══════════════════════════════════════════════════════
  function notify(title, body, onClick) {
    let notified = false;

    // 尝试 GM_notification
    try {
      GM_notification({
        title,
        text: body,
        tag: CONFIG.NOTIFICATION_TAG,
        timeout: 8000,
        onclick() {
          window.focus();
          if (onClick) onClick();
        },
        ondone() {
          notified = true;
        },
      });
      // 如果 GM_notification 同步抛错或静默失败，降级到 toast
      setTimeout(() => {
        if (!notified && !document.getElementById('epic-toast')) {
          showToast(title, body);
        }
      }, 500);
    } catch (_) {
      showToast(title, body);
    }
  }

  /** 页面内 toast 降级通知 */
  function showToast(title, body) {
    const old = document.getElementById('epic-toast');
    if (old) old.remove();

    const toast = document.createElement('div');
    toast.id = 'epic-toast';
    toast.innerHTML = `
      <style>
        #epic-toast {
          position: fixed; top: 16px; right: 16px; z-index: 100000;
          min-width: 260px; max-width: 360px;
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          border: 1px solid #0078F2; border-radius: 10px;
          padding: 14px 16px;
          box-shadow: 0 4px 24px rgba(0,120,242,0.3);
          font-family: -apple-system, 'Microsoft YaHei', sans-serif;
          color: #e0e0e0; font-size: 13px;
          animation: epicSlideIn 0.35s ease;
          cursor: pointer;
        }
        @keyframes epicSlideIn {
          from { transform: translateX(120%); opacity: 0; }
          to   { transform: translateX(0);    opacity: 1; }
        }
        @keyframes epicSlideOut {
          from { transform: translateX(0);    opacity: 1; }
          to   { transform: translateX(120%); opacity: 0; }
        }
        .epic-toast-title { font-weight: 700; color: #fff; margin-bottom: 4px; }
        .epic-toast-body  { color: #aaa; font-size: 12px; }
        .epic-toast-close { position: absolute; top: 4px; right: 8px; color: #666; cursor: pointer; font-size: 14px; }
        .epic-toast-close:hover { color: #f44336; }
      </style>
      <span class="epic-toast-close">✕</span>
      <div class="epic-toast-title">${escapeHTML(title)}</div>
      <div class="epic-toast-body">${escapeHTML(body)}</div>
    `;
    document.body.appendChild(toast);

    toast.querySelector('.epic-toast-close').addEventListener('click', () => dismissToast(toast));
    toast.addEventListener('click', (e) => {
      if (e.target.classList.contains('epic-toast-close')) return;
      dismissToast(toast);
    });

    setTimeout(() => dismissToast(toast), 8000);
  }

  function dismissToast(el) {
    el.style.animation = 'epicSlideOut 0.3s ease forwards';
    setTimeout(() => el.remove(), 300);
  }

  // ═══════════════════════════════════════════════════════
  //  自动领取（仅在 store.epicgames.com 下运行）
  // ═══════════════════════════════════════════════════════

  function findClaimButton() {
    const keywords = ['获取', '立即获取', 'get', 'free', '免费', '入库', '领取'];
    const allBtns = document.querySelectorAll('button, a[role="button"], span[role="button"]');

    for (const btn of allBtns) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (/已在库中|in library|已拥有|owned/i.test(text)) return null;

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

  function findConfirmButton() {
    const keywords = ['添加到库', '下单', '确认', '入库', '立即购买', 'add to library', 'place order', 'confirm', '提交订单', '购买', 'purchase', 'checkout', 'get', '免费', '领取'];
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

  function findConfirmInIframe() {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const doc = iframe.contentDocument || iframe.contentWindow.document;
        if (!doc) continue;
        const btns = doc.querySelectorAll('button');
        for (const btn of btns) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (/添加到库|下单|确认|入库|立即购买|place order|confirm|purchase|checkout|get library|add to library/i.test(text)) {
            if (btn.offsetParent !== null && !btn.disabled) {
              return btn;
            }
          }
        }
      } catch (_) { /* 跨域 iframe */ }
    }
    return null;
  }

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

  /** 更可靠的登录检测 */
  function isLoggedIn() {
    // 多种信号：有用户头像/菜单、无显式登录按钮
    const hasUserMenu =
      document.querySelector('[data-testid="user-menu"], [aria-label*="账户"], [aria-label*="Account"]') !== null;
    const hasAvatar = document.querySelector('img[alt*="avatar"], .user-avatar, [data-testid="avatar"]') !== null;
    const signInBtn = document.querySelector('a[href*="/login"], [data-testid="sign-in-link"]');
    const signInVisible = signInBtn && signInBtn.offsetParent !== null;

    // 已登录 = 有用户组件 或 没有可见的登录按钮
    return hasUserMenu || hasAvatar || !signInVisible;
  }

  /** 安全点击 — 兼容 React 合成事件 */
  function safeClick(el) {
    if (!el) return;
    // 先尝试原生 click
    el.click();
    // 再派发完整的 MouseEvent 确保 React 事件系统能捕获
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
  }

  async function autoClaim(targetSlug) {
    console.log('[Epic免费提醒] 开始自动领取:', targetSlug);

    // Step 1: 等页面渲染，找"获取"按钮
    const claimBtn = await waitFor(findClaimButton, 15000, 500);
    if (!claimBtn) {
      console.log('[Epic免费提醒] 未找到"获取"按钮 — 可能已拥有或页面未加载完毕');
      return 'NO_BUTTON';
    }

    console.log('[Epic免费提醒] 找到获取按钮:', claimBtn.textContent.trim(), '→ 点击...');
    safeClick(claimBtn);

    // Step 2: 等待确认弹窗（Epic 结账弹窗可能较慢）
    await new Promise((r) => setTimeout(r, 3000));

    // 先尝试主页面找确认按钮
    let confirmBtn = await waitFor(findConfirmButton, 10000, 400);

    // 如果没找到，尝试 iframe
    if (!confirmBtn) {
      console.log('[Epic免费提醒] 主页面未找到确认按钮，尝试 iframe...');
      confirmBtn = await waitFor(findConfirmInIframe, 5000, 400);
    }

    // 如果还没找到，再等 3 秒重试一次（Epic 弹窗有时延迟渲染）
    if (!confirmBtn) {
      console.log('[Epic免费提醒] 第一轮未找到，等待 3s 重试...');
      await new Promise((r) => setTimeout(r, 3000));
      confirmBtn = await waitFor(findConfirmButton, 8000, 400) ||
                   await waitFor(findConfirmInIframe, 5000, 400);
    }

    if (!confirmBtn) {
      console.log('[Epic免费提醒] 未找到确认按钮 — 页面 DOM 快照:');
      // 打印所有可见按钮帮助调试
      const visibleBtns = Array.from(document.querySelectorAll('button, a[role="button"], span[role="button"]'))
        .filter(b => b.offsetParent !== null)
        .map(b => b.textContent.trim().substring(0, 40))
        .filter(Boolean);
      console.log('  可见按钮:', visibleBtns.join(' | '));
      return 'NO_CONFIRM';
    }

    console.log('[Epic免费提醒] 找到确认按钮:', confirmBtn.textContent.trim(), '→ 点击...');
    safeClick(confirmBtn);

    // Step 3: 等待结果
    await new Promise((r) => setTimeout(r, 3000));

    console.log('[Epic免费提醒] 自动领取流程完成 ✓');
    return 'OK';
  }

  // ═══════════════════════════════════════════════════════
  //  面板 UI
  // ═══════════════════════════════════════════════════════

  /** 倒计时格式化 */
  function formatCountdown(endMs) {
    const diff = endMs - Date.now();
    if (diff <= 0) return '已结束';
    const days = Math.floor(diff / 86400000);
    const hours = Math.floor((diff % 86400000) / 3600000);
    if (days > 0) return `${days}天${hours}小时`;
    if (hours > 0) {
      const mins = Math.floor((diff % 3600000) / 60000);
      return `${hours}小时${mins}分`;
    }
    const mins = Math.floor(diff / 60000);
    return `${mins}分钟`;
  }

  function createPanel(currentGames, upcomingGames, state) {
    const old = document.getElementById('epic-free-panel');
    if (old) old.remove();

    const panel = document.createElement('div');
    panel.id = 'epic-free-panel';
    panel.innerHTML = buildPanelHTML(currentGames, upcomingGames, state);
    document.body.appendChild(panel);

    bindPanelEvents(panel, currentGames, state);

    // 启动倒计时更新定时器
    if (currentGames.length > 0) {
      const timerId = setInterval(() => updateCountdowns(panel, currentGames), 30000);
      panel._countdownTimer = timerId;
    }

    return panel;
  }

  function updateCountdowns(panel, currentGames) {
    const rows = panel.querySelectorAll('.epic-game-row');
    const now = Date.now();
    currentGames.forEach((g, i) => {
      const cdEl = rows[i]?.querySelector('.epic-countdown');
      if (cdEl) {
        const remaining = formatCountdown(g.endMs);
        cdEl.textContent = remaining;
        // 少于 2 小时高亮
        if (g.endMs - now < 7200000) {
          cdEl.style.color = '#ff6b6b';
        }
      }
    });
  }

  function buildPanelHTML(current, upcoming, state) {
    const curHTML = current.length
      ? current
          .map((g) => {
            const claimed = state.reminders[g.id]?.claimed;
            const btnLabel = claimed ? '✓ 已领' : '去领取';
            const btnClass = claimed ? 'epic-btn-done' : 'epic-btn-go';
            const countdown = formatCountdown(g.endMs);
            return `
            <div class="epic-game-row">
              <span class="epic-game-title" title="${escapeHTML(g.title)}">${escapeHTML(g.title)}</span>
              <span class="epic-game-price">原¥${g.originalPrice}</span>
              <span class="epic-countdown">${countdown}</span>
              <button class="${btnClass}" data-action="go" data-id="${g.id}" data-slug="${g.slug}">${btnLabel}</button>
              ${claimed ? '' : `<button class="epic-btn-claim" data-action="claim" data-id="${g.id}">标记</button>`}
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
        width: 360px; max-height: 500px; overflow-y: auto;
        background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
        border: 1px solid #0078F2; border-radius: 14px;
        box-shadow: 0 8px 32px rgba(0,120,242,0.25);
        font-family: -apple-system, 'Microsoft YaHei', sans-serif;
        font-size: 13px; color: #e0e0e0;
        padding: 16px; user-select: none;
        transition: transform 0.3s, opacity 0.3s;
        /* 滚动条美化 */
        scrollbar-width: thin;
        scrollbar-color: #0078F2 #1a1a2e;
      }
      #epic-free-panel::-webkit-scrollbar { width: 4px; }
      #epic-free-panel::-webkit-scrollbar-track { background: #1a1a2e; }
      #epic-free-panel::-webkit-scrollbar-thumb { background: #0078F2; border-radius: 2px; }
      #epic-free-panel.epic-minimized { max-height: 46px; overflow: hidden; }
      .epic-header {
        display: flex; align-items: center; justify-content: space-between;
        margin-bottom: 12px; cursor: grab;
      }
      .epic-header:active { cursor: grabbing; }
      .epic-header-left { display: flex; align-items: center; gap: 8px; }
      .epic-logo { width: 24px; height: 24px; border-radius: 6px; }
      .epic-title { font-size: 15px; font-weight: 700; color: #fff; }
      .epic-btns { display: flex; gap: 6px; }
      .epic-btn-icon {
        background: none; border: 1px solid #444; color: #aaa;
        border-radius: 6px; cursor: pointer; padding: 2px 6px; font-size: 12px;
        transition: all 0.15s; line-height: 1.4;
      }
      .epic-btn-icon:hover { background: #333; color: #fff; }
      .epic-section-label {
        font-size: 11px; font-weight: 600; text-transform: uppercase;
        color: #0078F2; margin: 10px 0 6px; letter-spacing: 0.5px;
        display: flex; align-items: center; gap: 6px;
      }
      .epic-section-label::after {
        content: ''; flex: 1; height: 1px; background: rgba(0,120,242,0.2);
      }
      .epic-game-row {
        display: flex; align-items: center; gap: 6px;
        padding: 8px 10px; margin: 4px 0;
        background: rgba(255,255,255,0.04); border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.06);
        transition: background 0.15s;
      }
      .epic-game-row:hover { background: rgba(255,255,255,0.08); }
      .epic-upcoming { opacity: 0.55; }
      .epic-game-title {
        flex: 1; font-weight: 500; color: #fff; min-width: 0;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .epic-game-price { color: #888; font-size: 11px; min-width: 44px; text-align: right; }
      .epic-game-start { color: #0078F2; font-size: 11px; white-space: nowrap; }
      .epic-countdown {
        color: #66bb6a; font-size: 11px; min-width: 52px; text-align: right;
        white-space: nowrap; font-variant-numeric: tabular-nums;
      }
      .epic-btn-go, .epic-btn-claim, .epic-btn-done {
        border: none; border-radius: 6px; padding: 4px 8px;
        font-size: 11px; font-weight: 600; cursor: pointer;
        transition: all 0.15s; white-space: nowrap;
      }
      .epic-btn-go       { background: #0078F2; color: #fff; }
      .epic-btn-go:hover { background: #005ecb; transform: scale(1.05); }
      .epic-btn-claim    { background: transparent; color: #777; border: 1px solid #444; }
      .epic-btn-claim:hover { color: #ccc; border-color: #888; }
      .epic-btn-done     { background: #1b5e20; color: #a5d6a7; cursor: default; }
      .epic-no-game { text-align: center; color: #555; padding: 24px 0; font-size: 13px; }
      .epic-close { cursor: pointer; color: #666; font-size: 15px; line-height: 1; }
      .epic-close:hover { color: #f44336; }
      .epic-footer {
        margin-top: 10px; padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,0.08);
        font-size: 10px; color: #555;
        display: flex; justify-content: space-between; align-items: center;
      }
      .epic-refresh-btn {
        background: none; border: 1px solid #333; color: #666;
        border-radius: 4px; cursor: pointer; font-size: 10px; padding: 2px 8px;
        transition: all 0.15s;
      }
      .epic-refresh-btn:hover { color: #fff; border-color: #0078F2; }
    </style>
    <div class="epic-header">
      <div class="epic-header-left">
        <img class="epic-logo" src="https://store.epicgames.com/favicon.ico" alt="Epic">
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
    <div class="epic-footer">
      <span id="epic-check-time"></span>
      <button class="epic-refresh-btn" data-action="refresh">🔄 刷新</button>
    </div>
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
          sessionStorage.setItem(CONFIG.AUTO_CLAIM_FLAG, game.slug);
          window.open(CONFIG.STORE_BASE + game.slug, '_blank');
        }
      }

      if (action === 'claim') {
        state.reminders[gameId] = { notified: true, claimed: true };
        saveState(state);
        // 重建面板以更新按钮状态
        const upcoming = state._cachedUpcoming || [];
        createPanel(currentGames, upcoming, state);
      }

      if (action === 'close') {
        if (panel._countdownTimer) clearInterval(panel._countdownTimer);
        // 记录今天已关闭，当天不再弹出
        state._panelDismissedToday = todayStr();
        saveState(state);
        panel.remove();
      }

      if (action === 'minimize') {
        panel.classList.toggle('epic-minimized');
        btn.textContent = panel.classList.contains('epic-minimized') ? '▶' : '◀';
      }

      if (action === 'refresh') {
        btn.textContent = '⏳';
        btn.disabled = true;
        // 强制重新检查
        state.lastCheckDate = '';
        state.lastCheckMs = 0;
        saveState(state);
        // 重新走一遍主流程
        if (panel._countdownTimer) clearInterval(panel._countdownTimer);
        panel.remove();
        setTimeout(() => thirdPartyMain(true), 500);
      }
    });

    // 触屏 + 鼠标拖拽
    bindDrag(panel);

    // 设置检查时间
    const checkTimeEl = panel.querySelector('#epic-check-time');
    if (checkTimeEl && state.lastCheckDate) {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      checkTimeEl.textContent = `上次检查 ${h}:${m}`;
    }
  }

  function bindDrag(panel) {
    const header = panel.querySelector('.epic-header');
    let dragging = false, startX, startY, startLeft, startTop;
    // 记录初始位置
    let panelLeft = panel.offsetLeft;
    let panelTop = panel.offsetTop;

    function onStart(e) {
      if (e.target.closest('button')) return;
      dragging = true;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;

      // 切换到绝对定位
      const rect = panel.getBoundingClientRect();
      panelLeft = rect.left;
      panelTop = rect.top;
      panel.style.left = panelLeft + 'px';
      panel.style.top = panelTop + 'px';
      panel.style.bottom = 'auto';
      panel.style.right = 'auto';
      panel.style.transition = 'none';

      startX = clientX;
      startY = clientY;
      startLeft = panelLeft;
      startTop = panelTop;

      e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const dx = clientX - startX;
      const dy = clientY - startY;

      // 限制不超出视口
      const newLeft = Math.max(0, Math.min(window.innerWidth - panel.offsetWidth, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, startTop + dy));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    }

    function onEnd() {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
    }

    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
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
    const targetSlug = sessionStorage.getItem(CONFIG.AUTO_CLAIM_FLAG);
    if (!targetSlug) return;

    // 验证当前 URL 是否匹配
    if (!location.pathname.includes(targetSlug)) return;

    // 等待页面加载（Epic 是 React SPA，需要更长时间渲染）
    await new Promise((r) => setTimeout(r, 4000));

    // 检测登录状态
    if (!isLoggedIn()) {
      sessionStorage.removeItem(CONFIG.AUTO_CLAIM_FLAG);
      console.log('[Epic免费提醒] 未登录，跳过自动领取');
      // toast 提示用户登录
      showToast('🔐 需要登录', '请先登录 Epic 账户后再领取免费游戏');
      return;
    }

    const result = await autoClaim(targetSlug);

    // 无论成功失败，都清理标记
    sessionStorage.removeItem(CONFIG.AUTO_CLAIM_FLAG);

    if (result === 'OK') {
      // 标记为已领取
      const state = loadState();
      const cachedCurrent = state._cachedCurrent || [];
      const matchedGame = cachedCurrent.find((g) => g.slug === targetSlug);
      if (matchedGame) {
        state.reminders[matchedGame.id] = { notified: true, claimed: true };
        saveState(state);
      }
      notify('✅ Epic 已领取', '成功领取免费游戏！');
    } else if (result === 'NO_BUTTON') {
      // 检测是否「已在库中」— 自动标记为已领取
      const bodyText = document.body.innerText;
      const alreadyOwned = /已在库中|in library|已拥有|owned/i.test(bodyText);
      if (alreadyOwned) {
        const state = loadState();
        const cachedCurrent = state._cachedCurrent || [];
        const matchedGame = cachedCurrent.find((g) => g.slug === targetSlug);
        if (matchedGame) {
          state.reminders[matchedGame.id] = { notified: true, claimed: true };
          saveState(state);
          console.log('[Epic免费提醒] 检测到「已在库中」，自动标记已领取:', matchedGame.title);
        }
      } else {
        console.log('[Epic免费提醒] 未找到领取按钮，可能已拥有或需手动操作');
      }
    } else if (result === 'NO_CONFIRM') {
      console.log('[Epic免费提醒] 确认弹窗未出现，可能需手动确认');
    }
  }

  // ── 第三方页面：主检查 + 面板 ──
  async function thirdPartyMain(forceRefresh = false) {
    const state = loadState();
    const today = todayStr();
    const now = Date.now();

    // 判断是否需要重新请求
    const isSameDay = state.lastCheckDate === today;
    const recheckMs = CONFIG.RECHECK_INTERVAL_MIN * 60 * 1000;
    const withinInterval = state.lastCheckMs && (now - state.lastCheckMs) < recheckMs;

    if (!forceRefresh && isSameDay && withinInterval) {
      // 如果今天已关闭过面板，静默跳过
      if (state._panelDismissedToday === today) return;

      // 使用缓存
      const cachedCurrent = state._cachedCurrent || [];
      const cachedUpcoming = state._cachedUpcoming || [];
      if (cachedCurrent.length > 0 || cachedUpcoming.length > 0) {
        createPanel(cachedCurrent, cachedUpcoming, state);
      }
      return;
    }

    try {
      const data = await fetchFreeGames();
      const { current, upcoming } = parseFreeGames(data);

      state.lastCheckDate = today;
      state.lastCheckMs = now;
      state._cachedCurrent = current;
      state._cachedUpcoming = upcoming;

      // 计算新游戏（未通知过的）
      const newGames = current.filter((g) => {
        const r = state.reminders[g.id];
        return !r || (!r.claimed && !r.notified);
      });

      // 清理已过期的游戏提醒记录
      const currentIds = new Set(current.map((g) => g.id));
      for (const id of Object.keys(state.reminders)) {
        if (!currentIds.has(id)) delete state.reminders[id];
      }

      // 标记新游戏为已通知
      for (const g of newGames) {
        state.reminders[g.id] = { notified: true, claimed: false };
      }
      saveState(state);

      // 通知
      if (newGames.length === 1) {
        const g = newGames[0];
        notify(
          `🎮 Epic 限免: ${g.title}`,
          `原价 ¥${g.originalPrice} → 免费！截止 ${g.endDate.slice(0, 10)}`,
          () => window.open(CONFIG.STORE_BASE + g.slug, '_blank')
        );
      } else if (newGames.length >= 2) {
        const names = newGames.map((g) => g.title).join('、');
        notify(`🎮 Epic 本周限免 (${newGames.length}款)`, `${names} — 快去领取！`);
      }

      // 展示面板（如果今天未关闭过）
      if (state._panelDismissedToday !== today) {
        createPanel(current, upcoming, state);
      } else {
        console.log('[Epic免费提醒] 今天已关闭面板，跳过显示');
      }
    } catch (err) {
      console.warn('[Epic免费提醒] API请求失败:', err.message);

      // 如果有缓存，降级显示缓存（如果今天未关闭过）
      if (state._panelDismissedToday !== today) {
        const cachedCurrent = state._cachedCurrent || [];
        const cachedUpcoming = state._cachedUpcoming || [];
        if (cachedCurrent.length > 0 || cachedUpcoming.length > 0) {
          createPanel(cachedCurrent, cachedUpcoming, state);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  //  入口
  // ═══════════════════════════════════════════════════════
  if (IS_EPIC) {
    // Epic 页面：等待 DOM 稳定后检测领取
    if (document.readyState === 'complete') {
      setTimeout(epicPageMain, 2000);
    } else {
      window.addEventListener('load', () => setTimeout(epicPageMain, 2000));
    }
  } else {
    // 第三方页面：延迟启动避免影响页面加载
    if (document.readyState === 'complete') {
      setTimeout(thirdPartyMain, 3000);
    } else {
      window.addEventListener('load', () => setTimeout(thirdPartyMain, 3000));
    }
  }
})();
