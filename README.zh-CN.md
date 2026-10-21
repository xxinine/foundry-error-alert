# Foundry 429 告警与飞书通知

[English](README.md) | 简体中文

为已有的 Microsoft Foundry 模型部署配置 Azure Monitor 告警，并向飞书群发送带签名的告警触发（Fired）和恢复（Resolved）通知。所有客户相关配置均从 `.env` 读取，无需修改源码，也无需安装 npm 依赖。

## 快速开始

1. 安装 Node.js 22.16 或更高版本（建议使用受支持的 LTS 版本），以及 Azure CLI。
2. 在飞书群中添加自定义机器人，开启签名校验，获取 Webhook 地址和签名密钥。
3. 准备配置文件：

   ```sh
   cp .env.example .env
   ```

   填写已有的订阅、资源组、Foundry 资源名称，以及 `MODEL` 对应的**模型部署名称**，再填写飞书 Webhook 和签名密钥。为当前模型和环境设置独立的 `RESOURCE_PREFIX`。不要将 `.env` 提交到仓库。

4. 登录并部署：

   ```sh
   az login
   node deploy.mjs
   ```

5. 可选：在不调用模型的情况下验证通知链路：

   ```sh
   node monitor.mjs notify-test Fired
   node monitor.mjs notify-test Resolved
   node monitor.mjs evidence
   ```

两条通知均会明确标注为模拟测试。测试成功表示飞书返回的业务码为 `0`，而不仅是 HTTP 200。

## 权限与适用范围

请使用包含 Foundry 资源及其模型部署的已有资源组。部署脚本不会创建资源组、创建模型、修改模型配额或注册资源提供程序。

为便于部署，可向执行部署的身份授予目标资源组的 Contributor 角色，以及订阅的 Reader 角色；后者用于检查 Integration Account 的区域配额。也可通过自定义最小权限角色，允许管理 ARM 部署、Logic Apps 工作流/映射/集成账户、Action Group 和指标告警，并允许读取必要的 Foundry 资源和指标。订阅必须已注册 `Microsoft.Logic` 和 `Microsoft.Insights` 资源提供程序。

工具使用 `AZURE_SUBSCRIPTION_ID` 显式选择认证订阅，不依赖 Azure CLI 的默认订阅。当前版本适用于 Azure 公有云，每份配置监控一个 Foundry 资源中的一个模型部署，通知目标为飞书 `open.feishu.cn` 自定义机器人。模型指标必须提供 `StatusCode` 和 `ModelDeploymentName` 维度；请先确认所选指标适用于实际部署类型。

## 配置说明

完整配置项见 [.env.example](.env.example)。支持 `=` 两侧的空格和带引号的值。配置文件按仓库所在目录读取，不依赖执行命令时的工作目录；操作系统环境变量不会覆盖文件中的配置。

| 配置项 | 必填 / 默认值 | 说明 |
| --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | 必填 | Azure 订阅 GUID |
| `AZURE_RESOURCE_GROUP` | 必填 | 包含 Foundry 资源的已有资源组 |
| `AZURE_LOCATION` | 必填 | Logic App 和 Integration Account 的区域代码，例如 `eastus2` |
| `FOUNDRY_ACCOUNT_NAME` | 必填 | 已有 Foundry / Azure OpenAI 资源名称 |
| `MODEL` | 必填 | 模型**部署名称**，不是模型目录中的模型 ID |
| `FEISHU_WEBHOOK_URL` | 必填 | 飞书自定义机器人 Webhook 地址 |
| `FEISHU_WEBHOOK_KEY` | 必填 | 机器人签名校验密钥 |
| `RESOURCE_PREFIX` | `foundry-alerts` | 自动生成 Azure 资源名的前缀；不同模型和环境应使用独立前缀 |
| `ACTION_GROUP_SHORT_NAME` | `foundry429` | Action Group 显示名称，最多 12 个字母、数字、下划线或连字符 |
| `INTEGRATION_ACCOUNT_SKU` | `Free` | 可选 `Free`、`Basic`、`Standard`；选择前确认费用与 SLA |
| `AZURE_METRIC_NAME` | `AzureOpenAIRequests` | 若适用于目标部署，也可选择 `ModelRequests` |
| `ALERT_WINDOW_MINUTES` | `5` | 统计窗口，可选 `1, 5, 15, 30, 60, 360, 720, 1440` 分钟 |
| `ALERT_FREQUENCY_MINUTES` | `1` | 评估频率，可选 `1, 5, 15, 30, 60` 分钟，且不能大于统计窗口 |
| `ALERT_THRESHOLD` | `0` | 窗口内 429 总数大于该整数时触发告警 |
| `ALERT_SEVERITY` | `2` | Azure 告警级别，从 `0`（严重）到 `4` |
| `DEPLOYMENT_TIMEOUT_SECONDS` | `600` | 客户端等待部署的超时时间；超时后 Azure 仍可能继续部署 |
| `ENDPOINT` | 根据资源名生成 | 可选的 HTTPS `/openai/v1` 端点，仅用于显式执行的模型测试 |
| `SCOPE` | `https://ai.azure.com/.default` | 模型测试使用的 Entra 认证范围，也支持 `https://cognitiveservices.azure.com/.default` |

