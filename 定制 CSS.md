已放在库中这个位置，通过图片可以找到对应 CSS 目录，结合[[插件清单和配置#^12b03a]]这部分使用，更爽

![[Pasted image 20260706104654.png]]
# 三个 CSS Snippet：让知识库「好看」的秘密
Obsidian 的外观可以通过 CSS snippet 精细控制。我有三个 snippet，每一个都解决一个具体的美学问题。

#### Snippet 1：`graph-custom-lines.css`——让图谱成为艺术品

Obsidian 默认的知识图谱配色相当朴素。这个 CSS snippet 把图谱变成了**赛博朋克风格的可视化工具**。

核心改动：
- **连线**：青色霓虹色（`#2efff1`），透明度 0.3，远距离节点之间的连线像发光的蛛丝
- **高亮连线**：荧光粉色（`#ff3366`），透明度 0.85，鼠标悬停时连线瞬间高亮，像电流通过
- **节点**：纯白，透明度 0.8，在暗色背景下像星点
- **箭头**：与连线同色系，确保有向图的方向可读

最棒的设计是**集成 Style Settings 面板**——你不需要改 CSS 代码，打开 Obsidian 设置 → Style Settings → graph-custom-lines，就能从 9 种预设色彩中挑选连线颜色、5 种高亮色彩、4 种节点颜色，还可以用滑块调节透明度。零代码定制。

```css
/* 核心规则示例 */
.graph-view.color-line {
    color: var(--graph-line-color) !important;
    opacity: var(--graph-line-opacity) !important;
}
.graph-view.color-line-highlight {
    color: var(--graph-line-highlight-color) !important;
    opacity: var(--graph-line-highlight-opacity) !important;
}
```

> ⚠️ **诚实提醒**：图谱是 Canvas 渲染的，CSS 只能控制线条和节点的颜色/透明度，**不能**添加动画、涟漪或外发光效果。我曾经花了一下午试图给节点加 `@keyframes` 脉冲动效，全部失败——CSS 的 `animation` 和 `filter` 碰不到 Canvas 绑制的内容。这段教训一并分享给你：在对渲染机制没有十足把握的时候，先打开开发者工具看 DOM，别急着铺代码。

#### Snippet 2：`line-spacing.css`——让中英文混排「能呼吸」

两行 CSS 解决我最在意的阅读体验问题：

```css
/* 编辑模式段间距 */
div.cm-line {
  padding-top: 0.3em !important;
  padding-bottom: 0.3em !important;
}
/* 阅读模式和编辑模式行高统一 */
.markdown-preview-view,
.markdown-source-view.mod-cm6 .cm-scroller {
  --line-height-normal: 35px;
}
```

35px 的行高 + 18px 的字号，比例约 1.94。这个比例对中英文混排来说是一个「甜区」——够通风，但不至于松散到影响信息密度。你可以根据自己的字号调整这个比例（推荐 1.8-2.0 之间）。

#### Snippet 3：`book-covers.css`——让 Bases 卡片像精装书
查看：[[书单]]
Obsidian Bases（数据库视图）的卡片模式默认很朴素。这个 snippet 给每张卡片加上了精装书的视觉效果：

- **书脊阴影**：多层叠加的 `box-shadow` 模拟书脊的立体感
- **书封光泽**：`linear-gradient` 模拟书封上的高光条
- **悬停动效**：鼠标悬停时卡片微微上浮 + 放大 + 阴影加深

```css
.bases-cards-cover {
  border-radius: 2px 6px 6px 2px;
  box-shadow: 
    inset 1px 1px 0 1px rgba(255,255,255,0.2), 
    -4px 2px 4px 0 rgba(0,0,0,0.3), 
    -8px 8px 20px 0 rgba(0,0,0,0.2);
}
.bases-cards-item:hover .bases-cards-cover {
  transform: translateY(-4px) scale(1.03);
}
```

#### 三个 Snippet 的协同效应

这三个 snippet 不是各自为政的——它们在一起构成了一个完整的「视觉体验三角」：

- **line-spacing.css** 管「文本层」——阅读体验的基底，决定了你每天盯着文字看数小时的舒适度。这是最不显眼但最重要的 snippet。35px 行高 + 0.6em 段间距的组合，加上 Source Han Serif CN 的字体渲染，产生了一种接近 LaTeX 排版的「学术感」。如果你经常读长文，强烈建议把行高调到 1.8-2.0 倍字号——你会发现眼睛疲劳显著降低。
- **graph-custom-lines.css** 管「结构层」——图谱是你知识结构的可视化投射。青色霓虹配色不只是「好看」——低透明度（0.3）的连线让远处节点之间的弱连接近乎透明，而高亮时的荧光粉（透明度 0.85）让当前节点的直接连接「跃然纸上」。这种视觉层次和知识检索具有一一对应关系：探索状态（低注意力）→ 广域扫描；聚焦状态（高亮）→ 深入挖掘。
- **book-covers.css** 管「展示层」——Bases 卡片视图是给别人看的（数据看板、文献列表、项目展示）。书封效果让卡片从「数据库记录」变成了「值得翻阅的藏品」。悬停时的上浮动效（`translateY(-4px) scale(1.03)`）是一个微妙的心理提示：「这个可以点」。

#### 排版哲学的延伸：为什么我不装更多 CSS snippet

Obsidian 社区有大量炫酷的 CSS snippet——彩虹文件夹、霓虹标题、毛玻璃侧边栏。我试过很多，最后只留下了这三个。

筛选标准是：**这个 snippet 是否在每次打开 Obsidian 时都产生价值？**

彩虹文件夹只在打开侧边栏时有用。霓虹标题在第一眼惊艳后，长期使用会产生视觉疲劳。而段间距和行高——你每一次阅读、每一次编辑都在感受它们的存在或缺失。这就是「基础设施性 snippet」和「装饰性 snippet」的区别。

这三个 snippet 的共同哲学是：**小改动，大感知**。行距加 5px 可能没人注意到，但他们会在潜意识里觉得「这个笔记读起来很舒服」。图谱连线换个颜色可能不会被人夸，但他们会更愿意打开图谱视图——而这恰恰是 Obsidian 最独特的功能之一。

[[Jackywine 知识库欢迎你的到来]]