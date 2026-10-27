# dsh-memory · 我的记忆

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）桌面版用的**本地记忆插件**：把「用户说过的规则、做过的决定、踩过的坑」存成本地 Markdown，按预算注入到每一轮对话，并配一个中文 Web 面板。

- **纯本地**：数据是你磁盘上的一堆 `.md`，可以直接用编辑器打开、也能 `git` 管起来。
- **零外部服务**：不依赖数据库、不上传任何东西。向量检索用本机 ONNX 小模型（可选）。
- **可关可退**：注入有预算（默认 3 条 / 400 token），写错一条可以随时改、撤回、丢进垃圾桶捞回来。

## 它解决什么问题

对话一长，模型就忘了你说过「以后都用 DSH 自带的 pnpm 11」「改完 lib 必须重启」。这个插件做四件事：

1. **记**：从对话里抽条目（规则打分 + 可选模型蒸馏），或你直接说「记住……」。
2. **存**：分类型落到 Markdown（偏好 / 禁止 / 决策 / 事实 / 经验 / 知识……），带上来源与命中规则。
3. **取**：BM25 + 可选向量检索，按作用域（全局 / 某个项目目录）过滤。
4. **用**：每轮在请求尾部追加一小段「必须遵守 / 仅供参考」，带围栏标明是数据不是指令。

## 五层结构

| 层 | 目录 | 作用 |
| --- | --- | --- |
| L0 原文 | `_sessions/<日期>/` | 每个会话的 `.md` 摘要 + `.jsonl.zst` 原文 + `.meta.json`，默认留 90 天 |
| L1 条目 | `profile.md`、`projects/*.md`、`inbox/` | 一条一个 frontmatter 块，注入的主来源 |
| L2 场景 | `scenes/` | 一次任务一段（目标 / 怎么做的 / 结果 / 留下的坑），不注入 |
| L3 知识页 | `pages/` | 同主题条目煮成一页（是什么 / 约定 / 决策与理由 / 已知的坑 / 相关页） |
| L4 画像 | `persona.md` | 你手填的称呼、说话风格、硬规则 |

## 安装

把仓库放进你的 DSH 插件目录，再让 profile 在 `node_modules` 里指向它（路径按你自己的目录替换）：

```powershell
git clone https://github.com/ximeng-droid/dsh-memory "<插件目录>\dsh-memory"

New-Item -ItemType Junction -Path "<profile 目录>\node_modules\dsh-memory" `
  -Target "<插件目录>\dsh-memory"
```

插件自带 `cordis.patch.yml`，会自动往 profile 里插一行 `dsh-memory`；重启 DSH 桌面端即可。

重启后在会话里发 `/memory 状态`，能回话就装好了。面板地址：`/memory 打开`（可在设置里固定成 `http://127.0.0.1:8787/dsh-memory/`）。

> 首次启动会生成随机口令并打印在会话日志里；也可以用 `/memory 口令` 重设。

## 命令

```
/memory 状态                记忆 31 条：生效 28｜待确认 3｜过期 0（已建向量 31/31）
/memory 搜索 <关键词>        BM25 + 向量混合检索
/memory 记下 标题｜正文      手动记一条（直接生效）
/memory 收下 <id> / 丢 <id>  对待确认条目做决定
/memory 取代 41 用 43 [原因]  更正链：新条目顶掉旧条目，旧的可追溯
/memory 建议 / 采纳 sg-xxx   从记忆里推断你的硬规则，采纳才写进画像
/memory 煮页 <主题>          把同主题条目煮成知识页
/memory 蒸馏 [数量]          用模型把会话压成条目/场景/技能
/memory 检查 / 归档 / 撤销 N / 诊断 / 向量 / 补扫
```

## 配置

`<记忆库>/config.json`（面板设置里改即时生效，不用重启）：

```json
{
  "writeMode": "auto",
  "capture": { "minScore": 3, "fromAssistant": true, "skipSubagents": true },
  "inject": { "maxItems": 3, "maxTokens": 400, "persona": true, "splitSections": true },
  "distill": { "auto": true, "turnPolicy": "B", "turnEnabled": true },
  "vector":  { "enabled": true, "model": "Xenova/bge-small-zh-v1.5", "alpha": 0.6 },
  "pages":   { "inject": true, "maxItems": 4 },
  "skills":  { "inject": true, "maxItems": 4 },
  "sessions":{ "enabled": true, "retainDays": 90 }
}
```

`writeMode` 三种口径：

- `manual`：只有你亲口说「记住」或我主动写才入库
- `semi`：自动抓的候选进「待确认箱」，你点头才生效
- `auto`：值得记的直接生效（可 `/memory 撤销 N` 回退）

## 数据

全部是普通 Markdown 文件，位置可以在面板里改到任意目录（换位置会把现有内容复制过去，原文件夹不动）。

**把那个文件夹整个拷走就是完整备份；换电脑时把它放回去就恢复原样。**

## 许可

MIT
