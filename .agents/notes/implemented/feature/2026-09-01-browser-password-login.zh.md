# Agent Note: 可选的浏览器密码登录

Status: implemented

[English](2026-09-01-browser-password-login.md) | 中文

## Problem

Web 应用通过把进程启动令牌交换为绑定 authority 的 30 天 cookie 来认证浏览器。能读取启动 URL 的操作员可以完成该交换，但无人值守服务会刻意隐藏 URL，避免令牌进入 journal。即使部署已经通过凭据服务保存访问密码，从另一台设备打开服务的用户仍然没有常规登录路径。

## Decision

`dsh-client-connection` 接受可选的 `passwordLogin` 配置，其中包含一个用户名和一个凭据引用。Connection 激活时解析该引用，值缺失或为空时直接失败。只有该配置存在时才注册精确 `/login` route。它应用与 `/api` 相同的 Host、Origin 和 Fetch-Metadata 信任检查，因此表单登录不会授权未声明的 authority 或跨站浏览器请求。

登录页依据 `Accept-Language` 选择英文或中文文案，且不包含客户端脚本。`GET` 和 `HEAD` 提供页面，`POST` 只接受最多 8 KiB 的 `application/x-www-form-urlencoded` 请求体。用户名未知、密码错误、字段缺失、轮换后凭据不可用或 authority 无效时，失败尝试都返回同一个 401 响应。密码比较在长度相同时使用 `timingSafeEqual`。成功尝试签发现有的签名 authority-bound 浏览器 cookie，并重定向到 `/`；它不会创建另一种会话格式或凭据存储。

每次尝试都会重新解析密码引用，因此凭据轮换无需重载 Connection 即可生效。现有 cookie 在正常过期或全局签名密钥撤销前仍然有效。配置密码登录后，未认证的 `GET` 或 `HEAD` index 请求会重定向到 `/login`；进程启动令牌交换仍作为操作员恢复路径。[浏览器启动令牌认证决策](../architecture/2026-08-24-browser-token-authentication.zh.md)继续持有 cookie 内容、有效期、撤销方式和完整 Host API 授权。

## Alternatives considered

**要求操作员把每个进程启动令牌复制到每台设备。**不采用，因为无人值守服务会在日志中隐藏该凭据，且进程重启会替换它。密码路径在一次常规登录后保留现有的持久 cookie。

**只在反向代理中使用 HTTP Basic Authentication。**不作为产品机制，因为它会创建第二层浏览器凭据，且无法签发或复用 Host API cookie。部署仍可在应用 route 外增加 TLS、网络限制和尝试限流等代理控制。

**在 Connection 配置中存储密码哈希。**不采用，因为配置文件和生成的 dump 不是凭据存储，且轮换需要编辑 profile。凭据引用使值保留在部署现有的 secret 路径中，并且不进入 Cordis 配置。

**密码变更时使所有 cookie 失效。**不采用，因为密码用于认证新浏览器，签名密钥则用于认证已建立会话。操作员保留现有的全局撤销机制：删除 browser-session 凭据记录并重启进程。

## Consequences

无人值守或代理部署可以提供稳定的登录页，同时为完整 Host API 保留一种浏览器会话格式和一项授权检查。省略 `passwordLogin` 的部署保留启动令牌行为，且不注册 `/login`。

内置表单不提供 TLS、账号恢复、logout、多用户身份或尝试限流。网络部署必须限制可达范围；网络不可信时，必须用 TLS 保护明文密码与 cookie，并在反向代理上实施合适的请求速率控制。配置的用户名是页面可显示内容，不是 secret。

## Testing

Connection 测试覆盖可选 route 注册、凭据缺失与空值、英文与中文渲染、HEAD 行为、错误凭据、密码轮换与删除、已有 cookie 重定向、不支持的方法与媒体类型、声明长度与流式请求体两种上限、cookie 签发，以及未改变的启动令牌路径。真实 HTTP 测试继续通过 Node 服务器实现覆盖统一 Host API 认证。
