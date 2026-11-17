---
kind: upgrade-guide
description: "v-harness on VOS removes the DS Bot bundle and settings."
---

# DS Bot removal in v-harness on VOS

English | [中文](guide.zh.md)

## Change

The VOS Web profile now opens in the Agent workspace. The DS Bot plugin and its settings are removed at tenant startup. Existing DS Bot data stays in the tenant home.

## Migration

1. Open v-harness after upgrading the VOS app. Check the Plugins page for the updated bundle list.
2. Open Settings → Models to refresh the V-Scheduler catalog or select a default model.
