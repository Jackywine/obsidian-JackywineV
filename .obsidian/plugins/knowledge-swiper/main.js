'use strict';

/**
 * Knowledge Swiper (刷知识)
 * 像刷抖音一样垂直滚动回顾笔记 + 链接新知识
 * - 垂直 feed of cards (natural mouse wheel, 智能区分卡片内容内滚 vs 翻页，避免误触)
 * - IntersectionObserver 记录当前 + 自动记录
 * - frontmatter: last_reviewed, review_count (per user choice)
 * - 追加到已有 daily (e.g. 2026-06-03.md) 的 ## 知识回顾（默认关闭，支持 ⚙ 内联开关控制）
 * - 支持快速创建新笔记并自动关联到当前回顾卡片（“新建并关联”按钮）
 * - 卡片内“🗑 删除”按钮：回顾中发现可删的，直接 trash 到回收站（可恢复）
 * - 支持 Markdown 中 ![[双向链接]] 的直接内容预览（在卡片内递归展开目标笔记正文 + 附件）
 * - 支持自定义关键词过滤相关笔记回顾 / 仅回顾有 [[链接]] 的笔记（笔记间要有链接才能进入队列）
 * - 插件仅在用户明确操作时创建/删除 .md（AI 侧开发严格遵守全局“禁止新建笔记”禁令，仅编辑插件代码）
 * - CJS style (require + module.exports) to match how Obsidian loads plugin main.js
 *
 * 参考:
 * - .grok/skills/obsidian-cli/SKILL.md (reload / eval / dev:errors)
 * - .grok/skills/obsidian-markdown/SKILL.md (wikilink + append 模式)
 * - .grok/skills/obsidian-bases/SKILL.md (后续 days 公式)
 * - AGENTS.md + vault 约定 (type: Note, 原子笔记, 已有 daily, exclude attachment/AI/Clippings/dailies)
 */

const obsidian = require('obsidian');

console.log('[knowledge-swiper] CJS module evaluated at', new Date().toISOString());
const obsKeys = Object.keys(obsidian).filter(k => k.includes('Modal') || k.includes('PluginSetting') || k === 'Plugin' || k === 'ItemView' || k === 'MarkdownRenderer' || k === 'Notice' || k === 'Component' || k === 'Setting' || k === 'TFile');
console.log('[knowledge-swiper] after require obsidian keys sample:', obsKeys.join(','), 'has Modal?', !!obsidian.Modal, 'has PluginSettingTab?', !!obsidian.PluginSettingTab);

const VIEW_TYPE = 'knowledge-swiper-view';
const PLUGIN_ID = 'knowledge-swiper';

// Simple throttle and debounce for scroll/perf
function throttle(fn, wait) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last > wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

