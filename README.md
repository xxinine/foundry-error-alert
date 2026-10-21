# Foundry 429 Alerts to Feishu

[English](README.md) | [Chinese (Simplified)](README.zh-CN.md)

Deploy Azure Monitor alerts for an existing Microsoft Foundry model deployment and send signed Fired/Resolved notifications to a Feishu group. All customer-specific values come from `.env`; no source edits or npm dependencies are required.

## Quick Start

1. Install Node.js 22.16+ (prefer a supported LTS) and Azure CLI.
2. Create a Feishu group custom bot, enable signature verification, and obtain its webhook URL and signing secret.
3. Prepare your configuration:

	```sh
	cp .env.example .env
	```

	Fill in the existing subscription, resource group, Foundry account and **deployment name** in `MODEL`, plus the two Feishu credentials. Choose a unique `RESOURCE_PREFIX` for this model/environment. Never commit `.env`.

4. Sign in and deploy:

	```sh
	az login
	node deploy.mjs
	```

5. Optionally verify the notification path without making model calls:

	```sh
	node monitor.mjs notify-test Fired
	node monitor.mjs notify-test Resolved
	node monitor.mjs evidence
	```

Both notifications are explicitly labeled synthetic. A successful test means Feishu returned business code zero, not just HTTP 200.

## Permissions and Scope

Use an existing resource group containing the Foundry account and model deployment. The deployment script does not create a resource group, create a model, change quotas, or register resource providers.

For straightforward setup, grant the deploying identity Contributor on the target resource group and Reader on the subscription (the latter is used to check Integration Account region quotas). A custom least-privilege role can instead allow deployments, Logic Apps workflows/maps/integration accounts, Action Groups, metric alerts, and the necessary Foundry/metric reads. `Microsoft.Logic` and `Microsoft.Insights` must already be registered in the subscription.

The tool explicitly selects `AZURE_SUBSCRIPTION_ID` for authentication; it does not depend on the CLI default subscription. This version supports public Azure, one Foundry account and one deployment per configuration, and Feishu `open.feishu.cn` custom bots. Model metrics must expose `StatusCode` and `ModelDeploymentName`. Verify which metric covers your deployment type.

## Configuration

See [.env.example](.env.example) for all supported settings. Spaces around `=` and quoted values are supported. The file is loaded relative to the repository, not the working directory. OS environment variables do not override it.

| Setting | Required / Default | Meaning |
| --- | --- | --- |
| `AZURE_SUBSCRIPTION_ID` | Required | Subscription GUID |
| `AZURE_RESOURCE_GROUP` | Required | Existing resource group containing Foundry |
| `AZURE_LOCATION` | Required | Region code for Logic App and Integration Account, e.g. `eastus2` |
| `FOUNDRY_ACCOUNT_NAME` | Required | Existing Azure Foundry / Azure OpenAI account name |
| `MODEL` | Required | Model **deployment name**, not catalog model ID |
| `FEISHU_WEBHOOK_URL` | Required | Feishu custom bot webhook |
| `FEISHU_WEBHOOK_KEY` | Required | Bot signature-verification secret |
| `RESOURCE_PREFIX` | `foundry-alerts` | Prefix for generated Azure resource names; use a distinct prefix per model/environment |
| `ACTION_GROUP_SHORT_NAME` | `foundry429` | Display name, at most 12 letters/digits/underscores/hyphens |
| `INTEGRATION_ACCOUNT_SKU` | `Free` | `Free`, `Basic`, or `Standard`; review cost and SLA before choosing |
| `AZURE_METRIC_NAME` | `AzureOpenAIRequests` | Can also use `ModelRequests` if applicable to the deployment |
| `ALERT_WINDOW_MINUTES` | `5` | One of `1, 5, 15, 30, 60, 360, 720, 1440` |
| `ALERT_FREQUENCY_MINUTES` | `1` | One of `1, 5, 15, 30, 60`; no greater than the window |
| `ALERT_THRESHOLD` | `0` | Trigger when the window's 429 count is greater than this integer |
| `ALERT_SEVERITY` | `2` | Azure severity `0` (critical) to `4` |
| `DEPLOYMENT_TIMEOUT_SECONDS` | `600` | Client wait limit; Azure can continue deploying after this expires |
| `ENDPOINT` | Derived from account | Optional HTTPS `/openai/v1` endpoint, used only by the explicit model test |
| `SCOPE` | `https://ai.azure.com/.default` | Model-test Entra scope; `https://cognitiveservices.azure.com/.default` also supported |

Optional exact-name overrides: `LOGIC_APP_NAME`, `INTEGRATION_ACCOUNT_NAME`, `ACTION_GROUP_NAME`, `ALERT_RULE_NAME`, `DEPLOYMENT_NAME`. Set these when updating an existing installation to keep its resource names unchanged. Changing names creates new resources; incremental deployment does not remove the old ones. Renaming or retargeting a model also requires checking/removing old alert rules to avoid duplicate notifications.

Generated names are `${RESOURCE_PREFIX}-feishu`, `-integration`, `-action-group`, `-429`, and `-deployment`. The Integration Account map is named `FeishuSign`. If a Free Integration Account already exists in the same resource group/region, set `INTEGRATION_ACCOUNT_NAME` to reuse it. Reuse in a different resource group is not supported by this deployment script; choose a permitted region or explicitly provision a suitable paid tier after reviewing cost.

## Deployment Behavior

