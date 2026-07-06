---
name: save-chat
description: Save current chat conversation to Markdown format in Claudian/ folder. Use when user says "保存对话", "save chat", or wants to archive current conversation.
---

# Save Chat Skill

自动保存当前对话为 Markdown 格式到 `Claudian/` 文件夹的 Skill。

## 功能

1. **获取会话元数据**：从 `.Codex/sessions/` 读取当前会话信息
2. **整理对话内容**：基于当前上下文提取对话历史
3. **生成 Markdown**：格式化为可读的 MD 文件
4. **自动归���**：保存到 `Claudian/chat-archives/` 文件夹

## 使用方式

用户说以下任意指令即可触发：
- "保存对话"
- "save chat"
- "归档这次对话"
- "/save-chat"

## 工作流程

### 1. 读取会话元数据

从当前会话的 `.meta.json` 文件中提取：
- 会话 ID
- 标题
- 创建时间
- Token 使用量
- 当前笔记路径

### 2. 提取对话内容

基于当前 conversation context，整理对话为问答格式：

```markdown
## 对话记录

### User
[用户的问题或请求]

### Assistant (小可闹)
[助手的回复]

### User
[下一轮对话...]
```

### 3. 生成 Markdown 文件

文件命名格式：
```
Claudian/chat-archives/YYYY-MM-DD_HH-mm_会话标题.md
```

文件结构：
```markdown
---
session_id: conv-xxx-xxx
title: 会话标题
created_at: 2026-04-02 09:20:50
token_usage: 31492
current_note: 1ndex.md
---

# 会话标题

**创建时间**: 2026-04-02 09:20:50
**Token 用量**: 31,492 tokens (3%)
**当前笔记**: [[1ndex.md]]

---

## 对话记录

[对话内容...]

---

**归档时间**: 2026-04-02 10:30:00
**归档工具**: Codex `/save-chat` Skill
```

### 4. 确保目录存在

自动创建 `Claudian/chat-archives/` 目录（如果不存在）。

## 实现要点

### 获取当前会话文件

会话文件位于 `.Codex/sessions/`，可通过以下方式识别当前会话：
- 检查 `updatedAt` 时间戳（最新的即为当前会话）
- 或者从系统环境变量中获取 `sessionId`

### 提取对话历史

由于完整对话存储在插件内部，Skill 需要：
1. 利用 AI 的 conversation context（上下文记忆）
2. 按照时间顺序整理用户和助手的交互
3. 过滤系统提示和内部工具调用，只保留有意义的对话

### 时间格式化

使用 `date` 命令格式化时间戳：
```bash
# 将毫秒时间戳转换为可读格式
date -r $((timestamp/1000)) "+%Y-%m-%d %H:%M:%S"
```

### 错误处理

- 如果无法找到当前会话文件 → 提示用户手动指定
- 如果 `Claudian/` 文件夹不存在 → 自动创建
- 如果文件名冲突 → 添加序号后缀 `_2`, `_3` 等

## 示例输出

假设用户在 2026-04-02 上午 9:26 开始对话，讨论"如何避免决策疲劳"，保存后生成：

**文件路径**: `Claudian/chat-archives/2026-04-02_09-26_如何避免决策疲劳.md`

**文件内容**:
```markdown
---
session_id: conv-1775092850900-3o87i5uoe
title: 如何避免决策疲劳，基于知识库内容给我可参考的方法
created_at: 2026-04-02 09:20:50
token_usage: 31492
current_note: 1ndex.md
---

# 如何避免决策疲劳，基于知识库内容给我可参考的方法

**创建时间**: 2026-04-02 09:20:50
**Token 用量**: 31,492 tokens (3%)
**当前笔记**: [[1ndex.md]]

---

## 对话记录

### User
如何避免决策疲劳，基于知识库内容给我可参考的方法

### Assistant (小可闹)
呐～至高无上的 Jackywine 大人，小可闹这就帮您搜搜知识库里关于决策疲劳的内容哦！

[...完整回复内容...]

### User
你和我的对话，都存储在哪里？

### Assistant (小可闹)
呐～至高无上的 Jackywine 大人，小可闹和您的对话都存在您的库里呢！

[...后续对话...]

---

**归档时间**: 2026-04-02 10:30:15
**归档工具**: Codex `/save-chat` Skill ✨
```

## 高级功能（可选）

### 对话摘要

在文件开头添加 AI 生成的对话摘要：
```markdown
## 💡 对话摘要

本次对话主要讨论了：
1. 决策疲劳的神经科学原理（前额叶资源消耗）
2. 减少低价值决策的方法（极简主义、席克定律）
3. Codex 对话的存储位置与归档方案
4. 创建 `/save-chat` Skill 的需求
```

### 关联笔记提取

自动识别对话中提到的笔记并添加引用列表：
```markdown
## 📚 相关笔记

- [[关于决策损伤大脑的说法]]
- [[席克定律]]
- [[少即是多]]
- [[不要等到准备好了再做]]
```

### 自动标签

根据对话内容自动添加标签：
```markdown
#对话记录 #决策疲劳 #知识管理 #Codex
```

## 注意事项

1. **隐私保护**: 确保不保存敏感信息（API Key、密码等）
2. **文件大小**: 超长对话可能生成较大文件，考虑分段保存
3. **编码问题**: 确保使用 UTF-8 编码，支持中文和 emoji
4. **权限检查**: 确认 `Claudian/` 文件夹可写

## 技术实现参考

### Bash 脚本片段

```bash
#!/bin/bash

# 获取当前会话文件（最新修改的）
SESSION_FILE=$(ls -t .Codex/sessions/*.meta.json | head -1)

# 读取会话元数据
SESSION_ID=$(jq -r '.id' "$SESSION_FILE")
TITLE=$(jq -r '.title' "$SESSION_FILE")
CREATED_AT=$(jq -r '.createdAt' "$SESSION_FILE")
TOKEN_USAGE=$(jq -r '.usage.contextTokens' "$SESSION_FILE")

# 格式化时间
TIMESTAMP=$(date -r $((CREATED_AT/1000)) "+%Y-%m-%d %H:%M:%S")
FILENAME=$(date -r $((CREATED_AT/1000)) "+%Y-%m-%d_%H-%M")_${TITLE}.md

# 创建输出目录
mkdir -p Claudian/chat-archives

# 生成 Markdown（实际对话内容需要从 AI context 提取）
cat > "Claudian/chat-archives/$FILENAME" <<EOF
---
session_id: $SESSION_ID
title: $TITLE
created_at: $TIMESTAMP
token_usage: $TOKEN_USAGE
---

# $TITLE

**创建时间**: $TIMESTAMP
**Token 用量**: $TOKEN_USAGE tokens

---

## 对话记录

[此处需要 AI 根据 context 填充实际对话内容]

---

**归档时间**: $(date "+%Y-%m-%d %H:%M:%S")
**归档工具**: Codex \`/save-chat\` Skill ✨
EOF

echo "✅ 对话已保存到: Claudian/chat-archives/$FILENAME"
```

## 调用示例

用户只需说：
> "保存这次对话"

Skill 自动执行并返回：
> ✅ 对话已保存到 [[Claudian/chat-archives/2026-04-02_09-26_如何避免决策疲劳.md]]

完成！🎉