function debounce(fn, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

class KnowledgeSwiperPlugin extends obsidian.Plugin {
  async onload() {
    console.log('[knowledge-swiper] onload started');
    try {
      // 数据: reviewData + 可选 session
      this.reviewData = {};
      this.settings = {
        maxQueue: 100,
        dailyLimit: 0,
        cardFontSize: 14,
        cardTheme: 'dark',
        excludeFolders: ['attachment/', 'AI outputs/', 'Clippings/'],
        excludeDailies: true,
        appendToDaily: false,
        showNotices: true,
        onlyLinkedNotes: false,
        keywordFilter: '',
        frontmatterKeys: { last: 'last_reviewed', count: 'review_count' },
      };

      this.gamify = {
        total_xp: 0,
        level: 1,
        streak: 0,
        last_review_date: null,
        achievements: [],
        daily_reviews: {}
      };

      await this.loadSettings();

      // 注册视图
      this.registerView(VIEW_TYPE, (leaf) => new SwiperView(leaf, this));

      // 命令
      this.addCommand({
        id: 'open-feed',
        name: 'Open Knowledge Swiper Feed (打开刷知识 Feed)',
        callback: () => this.openFeed(),
      });

      this.addCommand({
        id: 'rebuild-queue',
        name: 'Rebuild Knowledge Swiper Queue (重建队列)',
        callback: async () => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
          if (leaves.length > 0) {
            const view = leaves[0].view;
            if (view && view.rebuildQueue) {
              await view.rebuildQueue();
              this.showNotice('队列已重建');
            }
          } else {
            this.showNotice('请先打开 Feed');
          }
        },
      });

      this.addCommand({
        id: 'show-stats',
        name: 'Show Gamify & Ebbinghaus Dashboard (游戏化+艾宾浩斯数据看板)',
        callback: () => this.showStatsModal(),
      });

      // 功能区图标
      this.addRibbonIcon('play-circle', 'Open Knowledge Swiper', () => this.openFeed());

      // 设置页
      this.addSettingTab(new SwiperSettingTab(this.app, this));

      // 状态栏 (点击打开)
      const status = this.addStatusBarItem();
      status.setText('刷知识');
      status.onClickEvent(() => this.openFeed());

      // 初始加载数据
      const data = await this.loadData();
      if (data) {
        if (data.reviewData) this.reviewData = data.reviewData;
        if (data.settings) this.settings = { ...this.settings, ...data.settings };
        if (data.gamify) this.gamify = { ...this.gamify, ...data.gamify };
      }

      console.log('[knowledge-swiper] loaded successfully');
    } catch (e) {
      console.error('[knowledge-swiper] FATAL onload error:', e);
      console.error(e.stack);
      new obsidian.Notice('Knowledge Swiper load error: ' + e.message);
      throw e; // rethrow so Obsidian sees the failure
    }
  }

  async onunload() {
    await this.saveData({ reviewData: this.reviewData });
  }

  async loadSettings() {
    const saved = await this.loadData();
    if (saved && saved.settings) {
      this.settings = { ...this.settings, ...saved.settings };
    }
  }

  async saveSettings() {
    await this.saveData({ reviewData: this.reviewData, settings: this.settings, gamify: this.gamify });
    this.refreshViews();
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach(leaf => {
      const view = leaf.view;
      if (view && typeof view.applyThemeAndSize === 'function') {
        view.applyThemeAndSize();
      }
    });
  }

  getTotalReviews() {
    return Object.values(this.reviewData || {}).reduce((sum, r) => sum + (r.count || 0), 0);
  }

  getTagsForFile(file) {
    if (!(file instanceof obsidian.TFile)) return [];
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    let tags = [];
    // frontmatter tags
    if (cache.frontmatter) {
      const fmTags = cache.frontmatter.tags;
      if (Array.isArray(fmTags)) {
        tags = tags.concat(fmTags.map(t => String(t).replace(/^#/, '').trim()));
      } else if (typeof fmTags === 'string') {
        tags = tags.concat(fmTags.split(/[, ]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean));
      }
    }
    // inline #tags
    if (cache.tags && Array.isArray(cache.tags)) {
      tags = tags.concat(cache.tags.map(t => t.tag.replace(/^#/, '')));
    }
    return [...new Set(tags.filter(Boolean))];
  }

  async openFeed() {
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async showStatsModal() {
    const modal = new StatsModal(this.app, this);
    modal.open();
  }

  // 计算未查看天数 (frontmatter 优先，否则用 mtime)
  computeDays(file) {
    const key = this.settings.frontmatterKeys.last;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const lastStr = fm[key] || (this.reviewData[file.path] && this.reviewData[file.path].last_reviewed);
    const base = lastStr ? new Date(lastStr) : new Date(file.stat.mtime);
    const diff = Date.now() - base.getTime();
    return Math.max(0, Math.floor(diff / 86400000));
  }

  // 记录一次回顾 (双写: plugin data + frontmatter + 可选 daily) + 艾宾浩斯 + 游戏化
  async recordReview(filePath, quality = 3) {
    if (!filePath) return;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof obsidian.TFile)) return;

    const today = new Date().toISOString().slice(0, 10);
    const keyLast = this.settings.frontmatterKeys.last;
    const keyCount = this.settings.frontmatterKeys.count;

    // plugin data with Ebbinghaus
    if (!this.reviewData[filePath]) this.reviewData[filePath] = { last_reviewed: today, count: 0, interval: 1, ease: 2.5 };
    const rec = this.reviewData[filePath];
    const wasNewDay = rec.last_reviewed !== today;
    rec.last_reviewed = today;
    if (wasNewDay) rec.count = (rec.count || 0) + 1;

    // 艾宾浩斯 / SM-2 调度
    if (!rec.interval) rec.interval = 1;
    if (!rec.ease) rec.ease = 2.5;

    if (quality >= 3) {
      rec.interval = Math.round(rec.interval * rec.ease);
      rec.ease = rec.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    } else {
      rec.interval = 1;
      rec.ease = Math.max(1.3, rec.ease - 0.2);
    }
    rec.due = this.addDays(today, rec.interval);

    // 游戏化
    const xpGain = Math.round(quality * 10 + (this.gamify.streak || 0) * 2);
    this.addXP(xpGain);
    this.checkStreak(today);

    // daily for viz
    if (!this.gamify.daily_reviews) this.gamify.daily_reviews = {};
    this.gamify.daily_reviews[today] = (this.gamify.daily_reviews[today] || 0) + 1;

    await this.saveData({ reviewData: this.reviewData, settings: this.settings, gamify: this.gamify });

    // frontmatter (用户要求)
    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[keyLast] = today;
        fm[keyCount] = (fm[keyCount] || 0) + (wasNewDay ? 1 : 0);
        fm['review_due'] = rec.due;
        fm['review_interval'] = rec.interval;
      });
    } catch (e) {
      console.warn('[knowledge-swiper] frontmatter write failed', e);
    }

    // 追加到已有 daily (默认关闭，仅用户主动开启时追加到已有日记)
    if (this.settings.appendToDaily) {
      await this.appendToDailyIfExists(file, today, quality);
    }

    // 已回顾记录后无需 Toast 提示（按用户要求移除）
  }

  addDays(dateStr, days) {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  addXP(xp) {
    this.gamify.total_xp = (this.gamify.total_xp || 0) + xp;
    const newLevel = Math.floor(this.gamify.total_xp / 100) + 1;
    if (newLevel > (this.gamify.level || 1)) {
      this.gamify.level = newLevel;
      this.showNotice(`🎉 升级到等级 ${newLevel}！`);
      this.checkAchievements();
    }
  }

  checkStreak(today) {
    const last = this.gamify.last_review_date;
    if (!last) {
      this.gamify.streak = 1;
    } else {
      const diffDays = Math.floor((new Date(today) - new Date(last)) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) {
        this.gamify.streak = (this.gamify.streak || 0) + 1;
      } else if (diffDays > 1) {
        this.gamify.streak = 1;
      }
    }
    this.gamify.last_review_date = today;
    this.checkAchievements();
  }

  checkAchievements() {
    const g = this.gamify;
    const unlocked = g.achievements || [];
    const toUnlock = [];

    if ((g.total_xp || 0) >= 100 && !unlocked.includes('xp100')) toUnlock.push({id:'xp100', msg:'XP达100！'});
    if ((g.streak || 0) >= 7 && !unlocked.includes('streak7')) toUnlock.push({id:'streak7', msg:'7天连续回顾！'});
    if ((g.total_xp || 0) >= 500 && !unlocked.includes('xp500')) toUnlock.push({id:'xp500', msg:'XP达500！'});
    if (Object.keys(g.daily_reviews || {}).length >= 30 && !unlocked.includes('30days')) toUnlock.push({id:'30days', msg:'30天活跃！'});

    toUnlock.forEach(a => {
      if (!unlocked.includes(a.id)) {
        unlocked.push(a.id);
        this.showNotice(`🏆 成就解锁: ${a.msg}`);
      }
    });
    g.achievements = unlocked;
  }

  showNotice(text) {
    if (this.settings.showNotices !== false) {
      new obsidian.Notice(text);
    }
  }

  async appendToDailyIfExists(reviewedFile, todayStr, quality = 3) {
    const dailyPath = `${todayStr}.md`;
    const daily = this.app.vault.getAbstractFileByPath(dailyPath);
    if (!(daily instanceof obsidian.TFile)) return; // 不创建新文件

    const title = reviewedFile.basename;
    const days = this.computeDays(reviewedFile);
    const rec = this.reviewData[reviewedFile.path] || {};
    const count = rec.count || 1;
    const interval = rec.interval || 1;

    const entry = `- [[${title}]] (质量${quality}, 间隔${interval}天, 未查看: ${days}天, 总${count}次)`;

    await this.app.vault.process(daily, (data) => {
      if (!data.includes('## 知识回顾')) {
        data = data.trimEnd() + '\n\n## 知识回顾\n';
      }
      if (!data.includes(`[[${title}]]`)) {
        data = data.trimEnd() + '\n' + entry + '\n';
      }
      return data;
    });
  }

  // 构建队列 (严格按用户回答的 exclude)
  buildQueue(tagFilter = null) {
    let files = this.app.vault.getMarkdownFiles();

    const excludes = this.settings.excludeFolders || [];
    const excludeDailies = this.settings.excludeDailies;

    files = files.filter((f) => {
      for (const ex of excludes) {
        if (f.path.startsWith(ex)) return false;
      }
      if (excludeDailies && /^\d{4}-\d{2}-\d{2}\.md$/.test(f.name)) return false;
      return true;
    });

    // 同标签过滤 (如果提供)
    if (tagFilter && Array.isArray(tagFilter) && tagFilter.length > 0) {
      files = files.filter((f) => {
        const fTags = this.getTagsForFile(f);
        return tagFilter.some(t => fTags.includes(t));
      });
    }

    // 自定义关键词过滤 (标题 + 标签，支持相关笔记回顾)
    const kw = (this.settings.keywordFilter || '').trim();
    if (kw) {
      const kws = kw.toLowerCase().split(/[,，\s]+/).filter(Boolean);
      if (kws.length > 0) {
        files = files.filter((f) => {
          const name = f.basename.toLowerCase();
          const tagsStr = this.getTagsForFile(f).join(' ').toLowerCase();
          return kws.some(k => name.includes(k) || tagsStr.includes(k));
        });
      }
    }

    // 仅回顾有链接的笔记 (笔记与笔记之间要有 wikilink 才能回顾)
    if (this.settings.onlyLinkedNotes) {
      files = files.filter((f) => {
        const cache = this.app.metadataCache.getFileCache(f);
        return !!(cache && cache.links && cache.links.length > 0);
      });
    }

    // 艾宾浩斯优先：due 越早越前 (overdue/due first)，然后未查看天数
    files.sort((a, b) => {
      const pa = this.getDuePriority(a);
      const pb = this.getDuePriority(b);
      if (pa !== pb) return pa - pb;
      const da = this.computeDays(a);
      const db = this.computeDays(b);
      if (db !== da) return db - da;
      return Math.random() - 0.5;
    });

    const max = this.settings.maxQueue || 100;
    let result = files.slice(0, max);

    // 每日回顾数量 (用户自定义)
    const dailyLimit = this.settings.dailyLimit || 0;
    if (dailyLimit > 0) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const reviewedToday = Object.values(this.reviewData || {})
        .filter(r => r.last_reviewed === todayStr).length;
      const remaining = Math.max(0, dailyLimit - reviewedToday);
      result = result.slice(0, remaining);
    }

    return result;
  }

  getDuePriority(file) {
    const rec = this.reviewData[file.path] || {};
    if (!rec.due) return -999; // never reviewed, highest priority
    const today = new Date().toISOString().slice(0, 10);
    const dueDate = new Date(rec.due);
    const todayDate = new Date(today);
    const daysToDue = Math.floor((dueDate - todayDate) / (1000 * 60 * 60 * 24));
    return daysToDue; // negative = overdue, 0 = due today, positive = future
  }

  // 给当前卡片添加关联 (链接新知识)
  async addLinkToCurrent(currentPath, chosenFile, displayName = null) {
    if (!currentPath || !chosenFile) return;
    const file = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(file instanceof obsidian.TFile)) return;

    const today = new Date().toISOString().slice(0, 10);
    const target = displayName ? `${chosenFile.basename}|${displayName}` : chosenFile.basename;
    const line = `\n\n- 知识回顾关联 [[${target}]] (${today})`;

    await this.app.vault.process(file, (txt) => {
      const trimmed = txt.trimEnd();
      const check = displayName || chosenFile.basename;
      if (trimmed.includes(`[[${check}]]`) || trimmed.includes(`[[${chosenFile.basename}]]`)) return txt; // 避免重复
      return trimmed + line;
    });

    this.showNotice(`已关联到 ${displayName || chosenFile.basename}`);
  }

  // 快速创建新笔记 + 自动链接到当前回顾笔记（用户请求）
  async createAndLinkToCurrent(currentPath, newTitle) {
    if (!currentPath || !newTitle) return;
    const currentFile = this.app.vault.getAbstractFileByPath(currentPath);
    if (!(currentFile instanceof obsidian.TFile)) return;

    const today = new Date().toISOString().slice(0, 10);
    const currentBasename = currentFile.basename;

    // 决定创建位置：优先使用 Obsidian 的“新笔记存放位置”逻辑（相对当前笔记的文件夹或用户设置）
    let folderPrefix = '';
    try {
      const parentFolder = this.app.fileManager.getNewFileParent(currentPath);
      if (parentFolder && parentFolder.path) folderPrefix = parentFolder.path + '/';
    } catch (_) {}

    // 安全 basename：去掉 FS 非法字符，空格→-，支持中文标题
    let base = newTitle.trim().replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, '-');
    if (!base) base = 'untitled-linked-note';
    let finalBase = base;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(folderPrefix + finalBase + '.md')) {
      finalBase = base + '-' + (i++);
    }
    const filePath = folderPrefix + finalBase + '.md';

    // 新笔记初始内容：H1 + 反向关联 + 空行
    const initial = `# ${newTitle}\n\n- 知识回顾关联自 [[${currentBasename}]] (${today})\n\n`;

    try {
      const newFile = await this.app.vault.create(filePath, initial);
      // 如果文件名被 slug 化，用 |alias 让链接显示用户输入的漂亮标题
      const display = (newFile.basename !== newTitle) ? newTitle : null;
      await this.addLinkToCurrent(currentPath, newFile, display);
      this.showNotice(`已创建并关联：${newTitle}`);
      // 不自动打开新笔记，保持刷知识沉浸；用户可随时点“查看详情”或手动打开
    } catch (e) {
      console.error('[knowledge-swiper] create failed', e);
      this.showNotice('创建笔记失败: ' + (e.message || e));
    }
  }
}

