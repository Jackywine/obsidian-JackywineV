![[Snipaste_2026-07-06_10-09-44@2x.png]]
我将 skills 放置于此目录，按理说 [[Agent]] 会访问你的 [[skills]] 并灵活调用
如果看不到此文件夹：![[Snipaste_2026-07-06_10-11-33@2x.png]]
# 扩展——Skills、Canvas 与 Knowledge Swiper

如果说插件是给 Obsidian 加能力，Skills 就是给 AI 加能力。这一章公开了我的五个 Obsidian 专属 Skills、Canvas 画布 Skill 中的 CJK 优化（中文用户的一小步）、以及我自研的 Knowledge Swiper 回顾插件。

### 3.1 五个 Obsidian 专属 Skills：AI 能力的插件化

Skills 不是程序，不是插件，不是 MCP 服务器。它们是一份份纯文本的 `SKILL.md` 文件，存放在知识库的 `.agents/skills/` 目录下。

工作原理很简单：当你的对话内容命中某个 Skill 的描述时，AI 自动加载那份 `SKILL.md`，然后按照里面的指令行事。比如你说「创建一个白板」，AI 自动加载 `json-canvas` Skill，开始生成规范的 `.canvas` 文件。

我的五个 Obsidian 专属 Skills：

| Skill | 触发场景 | 能力 |
|---|---|---|
| `obsidian-markdown` | 写笔记、wikilink、callout、frontmatter | 生成规范的 Obsidian 语法——wikilink 格式、callout 折叠块、YAML 属性 |
| `json-canvas` | 创建白板 / 脑图 `.canvas` | 生成节点、边、分组，控制位置和颜色 |
| `obsidian-bases` | 创建数据库 `.base` | 视图、筛选、公式、汇总 |
| `obsidian-randomwalk` | 「随机漫步」「逛逛笔记」「跳一跳」 | 通过 wikilink 跳跃发现冷门笔记，制造知识探索的惊喜感 |
| `save-chat` | 「保存对话」 | 将当前对话存档为 Markdown 到 `Claudian/` 文件夹 |

Skill 的本质是什么？它是一份**给 AI 的专题指令书**——告诉 AI 在这个场景下「该怎么思考、用什么格式、遵守什么规则」。Skills 胜过把指令放在提示词里，因为它**按需加载**：你不打开 canvas 就不加载 json-canvas Skill，不浪费上下文。

#### 五个 Skill 的实战案例

光讲概念不够，来看几个真实的使用场景。

**场景一：「帮我创建一个白板，梳理 2026 年的学习计划」**

触发后，json-canvas Skill 自动加载。AI 会：
1. 创建 `.canvas` 文件
2. 用 group 节点做分区（「AI 技术」「设计能力」「写作」「商业」）
3. 每个分区内放置 text 节点表示具体学习目标
4. 用 edge 连线表达「前置于」「依赖于」等关系
5. 用颜色区分优先级（绿色=已完成 / 橙色=进行中 / 红色=未开始）

整个过程你只需要给一句话指令。AI 处理的是 JSON 格式、节点坐标、颜色编码、edge 连接——这些你完全不需要关心。

**场景二：「随机漫步，两跳」**

这是我最喜欢的玩法。触发 obsidian-randomwalk Skill 后：
- AI 从指定笔记出发
- 通过 wikilink 跳到关联笔记（第一跳）
- 再从关联笔记的关联笔记中随机选取一个（第二跳）
- 展示从起点到终点的路径，并告诉你「这一路上发现了什么」

有一次我从 [[AI Skills]] 出发，两跳后落到了 [[1918]]（一篇关于 1918 年历史的笔记）。路径是 AI Skills → Skill 概念 → 知识工具史 → 1918 年信息组织方式。如果不是随机漫步，我永远不会意识到「AI 时代的 Skills 系统和一百年前的知识组织方式之间存在传承关系」。

这就是随机漫步的价值：**它打破了你固有的导航习惯，让你发现 wikilink 网络中你自己都不会主动走的路径。** 知识库的「惊喜感」不是设计出来的，是在足够密集的链接网络中自然浮现的。

**场景三：「保存对话」**

这是最常用的 Skill。当一次有价值的 AI 对话结束，说一句「保存对话」，AI 会把整段对话整理成 Markdown 格式存入 `Agent/` 文件夹，文件名格式 `YYYY-MM-DD_话题.md`。这解决了 AI 对话「聊完就丢」的问题——未来你可以搜索、回顾、引用之前的协作成果。我已经存了几十份对话记录，偶尔翻一翻，能看到自己思考的变化轨迹。

---

### 3.2 CJK 优化的 Canvas Skills：中文用户的一小步

`json-canvas` Skill 的基础版本来自 Obsidian CEO kepano 维护的社区 Skill。但我在实际使用中发现了一个严重问题：**所有文本节点的尺寸估算都是按英文计算的。**

中文/日文/韩文字符在 Obsidian Canvas 中的渲染宽度大约是拉丁字符的 **2 倍**。意味着同一个节点，英文版刚好能显示的内容，中文版会被裁掉一半。

更糟的是，Obsidian Canvas **不会自动缩放文本适配节点**——溢出的文字直接消失，不留任何滚动条或省略号。

于是我在 Skill 中加入了完整的 CJK 文本节点尺寸指南。以下是核心内容：

```
### CJK 混排宽度估算

中文/日文/韩文字符约等于拉丁字符 2 倍宽度。
一行如 `markdown · canvas · bases`（~28 个混排字符）
至少需要 340px，而不是按字符数估算的 210px。

### 常见尺寸错误 → 正确尺寸

| 节点内容 | 错误 | 正确 |
|---|---|---|
| 📄 AGENTS.md / 小可闹角色 | 115×70 | 155×105 |
| 📄 Templates/ / 笔记模板 | 130×70 | 180×105 |
| 🤖 5 个 Skills / markdown · canvas · bases / randomwalk · save-chat | 210×60 | 340×115 |
| 🎨 21 个主题 | 240×60 | 370×100 |
```

还有一个关于图例卡片的排版原则——**单行横向排版优于多行堆叠**：

```
❌ 不推荐：三行堆叠（需要高卡片）
🟢 绿色 = 可打包分发
🔴 红色 = 个人内容
🔵 青紫 = 项目文件

✅ 推荐：单行横向排列（440×80 即可）
🟢 绿色 = 可打包分发  🔴 红色 = 个人内容  🔵 青紫 = 项目文件
```

所有改动都汇成了一条设计金句，放在 Skill 末尾：

> **Oversized nodes look clean. Clipped text looks broken. Always err on the side of too big.**

这一点小改动背后是一个更大的问题：**中文用户在 Obsidian 的 AI 生态中是被低估的群体**。大多数社区 Skill、插件文档、CSS 预设都是以英文排版为基准设计的。CJK 优化不只是「文字大一点」，而是让整个 AI 工具链正确理解中文文本在空间中的物理形态。

如果你用 Obsidian Canvas 并且写中文，这份 Skill 可以省掉你无数次「字被吞了→猜尺寸→改尺寸」的调试循环。

---
[[Jackywine 知识库欢迎你的到来]]