可选的完整资源名覆盖项：`LOGIC_APP_NAME`、`INTEGRATION_ACCOUNT_NAME`、`ACTION_GROUP_NAME`、`ALERT_RULE_NAME`、`DEPLOYMENT_NAME`。更新已有安装时，可通过这些配置保留原资源名称。修改资源名会创建新资源，增量部署不会删除旧资源。修改模型名称或监控目标时，也需要检查并按需删除旧告警规则，避免重复通知。

默认生成的名称依次为 `${RESOURCE_PREFIX}-feishu`、`-integration`、`-action-group`、`-429` 和 `-deployment`。Integration Account 中的映射名称为 `FeishuSign`。若同一资源组、同一区域已有 Free Integration Account，可通过 `INTEGRATION_ACCOUNT_NAME` 指定其名称进行复用。当前脚本不支持跨资源组复用；遇到区域配额冲突时，应选择允许的区域，或在确认费用后显式使用适合的付费层级。

## 部署行为

`node deploy.mjs` 会校验配置，检查已有资源、模型及指标维度，检查 Integration Account 兼容性和 Free 层配额冲突，验证 ARM 模板，提交增量部署，并等待状态变为 `Succeeded`。失败或超时会返回非零退出码。脚本不会静默修改已有 Integration Account 的区域或 SKU。

脚本不会输出 Webhook 凭据、访问令牌或带签名的回调地址。配置不变时，重复部署会更新同一组资源；不会自动发送测试通知，也不会产生模型调用。请妥善保管部署机器上的 `.env` 和 Azure 登录凭据；部署完成后，云端工作流不依赖该机器持续在线。

## 架构与通知内容

Foundry 请求指标 → 有状态 Azure Monitor 指标告警 → Action Group → Consumption Logic App → 带签名的飞书机器人卡片。

告警按 `Total` 聚合，筛选 `StatusCode = 429` 和配置中的 `ModelDeploymentName`，使用指定窗口和频率进行评估，并启用自动恢复。持续异常期间只发送一次 Fired 通知，直至恢复；这不是逐请求通知服务。指标入库与告警处理存在延迟，因此每分钟评估不代表一分钟内必达的通知 SLA。

卡片将规则的**触发条件**、**实际评估计数**和**当前状态**分开显示。Resolved 消息使用专门的恢复说明，不再复制规则的静态描述。以下保留实际英文卡片格式，便于对照：

```text
Foundry 429 | Resolved
State: Resolved
Window: 5 minutes
Trigger condition: HTTP 429 count > 0
Evaluated 429 count: 0
Details: Recovered: Azure Monitor confirmed that the HTTP 429 count no longer exceeds the threshold.
```

“恢复”表示不再满足告警触发条件。如果配置了非零阈值，恢复不一定意味着错误数为零。计数来自告警载荷；缺失时显示 `Unavailable`，不会假设为零。时间优先使用 `firedDateTime` 或 `resolvedDateTime`，仅在缺失时使用投递时间。模拟通知会单独标注。

## 命令与测试