class SwiperView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.queue = [];
    this.loadedCount = 0;
    this.observer = null;
    this.feedEl = null;
    this.headerEl = null;
    this.currentPath = null;
    this.settingsPanel = null;
    this.sameTagMode = false;
    this.currentFilterTags = [];
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Knowledge Swiper (刷知识)'; }
  getIcon() { return 'play-circle'; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('knowledge-swiper-view');

    // header
    this.headerEl = container.createDiv('knowledge-swiper-header');
    this.renderHeader();

    // settings panel container (for inline settings)
    this.settingsContainer = container.createDiv('ks-settings-container');

    // feed
    this.feedEl = container.createDiv('knowledge-swiper-feed');
    this.feedEl.tabIndex = 0; // 支持键盘聚焦 + 方向键上下滑动卡片

    // apply theme and size
    this.applyThemeAndSize();

    // 鼠标滚轮一次只翻一个完整卡片 (分页模式)
    // 关键修复：如果鼠标在卡片内容区且该方向内容还能滚动，则让内层自然滚（避免误触翻页）
    const throttledWheel = throttle((e) => {
      if (Math.abs(e.deltaY) > 25) {
        const dir = e.deltaY > 0 ? 1 : -1;
        if (this.canContentScrollInDirection(e.target, dir)) {
          // 内容区还能滚，放行给内层 .card-content 的 overflow 滚动
          return;
        }
        e.preventDefault();
        this.advanceToCard(dir);
      }
    }, 80);
    this.feedEl.addEventListener('wheel', throttledWheel, { passive: false });

    // 方向键上下滑动卡片（复用 advanceToCard），编辑时不劫持
    const keyHandler = (e) => {
      if (document.activeElement && (document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'INPUT')) {
        return; // 直接编辑中，让光标移动
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.advanceToCard(-1);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.advanceToCard(1);
      }
    };
    container.addEventListener('keydown', keyHandler);
    this._keyContainer = container;
    this._keyHandler = keyHandler;

    // 构建 + 首屏
    await this.rebuildQueue();

    // 自动聚焦 feed，让方向键立即可用（不额外滚动）
    setTimeout(() => {
      if (this.feedEl) this.feedEl.focus({ preventScroll: true });
    }, 280);

    // 滚动到底加载更多 (分页模式下每页很高，阈值调大) - throttled for smoothness
    const throttledScroll = throttle(() => {
      // Prune far past cards to keep DOM small (big win for no lag after long scroll)
      const cards = Array.from(this.feedEl.querySelectorAll('.note-card'));
      const pruneThreshold = this.feedEl.scrollTop - 500;
      let pruned = 0;
      for (let i = 0; i < cards.length - 4; i++) {  // always keep last 4
        const c = cards[i];
        if (c.offsetTop + c.offsetHeight < pruneThreshold) {
          c.remove();
          pruned++;
        }
      }

      if (this.feedEl.scrollTop + this.feedEl.clientHeight > this.feedEl.scrollHeight - 200) {
        this.renderMoreCards(3);
      }
    }, 120);
    this.feedEl.addEventListener('scroll', throttledScroll);

    // 初始观察器
    this.setupObserver();
  }

  onClose() {
    if (this.observer) this.observer.disconnect();
    if (this.settingsPanel) {
      this.settingsPanel.remove();
      this.settingsPanel = null;
    }
    // 清理键盘监听
    if (this._keyContainer && this._keyHandler) {
      this._keyContainer.removeEventListener('keydown', this._keyHandler);
      this._keyHandler = null;
      this._keyContainer = null;
    }
  }

  applyThemeAndSize() {
    const container = this.containerEl;
    if (!container) return;

    // remove old theme classes
    ['theme-light', 'theme-dark', 'theme-blue', 'theme-terminal', 'theme-matrix', 'theme-mars'].forEach(cls => {
      container.classList.remove(cls);
    });

    const theme = this.plugin.settings.cardTheme || 'dark';
    container.classList.add('theme-' + theme);

    const size = this.plugin.settings.cardFontSize || 14;
    container.style.setProperty('--ks-font-size', size + 'px');

    // also apply to existing cards if needed (CSS will handle most)
    this.feedEl.querySelectorAll('.note-card .card-content').forEach(el => {
      el.style.fontSize = size + 'px';
    });
  }

  renderHeader() {
    if (!this.headerEl) return;
    this.headerEl.empty();

    const left = this.headerEl.createDiv();
    left.createEl('span', { text: '刷知识 (单卡分页)', cls: 'title' });

    if (this.sameTagMode) {
      const modeBadge = left.createEl('span', { 
        text: `同标签 (${this.queue.length})`, 
        cls: 'ks-mode-badge' 
      });
      modeBadge.onclick = () => this.exitSameTagMode();
      // 添加提示
      modeBadge.title = '点击退出同标签模式';
    }

    // 游戏化显示
    const g = this.plugin.gamify || {};
    const gamifyEl = left.createEl('span', { 
      text: `Lv.${g.level || 1} XP:${g.total_xp || 0} 🔥${g.streak || 0}`, 
      cls: 'ks-gamify' 
    });
    gamifyEl.style.fontSize = '10px';
    gamifyEl.style.marginLeft = '6px';
    gamifyEl.style.color = 'var(--text-muted)';

    const badge = this.headerEl.createEl('span', { cls: 'days-badge', text: '—' });
    badge.id = 'ks-current-days';

    const meta = this.headerEl.createEl('span', { cls: 'meta', text: '0/0' });
    meta.id = 'ks-session-meta';

    // 初始显示每日回顾进度（如果设置了上限）
    const dailyLimit = this.plugin.settings.dailyLimit || 0;
    const grandTotal = this.plugin.getTotalReviews();
    if (dailyLimit > 0) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayCnt = Object.values(this.plugin.reviewData || {}).filter(r => r.last_reviewed === todayStr).length;
      meta.textContent = `今日 ${todayCnt}/${dailyLimit} · 总 ${grandTotal}`;
    } else {
      meta.textContent = `总回顾 ${grandTotal}`;
    }

    // 按钮
    const btnRebuild = this.headerEl.createEl('button', { text: '重建队列' });
    btnRebuild.onclick = () => this.rebuildQueue();

    const btnPrev = this.headerEl.createEl('button', { text: '上一个' });
    btnPrev.onclick = () => this.advanceToCard(-1);

    const btnNext = this.headerEl.createEl('button', { text: '下一个' });
    btnNext.onclick = () => this.advanceToCard(1);

    const btnStats = this.headerEl.createEl('button', { text: '🎮 数据看板' });
    btnStats.onclick = () => this.plugin.showStatsModal();

    const btnClose = this.headerEl.createEl('button', { text: '关闭' });
    btnClose.onclick = () => this.leaf.detach();

    const btnSettings = this.headerEl.createEl('button', { text: '⚙ 设置' });
    btnSettings.onclick = () => this.toggleInlineSettings();
  }

  toggleInlineSettings() {
    if (!this.settingsContainer) return;

    if (this.settingsPanel && this.settingsPanel.parentNode) {
      this.settingsPanel.remove();
      this.settingsPanel = null;
      return;
    }

    this.settingsPanel = this.settingsContainer.createDiv('ks-inline-settings');
    this.settingsPanel.style.cssText = 'margin:4px 0; padding:8px; background:var(--background-secondary); border:1px solid var(--background-modifier-border); border-radius:4px; font-size:12px;';

    // 主题设置
    const themeDiv = this.settingsPanel.createDiv();
    themeDiv.createEl('span', { text: '主题: ' });
    const themeSelect = themeDiv.createEl('select');
    const themes = [
      {v:'light', l:'亮色模式'},
      {v:'dark', l:'暗色模式'},
      {v:'blue', l:'蓝色模式'},
      {v:'terminal', l:'终端模式'},
      {v:'matrix', l:'黑客帝国'},
      {v:'mars', l:'火星模式'}
    ];
    themes.forEach(t => {
      const opt = themeSelect.createEl('option', {text: t.l, value: t.v});
      if (t.v === (this.plugin.settings.cardTheme || 'dark')) opt.selected = true;
    });
    themeSelect.onchange = () => {
      this.plugin.settings.cardTheme = themeSelect.value;
      this.plugin.saveSettings();
      this.applyThemeAndSize();
    };

    // 字体大小
    const sizeDiv = this.settingsPanel.createDiv({style: 'margin-top:4px;'});
    sizeDiv.createEl('span', { text: '文字大小: ' });
    const sizeInput = sizeDiv.createEl('input', {type: 'number', value: this.plugin.settings.cardFontSize || 14, style: 'width:50px;'});
    sizeInput.onchange = () => {
      let v = parseInt(sizeInput.value) || 14;
      v = Math.max(10, Math.min(28, v));
      this.plugin.settings.cardFontSize = v;
      sizeInput.value = v;
      this.plugin.saveSettings();
      this.applyThemeAndSize();
    };
    sizeDiv.createEl('button', {text: '-' }).onclick = () => {
      let v = (this.plugin.settings.cardFontSize || 14) - 1;
      v = Math.max(10, v);
      this.plugin.settings.cardFontSize = v;
      sizeInput.value = v;
      this.plugin.saveSettings();
      this.applyThemeAndSize();
    };
    sizeDiv.createEl('button', {text: '+' }).onclick = () => {
      let v = (this.plugin.settings.cardFontSize || 14) + 1;
      v = Math.min(28, v);
      this.plugin.settings.cardFontSize = v;
      sizeInput.value = v;
      this.plugin.saveSettings();
      this.applyThemeAndSize();
    };

    // 追加到日记开关（知识回顾记录在日记中的功能，用户请求增加快捷开关）
    const appendDiv = this.settingsPanel.createDiv({style: 'margin-top:4px;'});
    appendDiv.createEl('span', { text: '追加到日记: ' });
    const appendChk = appendDiv.createEl('input', {type: 'checkbox'});
    appendChk.checked = !!this.plugin.settings.appendToDaily;
    appendChk.style.verticalAlign = 'middle';
    appendChk.style.marginLeft = '4px';
    appendChk.onchange = () => {
      this.plugin.settings.appendToDaily = appendChk.checked;
      this.plugin.saveSettings();
    };
    appendDiv.createEl('small', { text: ' (默认关闭，仅在已有日记追加 ## 知识回顾)', style: 'color:var(--text-muted); font-size:10px; margin-left:4px;' });

    // 通知触发开关（用户请求：控制 Notice 提示）
    const noticeDiv = this.settingsPanel.createDiv({style: 'margin-top:4px;'});
    noticeDiv.createEl('span', { text: '显示通知: ' });
    const noticeChk = noticeDiv.createEl('input', {type: 'checkbox'});
    noticeChk.checked = this.plugin.settings.showNotices !== false;
    noticeChk.style.verticalAlign = 'middle';
    noticeChk.style.marginLeft = '4px';
    noticeChk.onchange = () => {
      this.plugin.settings.showNotices = noticeChk.checked;
      this.plugin.saveSettings();
    };
    noticeDiv.createEl('small', { text: ' (升级/成就/操作提示等)', style: 'color:var(--text-muted); font-size:10px; margin-left:4px;' });

    // 仅链接笔记开关（用户请求：笔记与笔记之间要有链接才能回顾）
    const linkDiv = this.settingsPanel.createDiv({style: 'margin-top:4px;'});
    linkDiv.createEl('span', { text: '仅链接笔记: ' });
    const linkChk = linkDiv.createEl('input', {type: 'checkbox'});
    linkChk.checked = !!this.plugin.settings.onlyLinkedNotes;
    linkChk.style.verticalAlign = 'middle';
    linkChk.style.marginLeft = '4px';
    linkChk.onchange = () => {
      this.plugin.settings.onlyLinkedNotes = linkChk.checked;
      this.plugin.saveSettings();
    };
    linkDiv.createEl('small', { text: ' (只回顾有 [[链接]] 的笔记)', style: 'color:var(--text-muted); font-size:10px; margin-left:4px;' });

    // 自定义关键词过滤（用户请求：自定义关键词相关笔记回顾）
    const kwDiv = this.settingsPanel.createDiv({style: 'margin-top:4px;'});
    kwDiv.createEl('span', { text: '关键词: ' });
    const kwInput = kwDiv.createEl('input', {type: 'text', value: this.plugin.settings.keywordFilter || '', style: 'width:120px; font-size:11px;'});
    kwInput.onchange = () => {
      this.plugin.settings.keywordFilter = kwInput.value.trim();
      this.plugin.saveSettings();
    };
    kwDiv.createEl('small', { text: ' (标题/标签匹配，逗号分隔)', style: 'color:var(--text-muted); font-size:10px; margin-left:4px;' });

    // 总回顾数量显示
    const totalDiv = this.settingsPanel.createDiv({style: 'margin-top:4px; font-size:11px; color:var(--text-muted);'});
    totalDiv.textContent = `总回顾数量: ${this.plugin.getTotalReviews()}`;

    // 关闭按钮
    const closeBtn = this.settingsPanel.createEl('button', {text: '关闭设置', style: 'margin-top:4px; font-size:11px;'});
    closeBtn.onclick = () => {
      if (this.settingsPanel) {
        this.settingsPanel.remove();
        this.settingsPanel = null;
      }
    };
  }

  updateHeaderFor(path) {
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) return;

    const daysEl = this.headerEl.querySelector('#ks-current-days');
    const metaEl = this.headerEl.querySelector('#ks-session-meta');

    const days = this.plugin.computeDays(file);
    if (daysEl) {
      daysEl.textContent = `${days} 天未查看`;
      daysEl.className = 'days-badge ' + (days > 60 ? 'high' : days > 14 ? 'medium' : '');
    }

    const rec = this.plugin.reviewData[path] || {};
    const total = Object.keys(this.plugin.reviewData).length;
    const grandTotal = this.plugin.getTotalReviews();
    let metaText = `本次 ${this.plugin.reviewData[path] ? '已' : ''}阅 · 累计 ${total} · 总回顾 ${grandTotal}`;
    const dailyLimit = this.plugin.settings.dailyLimit || 0;
    if (dailyLimit > 0) {
      const todayStr = new Date().toISOString().slice(0, 10);
      const todayCount = Object.values(this.plugin.reviewData || {}).filter(r => r.last_reviewed === todayStr).length;
      metaText += ` · 今日 ${todayCount}/${dailyLimit}`;
    }
    if (metaEl) metaEl.textContent = metaText;
  }

  async rebuildQueue() {
    if (this.observer) this.observer.disconnect();
    if (this.settingsPanel) {
      this.settingsPanel.remove();
      this.settingsPanel = null;
    }
    this.feedEl.empty();
    this.loadedCount = 0;
    // 如果在同标签模式，rebuild 时保持过滤
    if (this.sameTagMode && this.currentFilterTags.length > 0) {
      this.queue = this.plugin.buildQueue(this.currentFilterTags);
    } else {
      this.queue = this.plugin.buildQueue();
    }
    this.renderMoreCards(3); // 分页模式初始少渲染，减少初始 DOM 压力
    this.setupObserver();
    this.applyThemeAndSize(); // re-apply to new cards
    let noticeText = `队列已就绪 (${this.queue.length} 条)`;
    if (this.sameTagMode) {
      noticeText += ` (同标签模式)`;
    } else if (this.plugin.settings.dailyLimit > 0) {
      noticeText += ` (每日上限 ${this.plugin.settings.dailyLimit})`;
    }
    this.plugin.showNotice(noticeText);

    if (this.queue.length === 0) {
      const empty = this.feedEl.createDiv('knowledge-swiper-empty');
      const limit = this.plugin.settings.dailyLimit || 0;
      if (limit > 0) {
        empty.textContent = `今日回顾已达上限 ${limit} 条 (可在设置中调整或重建)`;
      } else {
        empty.textContent = '没有符合条件的笔记 ~ 调整排除设置试试';
      }
    }

    // 初始自动选中并记录第一个卡片
    setTimeout(() => {
      const first = this.feedEl.querySelector('.note-card');
      if (first && first.dataset.path) {
        this.currentPath = first.dataset.path;
        this.updateHeaderFor(first.dataset.path);
        this.plugin.recordReview(first.dataset.path);
      }
    }, 400);
  }

  // 判断鼠标所在位置的卡片内容是否还能在该方向滚动（用于区分内层内容滚动 vs 外层翻卡）
  canContentScrollInDirection(target, dir) {
    if (!target || !target.closest) return false;
    const content = target.closest('.note-card .card-content');
    if (!content) return false;
    if (dir > 0) {
      // 向下滚：内容是否还有空间？
      return (content.scrollTop + content.clientHeight) < (content.scrollHeight - 1);
    } else {
      // 向上滚
      return content.scrollTop > 1;
    }
  }

  advanceToCard(dir = 1) {
    const cards = Array.from(this.feedEl.querySelectorAll('.note-card'));
    if (!cards.length) return;
    const scrollTop = this.feedEl.scrollTop;
    let currentIdx = 0;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].offsetTop > scrollTop + 10) {
        currentIdx = i - 1;
        break;
      }
      currentIdx = i;
    }
    const targetIdx = Math.max(0, Math.min(cards.length - 1, currentIdx + dir));
    if (cards[targetIdx]) {
      cards[targetIdx].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async switchToSameTagNotes() {
    if (!this.currentPath) return;
    const currentFile = this.app.vault.getAbstractFileByPath(this.currentPath);
    if (!currentFile) return;
    const tags = this.plugin.getTagsForFile(currentFile);
    if (tags.length === 0) {
      this.plugin.showNotice('当前笔记没有标签');
      return;
    }
    this.sameTagMode = true;
    this.currentFilterTags = tags;
    this.queue = this.plugin.buildQueue(tags);
    this.loadedCount = 0;
    this.feedEl.empty();
    this.renderMoreCards(3);
    this.setupObserver();
    this.applyThemeAndSize();
    this.plugin.showNotice(`已切换到同标签笔记，共 ${this.queue.length} 条`);
    this.renderHeader();
  }

  exitSameTagMode() {
    this.sameTagMode = false;
    this.currentFilterTags = [];
    this.queue = this.plugin.buildQueue();
    this.loadedCount = 0;
    this.feedEl.empty();
    this.renderMoreCards(3);
    this.setupObserver();
    this.applyThemeAndSize();
    this.renderHeader();
    this.plugin.showNotice('已退出同标签模式');
  }

  async editCardInline(cardEl, file, contentEl) {
    if (!cardEl || !file || !contentEl) return;

    // 读取原始内容
    const raw = await this.app.vault.read(file);
    const fmMatch = raw.match(/^---[\s\S]*?---\s*/);
    const frontmatter = fmMatch ? fmMatch[0] : '';
    const body = fmMatch ? raw.slice(frontmatter.length).trim() : raw.trim();

    // 清空并创建编辑器
    contentEl.empty();

    const ta = contentEl.createEl('textarea', {
      value: body,
      cls: 'ks-edit-textarea'
    });
    ta.style.width = '100%';
    ta.style.minHeight = '200px';
    ta.style.fontFamily = 'var(--font-monospace, monospace)';
    ta.style.fontSize = 'var(--ks-font-size, 14px)';
    ta.style.resize = 'vertical';

    const btns = contentEl.createDiv('ks-edit-buttons');
    btns.style.marginTop = '8px';
    btns.style.display = 'flex';
    btns.style.gap = '6px';

    const saveBtn = btns.createEl('button', { text: '保存' });
    const cancelBtn = btns.createEl('button', { text: '取消' });

    saveBtn.onclick = async () => {
      const newBody = ta.value;
      const newRaw = frontmatter + (frontmatter && !frontmatter.endsWith('\n') ? '\n' : '') + newBody;
      try {
        await this.app.vault.modify(file, newRaw);
        // 重新渲染卡片内容
        contentEl.empty();
        const comp = new obsidian.Component();
        contentEl.addClasses(['markdown-preview-view', 'markdown-rendered']);
        await obsidian.MarkdownRenderer.renderMarkdown(newBody, contentEl, file.path, comp);
        await this.fixAttachmentPreviews(contentEl, file);

        // 增强内部链接
        contentEl.querySelectorAll('a.internal-link, .internal-link').forEach((linkEl) => {
          const rawHref = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || (linkEl.textContent || '');
          if (rawHref) {
            linkEl.onclick = (ev) => {
              ev.preventDefault();
              const target = rawHref.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
              this.app.workspace.openLinkText(target, file.path, false);
            };
          }
        });

        this.register(() => comp.unload());
        this.plugin.showNotice('已保存');
      } catch (e) {
        this.plugin.showNotice('保存失败: ' + e.message);
        // 恢复
        contentEl.empty();
        const comp = new obsidian.Component();
        contentEl.addClasses(['markdown-preview-view', 'markdown-rendered']);
        await obsidian.MarkdownRenderer.renderMarkdown(body, contentEl, file.path, comp);
        await this.fixAttachmentPreviews(contentEl, file);

        contentEl.querySelectorAll('a.internal-link, .internal-link').forEach((linkEl) => {
          const rawHref = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || (linkEl.textContent || '');
          if (rawHref) {
            linkEl.onclick = (ev) => {
              ev.preventDefault();
              const target = rawHref.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
              this.app.workspace.openLinkText(target, file.path, false);
            };
          }
        });

        this.register(() => comp.unload());
      }
    };

    cancelBtn.onclick = async () => {
      contentEl.empty();
      const comp = new obsidian.Component();
      contentEl.addClasses(['markdown-preview-view', 'markdown-rendered']);
      await obsidian.MarkdownRenderer.renderMarkdown(body, contentEl, file.path, comp);
      await this.fixAttachmentPreviews(contentEl, file);

      contentEl.querySelectorAll('a.internal-link, .internal-link').forEach((linkEl) => {
        const rawHref = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || (linkEl.textContent || '');
        if (rawHref) {
          linkEl.onclick = (ev) => {
            ev.preventDefault();
            const target = rawHref.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
            this.app.workspace.openLinkText(target, file.path, false);
          };
        }
      });

      this.register(() => comp.unload());
    };
  }

  // 删除当前卡片对应笔记，直接移到回收站（支持系统回收站恢复）
  async deleteCard(file, cardEl) {
    if (!file) return;
    if (!confirm(`确定要删除「${file.basename}」吗？\n将移动到回收站（可从系统回收站恢复）。`)) return;

    try {
      await this.app.vault.trash(file, true);

      // 立即移除卡片 DOM（视觉即时反馈）
      if (cardEl && cardEl.parentNode) {
        cardEl.parentNode.removeChild(cardEl);
      }

      // 重新计算队列（尊重同标签模式 + 每日上限），以便可能补位
      if (this.sameTagMode && this.currentFilterTags.length > 0) {
        this.queue = this.plugin.buildQueue(this.currentFilterTags);
      } else {
        this.queue = this.plugin.buildQueue();
      }

      // 清理本地回顾记录（避免悬挂数据）
      if (this.plugin.reviewData && this.plugin.reviewData[file.path]) {
        delete this.plugin.reviewData[file.path];
        this.plugin.saveData({
          reviewData: this.plugin.reviewData,
          settings: this.plugin.settings,
          gamify: this.plugin.gamify
        }).catch(() => {});
      }

      // 重置渲染状态（DOM 里通常只有少量卡片，直接清空重绘前几张）
      this.loadedCount = 0;
      Array.from(this.feedEl.querySelectorAll('.note-card, .knowledge-swiper-empty'))
        .forEach(el => el.remove());

      this.renderMoreCards(3);
      this.setupObserver();
      this.applyThemeAndSize();

      // 选中新的第一张（不自动记录回顾）
      this.currentPath = null;
      const first = this.feedEl.querySelector('.note-card');
      if (first && first.dataset.path) {
        this.currentPath = first.dataset.path;
        this.updateHeaderFor(this.currentPath);
      } else {
        const empty = this.feedEl.createDiv('knowledge-swiper-empty');
        const limit = this.plugin.settings.dailyLimit || 0;
        empty.textContent = limit > 0 ? '今日回顾已处理完毕 ~' : '没有更多笔记啦 ~';
      }

      this.plugin.showNotice(`已移至回收站: ${file.basename}`);
    } catch (e) {
      console.error('[knowledge-swiper] deleteCard error', e);
      this.plugin.showNotice('删除失败: ' + (e.message || e));
    }
  }

  renderMoreCards(count = 8) {
    const start = this.loadedCount;
    const end = Math.min(start + count, this.queue.length);
    for (let i = start; i < end; i++) {
      const file = this.queue[i];
      this.renderOneCard(file, this.feedEl);
    }
    this.loadedCount = end;

    if (this.loadedCount >= this.queue.length && this.queue.length > 0) {
      const endNote = this.feedEl.createDiv('knowledge-swiper-empty');
      let txt = '到底啦 ~ 点“重建队列”刷新';
      if (this.plugin.settings.dailyLimit > 0) {
        txt += ' (已达今日回顾上限或队列末尾)';
      }
      endNote.textContent = txt;
    }
  }

  async renderOneCard(file, container) {
    const card = container.createDiv('note-card');
    card.dataset.path = file.path;
    card.style.cursor = 'pointer';
    card.onclick = (ev) => {
      // 忽略按钮、链接、内部链接的点击
      if (ev.target.closest('button') || ev.target.closest('a') || ev.target.closest('.internal-link')) return;
      this.app.workspace.getLeaf('tab').openFile(file);
    };

    // header
    const ch = card.createDiv('card-header');
    const title = ch.createEl('div', { cls: 'card-title' });
    title.textContent = file.basename;
    title.onclick = () => this.app.workspace.getLeaf('tab').openFile(file);

    const days = this.plugin.computeDays(file);
    const rec = this.plugin.reviewData[file.path] || {};
    const m = ch.createEl('div', { cls: 'card-meta' });
    m.textContent = `${days}d · ${file.stat.mtime ? new Date(file.stat.mtime).toISOString().slice(0,10) : ''} ${rec.due ? `| 下次${rec.due}(间隔${rec.interval||1}d)` : ''}`;

    // content (渲染正文)
    // 使用标准 markdown-preview-view / markdown-rendered 类，让 Obsidian 核心样式（callout、列表、表格、embed 等）更接近原生预览
    const content = card.createDiv('card-content');
    content.addClasses(['markdown-preview-view', 'markdown-rendered']);
    const comp = new obsidian.Component();
    try {
      const md = await this.app.vault.cachedRead(file);
      // 去掉 frontmatter 再渲染 (更干净)
      const body = md.replace(/^---[\s\S]*?---\s*/, '');
      await obsidian.MarkdownRenderer.renderMarkdown(body || '(空笔记)', content, file.path, comp);
      // Post-process to support direct preview of images, audio, video, and other attachments
      // 以及 Markdown 中 ![[ ]] 构成的笔记双向链接的直接内容预览（递归支持）
      await this.fixAttachmentPreviews(content, file);

      // 让卡片内的 [[内部链接]] 更可靠地打开（自定义视图有时需要补一下事件）
      content.querySelectorAll('a.internal-link, .internal-link').forEach((linkEl) => {
        const rawHref = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || (linkEl.textContent || '');
        if (rawHref) {
          linkEl.onclick = (ev) => {
            ev.preventDefault();
            // 去掉可能的 [[ ]] 包裹
            const target = rawHref.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
            this.app.workspace.openLinkText(target, file.path, false);
          };
        }
      });
    } catch (e) {
      content.textContent = '(读取失败)';
    }
    // 注册清理
    this.register(() => comp.unload());

    // actions
    const actions = card.createDiv('card-actions');

    const btnLink = actions.createEl('button', { text: '关联已有' });
    btnLink.onclick = () => {
      const modal = new LinkSuggestModal(this.app, this.plugin, file.path);
      modal.open();
    };

    // 新增：快速创建新笔记并链接到当前卡片（用户请求）
    const btnNew = actions.createEl('button', { text: '新建并关联' });
    btnNew.onclick = () => {
      const modal = new CreateNoteLinkModal(this.app, this.plugin, file.path);
      modal.open();
    };

    const btnOpen = actions.createEl('button', { text: '查看详情' });
    btnOpen.onclick = () => this.app.workspace.getLeaf('tab').openFile(file);

    const btnEdit = actions.createEl('button', { text: '直接编辑' });
    btnEdit.onclick = () => this.editCardInline(card, file, content);

    // 删除按钮：回顾时发现可删的，直接移回收站（用户请求）
    const btnDel = actions.createEl('button', { text: '🗑 删除' });
    btnDel.addClass('ks-del-btn');
    btnDel.onclick = () => this.deleteCard(file, card);

    // 艾宾浩斯质量按钮 - 游戏化 + 曲线调度
    const qualities = [
      { q: 1, label: '😵 忘记' },
      { q: 2, label: '😕 困难' },
      { q: 3, label: '🙂 良好' },
      { q: 4, label: '😊 简单' }
    ];
    qualities.forEach(({q, label}) => {
      const b = actions.createEl('button', { text: label });
      b.style.fontSize = '10px';
      b.onclick = async () => {
        await this.plugin.recordReview(file.path, q);
        this.updateHeaderFor(file.path);
      };
    });

    const btnSameTag = actions.createEl('button', { text: this.sameTagMode ? '刷新同标签' : '同标签笔记' });
    btnSameTag.onclick = () => {
      if (this.sameTagMode) {
        // 已经在模式下，刷新队列
        this.queue = this.plugin.buildQueue(this.currentFilterTags);
        this.loadedCount = 0;
        this.feedEl.empty();
        this.renderMoreCards(3);
        this.setupObserver();
        this.applyThemeAndSize();
        this.plugin.showNotice(`同标签队列已刷新，共 ${this.queue.length} 条`);
      } else {
        this.switchToSameTagNotes();
      }
    };
  }

  setupObserver() {
    if (this.observer) this.observer.disconnect();

    // Debounced to avoid spam during fast scroll (main source of previous stutter)
    this.debouncedCardUpdate = debounce((p) => {
      if (p && p !== this.currentPath) {
        this.currentPath = p;
        this.updateHeaderFor(p);
        // 自动记录 (进入视口即视为回顾) - only after settle
        this.plugin.recordReview(p);
      }
    }, 280);

    this.observer = new IntersectionObserver((entries) => {
      // Pick the one with highest ratio as current
      let best = null;
      let bestRatio = 0;
      entries.forEach((entry) => {
        if (entry.isIntersecting && entry.intersectionRatio > bestRatio) {
          bestRatio = entry.intersectionRatio;
          best = entry.target.dataset.path;
        }
      });
      if (best && bestRatio > 0.5) {
        this.debouncedCardUpdate(best);
      }
    }, { threshold: [0.4, 0.6, 0.8], root: this.feedEl });

    // 观察已有的卡片 + 后续动态添加的
    const watchExisting = () => {
      this.feedEl.querySelectorAll('.note-card').forEach((c) => this.observer.observe(c));
    };
    watchExisting();

    // 简易 MutationObserver 监听新增卡片
    const mo = new MutationObserver(() => watchExisting());
    mo.observe(this.feedEl, { childList: true });
    this.register(() => mo.disconnect());
  }

  // 渲染单个笔记的双向链接嵌入预览（支持 ![[Note]] 在卡片 Markdown 中直接展开内容）
  async renderEmbeddedNote(embedEl, targetFile, contextFile, depth = 0) {
    if (depth > 3) {
      embedEl.textContent = `[[${targetFile.basename}]]（嵌入层级过深，停止预览）`;
      return;
    }
    try {
      embedEl.empty();
      // 嵌入标题栏（可点击打开完整笔记）
      const titleBar = embedEl.createDiv({ cls: 'embedded-note-title' });
      const linkEl = titleBar.createEl('a', {
        text: `[[${targetFile.basename}]]`,
        cls: 'internal-link'
      });
      linkEl.onclick = (ev) => {
        ev.preventDefault();
        this.app.workspace.getLeaf('tab').openFile(targetFile);
      };

      // 嵌入正文容器
      const bodyEl = embedEl.createDiv({ cls: 'embedded-note-body' });
      bodyEl.addClasses(['markdown-preview-view', 'markdown-rendered']);

      const raw = await this.app.vault.cachedRead(targetFile);
      const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim();

      const subComp = new obsidian.Component();
      await obsidian.MarkdownRenderer.renderMarkdown(body || '(空笔记)', bodyEl, targetFile.path, subComp);
      // 递归处理嵌入内容里的附件和进一步链接预览
      await this.fixAttachmentPreviews(bodyEl, targetFile, depth + 1);

      // 嵌入内容里的内部链接也增强点击
      bodyEl.querySelectorAll('a.internal-link, .internal-link').forEach((linkEl) => {
        const rawHref = linkEl.getAttribute('data-href') || linkEl.getAttribute('href') || (linkEl.textContent || '');
        if (rawHref) {
          linkEl.onclick = (ev) => {
            ev.preventDefault();
            const target = rawHref.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();
            this.app.workspace.openLinkText(target, targetFile.path, false);
          };
        }
      });

      // 稍微缩小字体，视觉上区分嵌入内容
      const size = this.plugin.settings.cardFontSize || 14;
      bodyEl.style.fontSize = Math.max(10, Math.round(size * 0.92)) + 'px';
      bodyEl.style.lineHeight = '1.4';
    } catch (e) {
      embedEl.textContent = `[[${targetFile.basename}]]（预览加载失败）`;
      console.warn('[knowledge-swiper] renderEmbeddedNote failed', e);
    }
  }

  // 可靠解析 [[附件]] 或 ![[附件]] 对应的 TFile，使用 Obsidian 标准链接解析器
  resolveFileFromLink(linkText, sourceFile) {
    if (!linkText || !sourceFile) return null;
    let clean = linkText.split(/[?#]/)[0].replace(/%20/g, ' ').trim();
    // 首选 Obsidian 的链接路径解析（考虑相对位置、唯一性等）
    let file = this.app.metadataCache.getFirstLinkpathDest(clean, sourceFile.path);
    if (file instanceof obsidian.TFile) return file;
    // 回退
    file = this.app.vault.getAbstractFileByPath(clean);
    if (file instanceof obsidian.TFile) return file;
    if (sourceFile.parent) {
      file = this.app.vault.getAbstractFileByPath(sourceFile.parent.path + '/' + clean);
      if (file instanceof obsidian.TFile) return file;
    }
    file = this.app.vault.getAbstractFileByPath('attachment/' + clean);
    if (file instanceof obsidian.TFile) return file;
    // 最后按 basename 找，优先 attachment/
    const base = clean.split('/').pop();
    const cands = this.app.vault.getFiles().filter(f => f.name === base);
    if (cands.length === 1) return cands[0];
    const inAtt = cands.find(f => f.path.includes('attachment/'));
    return inAtt || cands[0] || null;
  }

  async fixAttachmentPreviews(el, sourceFile, depth = 0) {
    if (!el || !sourceFile) return;
    if (depth > 3) return; // 全局递归保护

    // 1. 处理直接的 <img>, <audio>, <video> （来自标准 markdown ![]() 或渲染后的）
    const mediaEls = el.querySelectorAll('img, audio, video');
    mediaEls.forEach((media) => {
      let src = media.getAttribute('src') || media.src || '';
      if (src && !src.startsWith('app:') && !src.startsWith('data:') && !src.startsWith('http')) {
        const targetFile = this.resolveFileFromLink(src, sourceFile);
        if (targetFile instanceof obsidian.TFile) {
          media.src = this.app.vault.getResourcePath(targetFile);
        }
      }

      // 应用预览样式
      if (media instanceof HTMLImageElement) {
        media.style.maxWidth = '100%';
        media.style.maxHeight = 'min(55vh, 420px)';
        media.style.height = 'auto';
        media.style.display = 'block';
        media.style.margin = '8px auto';
        media.style.borderRadius = '6px';
        media.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
        media.style.objectFit = 'contain';
      } else if (media instanceof HTMLAudioElement || media instanceof HTMLVideoElement) {
        media.style.width = '100%';
        media.style.maxWidth = '420px';
        media.style.display = 'block';
        media.style.margin = '8px auto';
        media.style.borderRadius = '4px';
      }
    });

    // 2. 处理 .internal-embed （Obsidian 的 ![[ ]] 嵌入，包括媒体和笔记）
    const internalEmbeds = el.querySelectorAll('.internal-embed');
    for (const embed of internalEmbeds) {
      const src = embed.getAttribute('src') || embed.getAttribute('data-href') || '';
      if (!src) continue;

      const targetFile = this.resolveFileFromLink(src, sourceFile);
      if (!(targetFile instanceof obsidian.TFile)) {
        // 无法解析，降级显示链接
        if (!embed.querySelector('a, .internal-link')) {
          embed.textContent = `[[${src}]]`;
        }
        continue;
      }

      if (targetFile.extension === 'md') {
        // 笔记双向链接嵌入：渲染内容预览
        await this.renderEmbeddedNote(embed, targetFile, sourceFile, depth + 1);
      } else {
        // 媒体附件嵌入（图片/音频/视频）
        let innerMedia = embed.querySelector('img, audio, video');
        if (!innerMedia) {
          // 渲染器有时只放 span.internal-embed[src]，没有子媒体元素 → 我们手动创建
          const ext = targetFile.extension.toLowerCase();
          if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext)) {
            innerMedia = embed.createEl('img');
          } else if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
            innerMedia = embed.createEl('audio', { attr: { controls: '' } });
          } else if (['mp4', 'webm', 'mov', 'mkv'].includes(ext)) {
            innerMedia = embed.createEl('video', { attr: { controls: '' } });
          }
          if (innerMedia) {
            // 插入到 embed 里
            embed.appendChild(innerMedia);
          }
        }
        if (innerMedia) {
          innerMedia.src = this.app.vault.getResourcePath(targetFile);

          // 样式
          if (innerMedia instanceof HTMLImageElement) {
            innerMedia.style.maxWidth = '100%';
            innerMedia.style.maxHeight = 'min(55vh, 420px)';
            innerMedia.style.height = 'auto';
            innerMedia.style.display = 'block';
            innerMedia.style.margin = '8px auto';
            innerMedia.style.borderRadius = '6px';
            innerMedia.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.25)';
            innerMedia.style.objectFit = 'contain';
          } else if (innerMedia instanceof HTMLAudioElement || innerMedia instanceof HTMLVideoElement) {
            innerMedia.style.width = '100%';
            innerMedia.style.maxWidth = '420px';
            innerMedia.style.display = 'block';
            innerMedia.style.margin = '8px auto';
            innerMedia.style.borderRadius = '4px';
          }
        }
      }
    }
  }
}

