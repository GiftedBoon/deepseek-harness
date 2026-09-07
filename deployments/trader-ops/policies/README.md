# Policies：权限、审批与 Tool Guard

本目录保存 Agent 执行层的治理规则。Policy 根据主体、环境、工具、资源和风险级别做出 `allow`、`require_approval` 或 `deny` 决策，并应在 Tool 调用前由 Hook/Tool Guard 强制执行。

## 应该放在这里

- 角色或服务身份可调用的 Tool 范围。
- readonly、safe-action、dangerous-action 等风险等级定义。
- 生产操作所需审批角色、审批有效期和职责分离规则。
- Tool 参数约束、环境限制、审计字段和默认拒绝规则。

## 不应该放在这里

- API key、密码、私钥或审批令牌。
- Skill 的任务步骤或业务知识正文。
- 仅写给模型看的软性提示；关键规则必须由代码执行。
- 允许任意 shell、任意 SQL 或通配生产写权限的宽泛规则。

## 建议文件划分

```text
policies/
├── risk-levels.yaml
├── tool-access.yaml
└── approvals.yaml
```

## 风险与 Tool Guard 示例

```yaml
version: 1
default: deny

risk_levels:
  readonly:
    approval: none
  safe-action:
    approval: none
    audit: required
  dangerous-action:
    approval: required
    audit: required

tools:
  get_product:
    risk: readonly
    environments: [dev, staging, production]
  get_product_strategy:
    risk: readonly
    environments: [dev, staging, production]
  switch_product_strategy:
    risk: dangerous-action
    environments: [production]
    allowed_roles: [trading-operator]
    approval:
      approver_roles: [trading-duty-manager]
      expires_in: 15m
      requester_cannot_approve: true
    argument_guards:
      require: [product, target_strategy, environment]
      environment_equals: production
```

Tool Guard 应在执行前使用经过认证的调用者身份和服务端审批记录重新计算决策。Skill 声称“已审批”、用户在对话中说“我同意”，或知识库中出现授权文字，都不能代替有效审批。

建议审计记录至少包含：`request_id`、`session_id`、`actor`、`tool`、脱敏参数、`risk_level`、Policy 版本、审批记录、执行结果和时间戳。
