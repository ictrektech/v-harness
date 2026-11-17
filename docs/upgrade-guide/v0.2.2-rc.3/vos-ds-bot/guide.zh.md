---
kind: upgrade-guide
description: "VOS 上的 v-harness 移除 DS Bot 插件包及其设置。"
---

# VOS v-harness 移除 DS Bot

[English](guide.md) | 中文

## 变更

VOS Web profile 现在直接打开 Agent 工作台。租户实例启动时会移除 DS Bot 插件及其设置入口，原有 DS Bot 数据保留在租户主目录。

## 迁移

1. 在 VOS 应用升级后打开 v-harness，在「插件」页查看更新后的插件列表。
2. 打开「设置 → 模型」，刷新 V-Scheduler 模型目录或选择默认模型。
