# opencode-session

[English](README.en.md) | 简体中文

OpenCode v2 的统一会话协同插件（`o3p.session`）：把 `/btw` 升级为可流式追问、防误关丢失的平行时空分身，提供可拖拽调宽与全屏切换的右侧分屏子代理微操台，并在 Code Mode 中提供 `tools.session.*` 跨会话传呼与历史切片检视原语。

## 核心能力

- **`/btw` 平行时空分身（Forked Aside）**：
  - 基于原生 `session.fork` 完整继承当前会话已结算上下文、角色身份（无缝兼容 `opencode-prompts`）与前缀缓存路由键。
  - 自动标记 `archived: true` 从顶层 `/sessions` 列表隐身，由右侧分屏统一纳管，告别模态弹窗按错 `Esc` 永久丢失答案的问题。
  - 默认开启工作区只读锁（屏蔽 `write`/`edit` 等改文件工具，保留 `read`/`grep`/`glob`/`shell` 供只读诊断），面板顶栏支持一键解锁完整权限。
- **`/sub` 人类直派专家与全树微操台**：
  - 输入 `/sub [@agent] [任务]` 可不经过主线模型直接召唤空白上下文子代理进右侧分屏单聊。
  - 右侧分屏（`session.panel`）原生支持鼠标拖动分割线调整宽度、一键切换分屏与全屏、自适应宽度的顶部全树标签栏（支持右键弹出菜单重命名 / 复制 ID / 恢复最近关闭标签，及滚轮与中键关闭）、可点击展开输出的 `$ shell` 卡片与 `+ Thought` 思考流、智能防抢滚流式视口与按会话保存草稿的图形化输入框。
  - 点击 `原生视图` 查看重型代码 Diff 时，自动在原生子会话底部（`session.composer.top`）挂载默认 1 行收起、点击即展开的图形化输入栏，打破原生子会话只读限制，支持运行中插队纠偏（`steer`）与一键返回分屏。
  - 双档 **「送回主线（Handoff）」**：默认以随轮模式（`park`）静默挂入主会话收件箱，亦可立即唤醒主线（`wake`）。
- **Code Mode `tools.session.*` 会话操作系统**：
  - 核心原语默认启用 `pinned: true`，在 `# Code Mode` 目录中直接内联展示完整 TypeScript 调用签名，支持在 `execute` 中用 JavaScript 并发编排。
  - **切片检视组**：`list`、`info`、`read`（支持正负数 `offset` 与正负数 `limit` 正反向按条数切片，独立开关 `includeTools` 与 `includeReasoning`）、`search`（字面子串检索）。
  - **传呼与关注组**：`create`（默认惰性预铸 `ses_...` ID，首次 `send` 时才真正落库，避免产生空壳会话）、`peers`、`send`（支持向已有/预铸 ID 发送或通过 `create: { agent, title }` 一步创建并发送；仅传输显式 `message` 文本，零隐式上下文泄漏；区分 `wake` 立即唤醒与 `park` 随轮挂入；连续自动唤醒超过 3 跳自动降级为 `park` 防止后台死循环且不丢消息）、`watch`、`unwatch`、`wait`。

## 安装与构建

需要 Bun `>= 1.3` 与 OpenCode v2（类型基线 `@opencode/plugin` `2.3.0`，兼容 `>= 2.2.0`）。

```bash
bun install
bun run build
```

在 OpenCode v2 的 `opencode.jsonc` 中挂载本目录：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/绝对路径/opencode-session",
      "options": {
        "maxWakeHops": 3,
        "btwReadonlyByDefault": true,
        "enableSessionTools": true,
        "replaceNativeSubagentTool": false
      }
    }
  ]
}
```

首次启用后，建议在 TUI 输入 `/plugins`，按 `Ctrl+A` 显示内部插件，将内置一次性弹窗插件 `opencode.btw` 设为 `disable`（本插件已通过高优先级快捷键层优先接管 `/btw`）。

## 常用命令与快捷键

| 入口 / 按键 | 作用 |
| --- | --- |
| `/btw [问题]` | 切出继承当前上下文与角色的平行时空分身并在右侧分屏流式作答；不带参数则打开分屏新建输入 |
| `/sub [@agent] [任务]` | 不占主线轮次，直接派生指定角色（如 `@explore`、`@oracle`）进入右侧分屏 |
| `/aside`（别名 `/pager`） | 展开或收起右侧分屏微操台（历史会话与草稿始终保留） |
| 鼠标拖动分屏竖线 | 自由调整左右分屏宽度（宿主自动记忆宽度） |
| 分屏内 `Enter` / `Alt+Enter` | 空闲时续接追问；运行中 `Enter` 插队纠偏（Steer），`Alt+Enter` 排队（Queue） |
| 分屏内 `Esc` | 关闭二级下拉抽屉或将焦点交还左侧主会话输入框，**绝不销毁会话内容** |

## 配置选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用本插件 |
| `maxWakeHops` | `3` | 模型间连续自动 `wake` 唤醒的最大跳数，超限自动降级为 `park` 进收件箱（人类发言重置为 `0`） |
| `btwReadonlyByDefault` | `true` | `/btw` 分身创建时是否默认启用只读锁（锁写文件工具，保留 `shell`） |
| `readonlyBlockedTools` | `["write", "edit", "lsp_rename", ...]` | 只读锁激活时从模型上下文移除的工具名列表 |
| `enableSessionTools` | `true` | 是否注册 Code Mode `tools.session.*` 命名空间工具 |
| `replaceNativeSubagentTool` | `false` | 设为 `true` 时隐藏原生 `subagent` 工具，统一由 `tools.session.*` 承担委托 |
| `dbPath` | 自动探测 | 可选显式指定 SQLite `opencode.db` 路径 |

## 许可

[MIT](LICENSE)
