---
description: "Web 客户端的知识库界面：用 @ 把下一轮提问限定到某个公司知识库，回答下方列出实际检索到的出处，并在证据页里查看原文片段。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-knowledge

[English](README.md) | 中文

## 概述

三个界面，同一个网关：

- **`@` 触发源。** 输入 `@` 会列出当前登录用户可见的知识库，外加一行“全部知识库”；选中后插入一个原子引用，模型侧看到的是 `<knowledge-base>库名</knowledge-base>`。`weknora` skill 读这个库名，作为 `--kb` 传给检索脚本。
- **出处条。** 回答结束后，这一轮真正检索到的每个片段变成一个角标。点角标会用该轮的片段打开证据页，并高亮点击的那一条。
- **证据页。** 右栏的一个页面类型，既能自己检索同样的库，也能带着片段打开。

列表、检索和片段都来自网关而不是宿主服务：`GET /__vh/weknora/api/v1/knowledge-bases` 与 `POST /__vh/weknora/api/v1/knowledge-search` 带着页面自己的 cookie 会话，由网关附上用户的 VOS 令牌转发给 WeKnora。浏览器和 agent 都不接触知识库凭据，每个界面看到的都正好是这个人有权读的内容。

## 注册了什么

- **触发源** — `ctx.inputTriggers.registerSource(...)`，`trigger: '@'`、`name: 'knowledge'`、`order: 10`、`showGroupTitle: false`，分组标题取自 `knowledge` 命名空间，`codec` 把 `*` 或库名序列化成 `<knowledge-base>…</knowledge-base>`。
- **菜单行** — 始终有一行“全部知识库”，随后是名称包含输入内容的所有可见库。过滤是不区分大小写的子串匹配：用户按名称找，不按路径找。
- **轮次数据** — 一个 `knowledge` 会话定义，把本轮 `tool/result` 事件折叠进 `ConversationTurnDataMap`，所以出处条读的是会话已经记录的事实，而不是再查一次服务。
- **出处条** — 一个 `conversation.chat.turnTail` 条目；这一轮没有检索到片段时不渲染。
- **页面类型** — 在 `ctx.sidebarRightTabs` 注册 `evidence`，正文和标题分别注册进 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title`。
- **词条** — 把 `knowledge` 命名空间注册进 `ctx.locale`。

## 出处是怎么来的

只读 `weknora` skill 打印的两种 JSON：`search` 的 `citations` 数组，以及 `read` 的 `chunks` 数组连同它的 `knowledge` 头。每个片段 id 最多一个角标，按出现顺序排列，且只计入回答结束之前的结算。

不从正文里推断任何东西。模型提到一个它没检索到的片段，或工具输出里出现片段却没有 skill 的载荷，都不会产生角标——出处条告诉读者的是一次运行看到了什么，而不是它说了什么。

## 失败时怎么表现

网关列不出知识库时，菜单里只保留“全部知识库”一行。这是有意的：这次选择仍然表示“去问知识库服务”，真正的原因（服务未启动、令牌过期、没有分配库）由 `weknora` skill 如实报出，而不是让菜单去猜。

失败的列举不会被缓存，服务恢复后下一次敲键就能看到，不必刷新页面。证据页读不到库列表时在自己的状态行说明，并在此期间检索全部可见库；检索失败时用一行说明替换列表，而不是留一个空结果。

## 已知限制

- 列表在页面生命周期内缓存；别处新建的库需要刷新页面才出现。
- 选库只是声明范围。没有任何机制阻止模型去检索别处，`--kb` 仍然是建议性的。
- 出处条读的是 skill 打印的载荷。输出的 JSON 在结束前被截断的那次运行不会产生角标。
