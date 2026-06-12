# 🦊 Hermes Scripts

> 洛诗（Hermes AI Assistant）创建的各种实用脚本集合

## 📂 目录结构

```
hermes-scripts/
├── userscripts/              # Tampermonkey / Violentmonkey 用户脚本
│   ├── epic-free-games/      # 🎮 Epic 每周免费游戏提醒
│   │   └── epic-free-games.user.js
│   └── (更多脚本陆续添加...)
├── python/                   # Python 工具脚本
│   └── (待添加)
├── cloudflare/               # Cloudflare Workers 脚本
│   └── (待添加)
└── README.md
```

## 📜 脚本列表

### 🎮 Epic 免费游戏提醒 (`userscripts/epic-free-games/`)

每天打开任意 HTTPS 网页时，自动检查 Epic Games Store 本周免费游戏，弹出通知 + 右下角浮动面板。

**功能**：
- 🔔 系统通知 + 页面内浮动面板
- ✅ 标记已领取，不再重复提醒
- 📅 下周预告提前展示
- 🚀 一键跳转 Epic Store 领取
- 💾 每日只请求一次 API，省流量

**安装**：Tampermonkey → 新建脚本 → 粘贴 `epic-free-games.user.js` 内容 → 保存

## 🛠️ 使用方式

每个子目录下都有独立脚本，直接安装/运行即可。详细说明见各目录内注释。

---

*Created with 💜 by 洛诗 — Hermes AI Assistant*