`node deploy.mjs` performs configuration validation, verifies the existing account/model and metric dimensions, checks Integration Account compatibility/Free-tier conflicts, validates the ARM template, submits an incremental deployment, and waits for `Succeeded`. Failure or timeout returns a nonzero exit code. It refuses to silently change an existing Integration Account's region or SKU.

The script never prints webhook credentials, access tokens or signed callback URLs. Re-running it with unchanged configuration updates the same resources. It does not automatically send test notifications or generate model traffic. Keep `.env` and Azure login credentials only on the deploying machine; the running workflow does not depend on that machine remaining online.

## Architecture and Messages

Foundry request metric -> stateful Azure Monitor metric alert -> Action Group -> Consumption Logic App -> signed Feishu bot card.

The alert uses `Total`, filters `StatusCode = 429` and the configured `ModelDeploymentName`, evaluates the configured window/frequency, and enables automatic mitigation. Persistent errors produce one Fired notification until recovery; it is not a per-request notification service. Platform ingestion and alert processing introduce delay, so a one-minute evaluation interval is not a one-minute notification SLA.

Each card separates the rule's **trigger condition** from the **evaluated count** and **current state**. Resolved messages use recovery-specific details instead of copying the rule's static description:

```text
Foundry 429 | Resolved
State: Resolved
Window: 5 minutes
Trigger condition: HTTP 429 count > 0
Evaluated 429 count: 0
Details: Recovered: Azure Monitor confirmed that the HTTP 429 count no longer exceeds the threshold.
```

Recovery means the rule is no longer breached, not necessarily zero errors when a nonzero threshold is configured. Counts come from the alert payload; missing counts display `Unavailable`, not a fabricated zero. Time uses `firedDateTime` or `resolvedDateTime`, falling back to delivery time only when unavailable. Synthetic notifications are labeled separately.

## Commands and Tests

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

- Local tests cover customer configuration, defaults/overrides, invalid settings, template targets/thresholds, credential isolation and recovery wording.
- `check` validates configuration and template locally; `validate` adds Azure preflight/ARM validation without deployment.
- `status` checks the last ARM deployment; `observe` reads recent real 429 metrics, alert state and workflow runs without generating traffic.
- `evidence` reads nonsecret trigger fields and the rendered Message action output. It never reads signing-step or outbound HTTP inputs/outputs.
- Azure Alerts Management list results can briefly lag the actual Resolved notification. Compare workflow trigger evidence when troubleshooting.

Optional, **explicitly opt-in** model test:

```sh
node monitor.mjs burst
```

This sends at most three small Responses API calls without SDK retries and stops on the first 429 or other error. It requires Entra model-inference permissions, may incur model charges, and must not be repeatedly run against a shared production deployment. It may not generate 429 if the deployment's quota is high. The deployment command never invokes it.

End-to-end acceptance requires an actual Fired alert, a successful matching workflow run, then an actual Resolved alert and successful recovery notification. Synthetic tests alone do not validate the metric route. The original deployment passed that full route; the updated customer-configurable deployment also passed Fired/Resolved synthetic delivery and cloud-rendered recovery-text verification.

## Cost and Production Readiness

**The default Free Integration Account is exploratory/test-only, has no SLA, and is limited to one per subscription/region.** Packaging for customers does not remove this limitation. Before production release, explicitly choose an appropriate Integration Account tier or redesign signing hosting. Basic/Standard tiers have fixed charges; review [Logic Apps pricing](https://azure.microsoft.com/pricing/details/logic-apps/) before deployment. Metric alerts and Consumption workflow executions may also incur charges.

The XSLT map calls .NET `HMACSHA256` through the supported C# script extension. There is no hand-written cryptography or external signing service. Consumption JavaScript cannot load Node modules and has a 1,024-character code limit, so it is not used for signing.

Credentials use ARM `securestring` and Logic Apps secure parameters; the map contains no secret. Signing and outbound HTTP inputs/outputs are hidden in run history. The separate Message step retains nonsecret alert text for diagnosis. Protect Azure management permissions and the request trigger's signed callback URL. Use Key Vault integration and least-privilege role assignments for production secret governance.

HTTP transient failures receive bounded exponential retries. A nonzero Feishu business code produces HTTP 503 and a failed run. Action Group delivery is finite; there is no durable dead-letter queue, exactly-once guarantee, or cross-run deduplication. A timeout after successful delivery may produce duplicates. Critical paging needs durable delivery and independent notifier-health alerts.

If the bot also has keyword/IP restrictions, those must permit the generated text and Logic Apps outbound addresses.

## Disable or Remove

Disable the configured alert rule in Azure Monitor to stop new notifications. To remove an installation, delete its metric alert, Action Group and Logic App. Delete the Integration Account only if it is dedicated to this installation; it may contain shared maps or support other workflows. Deleting the ARM deployment record alone does not remove resources. Do not delete the Foundry account, model or shared resource group.

## References

- [Model metrics](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/supported-metrics/microsoft-cognitiveservices-accounts-metrics)
- [Alert states](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/alerts-overview#alerts-and-state)
- [Action Groups](https://learn.microsoft.com/en-us/azure/azure-monitor/alerts/action-groups)
- [Logic Apps maps and C# extensions](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-enterprise-integration-maps)
- [Transform XML](https://learn.microsoft.com/en-us/azure/logic-apps/logic-apps-enterprise-integration-transform)
- [Feishu custom bot signatures](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)