class LinkSuggestModal extends obsidian.SuggestModal {
  constructor(app, plugin, currentPath) {
    super(app);
    this.plugin = plugin;
    this.currentPath = currentPath;
    this.setPlaceholder('搜索已有笔记添加关联...');
  }

  getSuggestions(query) {
    const all = this.app.vault.getMarkdownFiles();
    const q = query.toLowerCase();
    return all
      .filter((f) => f.path !== this.currentPath && f.basename.toLowerCase().includes(q))
      .slice(0, 12);
  }

  renderSuggestion(file, el) {
    el.createEl('div', { text: file.basename });
    el.createEl('small', { text: file.path });
  }

  onChooseSuggestion(file) {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    if (view && view.currentPath) {
      this.plugin.addLinkToCurrent(view.currentPath, file);
    }
  }
}

class CreateNoteLinkModal extends obsidian.Modal {
  constructor(app, plugin, currentPath) {
    super(app);
    this.plugin = plugin;
    this.currentPath = currentPath;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('快速创建笔记并关联');
    contentEl.createEl('p', { text: '输入标题后会创建新笔记，并在当前回顾笔记里添加关联链接（支持双向）。' });

    const input = contentEl.createEl('input', {
      type: 'text',
      placeholder: '新笔记标题，例如：这个想法的延伸思考'
    });
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.margin = '8px 0 12px';

    // 回车快速创建
    const doCreate = async () => {
      const title = (input.value || '').trim();
      if (!title) {
        this.plugin.showNotice('标题不能为空哦');
        return;
      }
      createBtn.disabled = true;
      await this.plugin.createAndLinkToCurrent(this.currentPath, title);
      this.close();
    };

    const btnRow = contentEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';

    const createBtn = btnRow.createEl('button', { text: '创建并关联', cls: 'mod-cta' });
    const cancelBtn = btnRow.createEl('button', { text: '取消' });

    createBtn.onclick = doCreate;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { doCreate(); }
      else if (e.key === 'Escape') { this.close(); }
    });
    cancelBtn.onclick = () => this.close();

    // 自动聚焦输入框
    setTimeout(() => input.focus(), 50);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class StatsModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText('🎮 知识游戏化 + 艾宾浩斯数据看板');

    const g = this.plugin.gamify || {};

    // Gamify summary
    const summary = contentEl.createEl('div');
    summary.style.marginBottom = '12px';
    summary.style.padding = '8px';
    summary.style.background = 'var(--background-secondary)';
    summary.style.borderRadius = '6px';
    summary.innerHTML = `
      <strong>等级:</strong> ${g.level || 1} &nbsp;&nbsp;
      <strong>总XP:</strong> ${g.total_xp || 0} &nbsp;&nbsp;
      <strong>连续:</strong> 🔥${g.streak || 0}天 &nbsp;&nbsp;
      <strong>成就:</strong> ${(g.achievements || []).length}个
    `;

    // Achievements
    if (g.achievements && g.achievements.length) {
      const ach = contentEl.createEl('div', { text: `🏆 已解锁: ${g.achievements.join(', ')}` });
      ach.style.marginBottom = '8px';
      ach.style.fontSize = '12px';
    }

    // Simple viz: last 14 days bar chart using divs
    const vizTitle = contentEl.createEl('div', { text: '📊 最近14天回顾数 (艾宾浩斯驱动)' });
    vizTitle.style.fontWeight = 'bold';
    vizTitle.style.margin = '8px 0 4px';

    const daily = g.daily_reviews || {};
    const dates = [];
    const today = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0,10);
      dates.push({date: ds, count: daily[ds] || 0});
    }

    const maxC = Math.max(1, ...dates.map(d => d.count));
    const barContainer = contentEl.createEl('div');
    barContainer.style.display = 'flex';
    barContainer.style.alignItems = 'flex-end';
    barContainer.style.height = '80px';
    barContainer.style.gap = '2px';
    barContainer.style.marginBottom = '12px';

    dates.forEach(({date, count}) => {
      const bar = barContainer.createEl('div');
      bar.style.width = '14px';
      bar.style.height = `${(count / maxC) * 70}px`;
      bar.style.background = count > 0 ? 'var(--interactive-accent)' : '#444';
      bar.style.borderRadius = '2px 2px 0 0';
      bar.title = `${date}: ${count} 次`;
      const label = barContainer.createEl('div', { text: date.slice(5) });
      label.style.fontSize = '8px';
      label.style.writingMode = 'vertical-rl';
      // better layout
    });

    // Due status
    const dueTitle = contentEl.createEl('div', { text: '📅 复习状态 (基于艾宾浩斯)' });
    dueTitle.style.fontWeight = 'bold';
    dueTitle.style.margin = '8px 0 4px';

    const allFiles = this.plugin.buildQueue(); // uses due priority
    let overdue = 0, dueToday = 0, upcoming = 0;
    const todayStr = new Date().toISOString().slice(0,10);
    allFiles.forEach(f => {
      const rec = this.plugin.reviewData[f.path] || {};
      if (!rec.due) { overdue++; return; } // treat new as overdue for review
      if (rec.due < todayStr) overdue++;
      else if (rec.due === todayStr) dueToday++;
      else upcoming++;
    });

    const statusEl = contentEl.createEl('div');
    statusEl.innerHTML = `
      <span style="color:#f66">Overdue: ${overdue}</span> | 
      <span style="color:#fa0">Due Today: ${dueToday}</span> | 
      <span style="color:#6c6">Upcoming: ${upcoming}</span>
    `;
    statusEl.style.marginBottom = '12px';

    // Top due notes list (Ebbinghaus prioritized)
    const listTitle = contentEl.createEl('div', { text: '🔥 优先复习 (艾宾浩斯排序前10)' });
    listTitle.style.fontWeight = 'bold';
    listTitle.style.margin = '8px 0 4px';

    const list = contentEl.createEl('div');
    const dueFiles = this.plugin.buildQueue().slice(0, 10); // already sorted by due

    if (!dueFiles.length) {
      list.textContent = '没有待复习笔记';
      return;
    }

    dueFiles.forEach((f) => {
      const rec = this.plugin.reviewData[f.path] || {};
      const dueInfo = rec.due ? `Due: ${rec.due} (int:${rec.interval || 1})` : 'New';
      const row = list.createEl('div', { text: `${f.basename} - ${dueInfo}` });
      row.style.margin = '2px 0';
      row.style.cursor = 'pointer';
      row.style.fontSize = '12px';
      row.onclick = () => {
        this.app.workspace.getLeaf('tab').openFile(f);
        this.close();
      };
    });

    const tip = contentEl.createEl('small', { text: '点击打开笔记。质量按钮(忘记/困难/良好/简单)会更新艾宾浩斯间隔和XP。' });
    tip.style.color = 'var(--text-muted)';
    tip.style.display = 'block';
    tip.style.marginTop = '8px';
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SwiperSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    // this.plugin is set by super
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Knowledge Swiper 设置' });

    new obsidian.Setting(containerEl)
      .setName('最大队列长度')
      .setDesc('一次加载多少条 (推荐 50-150)')
      .addText((t) => {
        t.setValue(String(this.plugin.settings.maxQueue));
        t.onChange(async (v) => {
          this.plugin.settings.maxQueue = parseInt(v) || 100;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('每日回顾数量')
      .setDesc('每天最多回顾多少条笔记 (0为不限)。打开Feed时会根据今日已回顾数裁剪队列')
      .addText((t) => {
        t.setValue(String(this.plugin.settings.dailyLimit || 0));
        t.onChange(async (v) => {
          this.plugin.settings.dailyLimit = parseInt(v) || 0;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('卡片文字大小')
      .setDesc('插件内卡片正文的字体大小 (px)')
      .addSlider((slider) => {
        slider.setLimits(10, 28, 1)
          .setValue(this.plugin.settings.cardFontSize || 14)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.cardFontSize = v;
            await this.plugin.saveSettings();
          });
      });

    new obsidian.Setting(containerEl)
      .setName('卡片主题 / 模式')
      .setDesc('切换卡片显示风格 (亮色/暗色/蓝色/终端/黑客帝国/火星)')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('light', '亮色模式')
          .addOption('dark', '暗色模式')
          .addOption('blue', '蓝色模式')
          .addOption('terminal', '终端模式')
          .addOption('matrix', '黑客帝国')
          .addOption('mars', '火星模式');
        dropdown.setValue(this.plugin.settings.cardTheme || 'dark');
        dropdown.onChange(async (v) => {
          this.plugin.settings.cardTheme = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('追加到每日笔记')
      .setDesc('在已有 2026-xx-xx.md 里追加 ## 知识回顾 记录 (默认关闭，不创建新文件)')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.appendToDaily);
        t.onChange(async (v) => {
          this.plugin.settings.appendToDaily = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('显示通知')
      .setDesc('是否弹出操作提示、升级、成就解锁、创建/删除/关联成功等 Notice 通知（回顾记录本身已无 Toast）')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.showNotices !== false);
        t.onChange(async (v) => {
          this.plugin.settings.showNotices = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('仅回顾有链接的笔记')
      .setDesc('只包含笔记正文中至少有一个 [[wikilink]] 的笔记（促进关联知识回顾）')
      .addToggle((t) => {
        t.setValue(!!this.plugin.settings.onlyLinkedNotes);
        t.onChange(async (v) => {
          this.plugin.settings.onlyLinkedNotes = v;
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('自定义关键词过滤')
      .setDesc('只回顾标题或标签包含这些关键词的笔记（逗号或空格分隔，留空则不过滤）')
      .addText((t) => {
        t.setValue(this.plugin.settings.keywordFilter || '');
        t.onChange(async (v) => {
          this.plugin.settings.keywordFilter = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('排除文件夹 (逗号分隔)')
      .setDesc('默认已排除 attachment/, AI outputs/, Clippings/ + 日记')
      .addText((t) => {
        t.setValue(this.plugin.settings.excludeFolders.join(','));
        t.onChange(async (v) => {
          this.plugin.settings.excludeFolders = v.split(',').map(s => s.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    new obsidian.Setting(containerEl)
      .setName('排除日期日记')
      .setDesc('排除纯 2026-06-03.md 格式的日记文件')
      .addToggle((t) => {
        t.setValue(this.plugin.settings.excludeDailies);
        t.onChange(async (v) => {
          this.plugin.settings.excludeDailies = v;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl('p', { text: '提示: 质量按钮(忘记/困难/良好/简单)触发艾宾浩斯调度 + 游戏化XP。数据看板有 streak、XP、每日柱状图、due状态、遗忘曲线驱动的优先队列。同标签、附件预览、直接编辑等功能保留。设置中可调每日上限、字体、主题、仅链接笔记、关键词过滤。' });
  }
}

module.exports = KnowledgeSwiperPlugin;