```sh
node --test monitor.test.mjs
node monitor.mjs check
node monitor.mjs validate
node deploy.mjs
node monitor.mjs status
node monitor.mjs notify-test Fired
node monitor.mjs notify-test Resolved
node monitor.mjs observe
node monitor.mjs runs
node monitor.mjs evidence
```

- 本地测试覆盖客户配置、默认值与覆盖值、非法配置、模板目标与阈值、凭据隔离和恢复文案。
- `check` 在本地检查配置和模板；`validate` 还执行 Azure 预检和 ARM 验证，但不部署。
- `status` 检查最近一次 ARM 部署；`observe` 只读查询近期真实 429 指标、告警状态和工作流运行记录，不产生模型请求。
- `evidence` 读取不含凭据的触发器字段及 Message 步骤渲染后的消息文本，不读取签名步骤或出站 HTTP 的输入/输出。
- Azure Alerts Management 列表结果可能短暂落后于实际 Resolved 通知；排查时可对照工作流触发器载荷。

可选模型测试，**必须显式执行**：

```sh
node monitor.mjs burst
```

该命令最多发送 3 次短 Responses API 请求，不使用 SDK 自动重试，遇到首个 429 或其他错误即停止。执行身份需要具备 Entra 模型推理权限，调用可能产生模型费用；不要对共享生产部署反复执行。如果模型配额较高，测试不一定能产生 429。部署命令不会自动运行此测试。

完整端到端验收需要真实 Fired 告警及其对应的成功工作流运行，随后还需要真实 Resolved 告警和成功的恢复通知。模拟测试本身不能验证指标告警链路。初始部署已通过完整真实链路测试；客户可配置版本也已通过模拟 Fired/Resolved 投递及云端恢复文案验证。

## 费用与生产使用限制

**默认 Free Integration Account 仅用于探索和测试，没有 SLA，每个订阅的每个区域最多一个。** 提供客户部署脚本并不会消除这一限制。生产发布前，需要明确选择适合的 Integration Account 层级，或调整签名计算的承载方式。Basic/Standard 层级存在固定费用，部署前请查看 [Logic Apps 定价](https://azure.microsoft.com/pricing/details/logic-apps/)。指标告警和 Consumption 工作流执行也可能产生费用。

XSLT 映射通过受支持的 C# 脚本扩展调用 .NET `HMACSHA256`，没有自行实现加密算法，也没有依赖外部签名服务。Consumption 内联 JavaScript 不能加载 Node 模块，且代码长度限制为 1,024 字符，因此本方案不使用它计算签名。

凭据通过 ARM `securestring` 和 Logic Apps 安全参数传递，映射文件本身不包含密钥。签名和出站 HTTP 步骤的输入/输出在运行历史中隐藏；独立的 Message 步骤保留不含凭据的告警文本用于排查。请保护 Azure 管理权限以及 Request 触发器带签名的回调地址。生产环境建议结合 Key Vault 和最小权限角色分配治理密钥。

HTTP 临时故障使用有上限的指数退避重试。飞书返回非零业务码时，工作流会返回 HTTP 503 并标记失败。Action Group 的投递重试次数有限；当前实现没有持久化死信队列、恰好一次投递保证或跨运行去重。若飞书已成功接收但响应超时，可能产生重复通知。关键值班告警需要补充持久化投递机制和独立的通知服务健康告警。

若飞书机器人同时启用了关键词或 IP 限制，也需要确保消息文本和 Logic Apps 出站地址符合这些限制。

## 停用或清理

在 Azure Monitor 中禁用配置对应的告警规则，可停止新的告警通知。清理安装时，删除对应的指标告警、Action Group 和 Logic App。只有当 Integration Account 专用于本安装时才删除它，因为其中可能包含共享映射或被其他工作流使用。仅删除 ARM 部署记录不会删除已部署资源。不要删除 Foundry 资源、模型或共享资源组。

## 参考资料

- [模型指标](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics)
- [告警状态](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-overview#alerts-and-state)
- [Action Groups](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups)
- [Logic Apps 映射与 C# 扩展](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-enterprise-integration-maps)
- [XML 转换](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-enterprise-integration-transform)
- [飞书自定义机器人与签名校验](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)