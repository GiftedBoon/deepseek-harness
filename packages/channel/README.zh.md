---
description: "驱动普通 DSH Session 的双向企业消息渠道包映射。"
kind: "package-group"
---

# channel/ — 企业消息渠道

[English](README.md) | 中文

## 概述

Channel 系列把经过身份验证的企业消息传输连接到普通 Workspace Session。渠道负责提供方交付准入、会话身份、结果投影和传输生命周期，同时复用 Agent、Session、权限、preset 与持久化层。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 角色 | ctx key |
|---|---|---|
| [`channel-wecom/`](channel-wecom/README.zh.md) | 企业微信智能机器人长连接、持久会话路由与流式回复 | 函数插件；无 service key |

<a id="related-documentation"></a>
## 相关文档

渠道是协议驱动器，而不是模型工具。它们激活普通 Agent，并且只把已关联的可见 assistant 文本投影回提供方。

<a id="dev-note"></a>
## 开发备注

无。
