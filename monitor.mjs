import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { readConfiguration } from './config.mjs';

let config;
const secureData = { secureData: { properties: ['inputs', 'outputs'] } };

export function redact(value) {
  let result = String(value);
  for (const secret of [config?.feishuUrl, config?.feishuKey]) {
    if (secret) result = result.replaceAll(secret, '<redacted>');
  }
  return result.replace(/([?&]sig=)[^&\s"']+/g, '$1<redacted>');
}

function az(args) {
  try {
    return JSON.parse(execFileSync('az', [...args, '--only-show-errors', '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(redact(error.stderr || error.message));
  }
}

function token(resource = 'https://management.azure.com/') {
  return az(['account', 'get-access-token', '--subscription', config.subscription, '--resource', resource]).accessToken;
}

async function management(path, method = 'GET', body) {
  const response = await fetch(`https://management.azure.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error(redact(`ARM HTTP ${response.status}: ${text}`)), { status: response.status });
  return text ? JSON.parse(text) : {};
}

export function notificationContent(settings) {
  return `@concat('**Resource:** ${settings.account}\n**Deployment:** ${settings.model}\n**Rule:** ', triggerBody()?['data']?['essentials']?['alertRule'], '\n**State:** ', triggerBody()?['data']?['essentials']?['monitorCondition'], '\n**Window:** ${settings.windowMinutes} minutes\n**Trigger condition:** HTTP 429 count > ${settings.threshold}\n**Evaluated 429 count:** ', string(coalesce(triggerBody()?['data']?['alertContext']?['condition']?['allOf']?[0]?['metricValue'], 'Unavailable')), '\n**Time (UTC):** ', if(equals(triggerBody()?['data']?['essentials']?['monitorCondition'], 'Resolved'), coalesce(triggerBody()?['data']?['essentials']?['resolvedDateTime'], utcNow()), coalesce(triggerBody()?['data']?['essentials']?['firedDateTime'], utcNow())), '\n**Details:** ', if(equals(triggerBody()?['data']?['essentials']?['monitorCondition'], 'Resolved'), 'Recovered: Azure Monitor confirmed that the HTTP 429 count no longer exceeds the threshold.', 'Alerting: the HTTP 429 count exceeded the configured threshold.'), if(equals(triggerBody()?['data']?['customProperties']?['test'], true), '\n**Test:** Synthetic notification only; no model request was made.', ''), '\n[Open Azure Monitor](https://portal.azure.com/#view/Microsoft_Azure_Monitoring/AzureMonitoringBrowseBlade/~/alerts)')`;
}

export function template(settings) {
  const {
    account, model, location, accountId,
    workflowName, integrationName, actionGroupName, actionGroupShortName, alertName,
    integrationSku, metricName, windowMinutes, frequencyMinutes, threshold, severity,
  } = settings;
  const integrationId = `[resourceId('Microsoft.Logic/integrationAccounts', '${integrationName}')]`;
  const workflowRef = `[resourceId('Microsoft.Logic/workflows', '${workflowName}')]`;
  const actionGroupId = `[resourceId('Microsoft.Insights/actionGroups', '${actionGroupName}')]`;
  const mapId = `[resourceId('Microsoft.Logic/integrationAccounts/maps', '${integrationName}', 'FeishuSign')]`;
  const after = (name) => ({ [name]: ['Succeeded'] });
  return {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    contentVersion: '1.0.0.0',
    parameters: {
      feishuUrl: { type: 'securestring' },
      feishuKey: { type: 'securestring' },
    },
    resources: [
      {
        type: 'Microsoft.Logic/integrationAccounts', apiVersion: '2019-05-01',
        name: integrationName, location, sku: { name: integrationSku }, properties: {},
        tags: { purpose: 'foundry-429-alerts' },
      },
      {
        type: 'Microsoft.Logic/integrationAccounts/maps', apiVersion: '2019-05-01',
        name: `${integrationName}/FeishuSign`, dependsOn: [integrationId],
        properties: {
          mapType: 'Xslt', contentType: 'application/xml',
          content: readFileSync(new URL('feishu-sign.xslt', import.meta.url), 'utf8'),
        },
      },
      {
        type: 'Microsoft.Logic/workflows', apiVersion: '2019-05-01',
        name: workflowName, location, dependsOn: [mapId],
        tags: { purpose: 'foundry-429-alerts' },
        properties: {
          state: 'Enabled', integrationAccount: { id: integrationId },
          parameters: {
            feishuUrl: { value: "[parameters('feishuUrl')]" },
            feishuKey: { value: "[parameters('feishuKey')]" },
          },
          definition: {
            $schema: 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#',
            contentVersion: '1.0.0.0',
            parameters: { feishuUrl: { type: 'SecureString' }, feishuKey: { type: 'SecureString' } },
            triggers: {
              manual: {
                type: 'Request', kind: 'Http',
                inputs: {
                  method: 'POST',
                  schema: {
                    type: 'object', required: ['data'],
                    properties: {
                      data: {
                        type: 'object', required: ['essentials'],
                        properties: {
                          essentials: {
                            type: 'object', required: ['alertRule', 'monitorCondition'],
                            properties: {
                              alertRule: { type: 'string' },
                              monitorCondition: { type: 'string', enum: ['Fired', 'Resolved'] },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            actions: {
              Timestamp: {
                type: 'Compose', inputs: "@string(div(sub(ticks(utcNow()), ticks('1970-01-01T00:00:00Z')), 10000000))",
                runAfter: {},
              },
              Sign: {
                type: 'Xslt',
                inputs: {
                  content: "@xml(json(concat('{\"request\":{\"timestamp\":\"', outputs('Timestamp'), '\",\"secretBase64\":\"', base64(parameters('feishuKey')), '\"}}')))",
                  integrationAccount: { map: { name: 'FeishuSign' } },
                  transformOptions: 'disableByteOrderMark',
                },
                runAfter: after('Timestamp'), runtimeConfiguration: secureData,
              },
              Message: {
                type: 'Compose', inputs: notificationContent(settings), runAfter: after('Sign'),
              },
              Send_Feishu: {
                type: 'Http',
                inputs: {
                  method: 'POST', uri: "@parameters('feishuUrl')",
                  headers: { 'Content-Type': 'application/json' },
                  retryPolicy: { type: 'exponential', count: 3, interval: 'PT5S', maximumInterval: 'PT20S' },
                  body: {
                    timestamp: "@outputs('Timestamp')",
                    sign: "@xpath(xml(body('Sign')), 'string(/signature)')",
                    msg_type: 'interactive',
                    card: {
                      header: {
                        template: "@if(equals(triggerBody()?['data']?['essentials']?['monitorCondition'], 'Resolved'), 'green', 'red')",
                        title: { tag: 'plain_text', content: "@concat('Foundry 429 | ', triggerBody()?['data']?['essentials']?['monitorCondition'])" },
                      },
                      elements: [{
                        tag: 'div', text: {
                          tag: 'lark_md',
                          content: "@outputs('Message')",
                        },
                      }],
                    },
                  },
                },
                runAfter: after('Message'), runtimeConfiguration: secureData,
              },
              Check_Delivery: {
                type: 'If', expression: "@equals(body('Send_Feishu')?['code'], 0)",
                actions: {
                  Delivered: { type: 'Response', kind: 'Http', inputs: { statusCode: 200, body: { delivered: true } }, runAfter: {} },
                },
                else: {
                  actions: {
                    Delivery_Failed: { type: 'Response', kind: 'Http', inputs: { statusCode: 503, body: { delivered: false } }, runAfter: {} },
                    Mark_Failed: {
                      type: 'Terminate', inputs: { runStatus: 'Failed', runError: { code: 'FeishuRejected', message: 'Feishu returned a nonzero business status. Check bot configuration.' } },
                      runAfter: after('Delivery_Failed'),
                    },
                  },
                },
                runAfter: after('Send_Feishu'),
              },
              Transport_Failed: {
                type: 'Response', kind: 'Http', inputs: { statusCode: 503, body: { delivered: false } },
                runAfter: { Send_Feishu: ['Failed', 'TimedOut'] },
              },
            },
            outputs: {},
          },
        },
      },
      {
        type: 'Microsoft.Insights/actionGroups', apiVersion: '2023-01-01',
        name: actionGroupName, location: 'Global', dependsOn: [workflowRef],
        properties: {
          groupShortName: actionGroupShortName, enabled: true,
          logicAppReceivers: [{
            name: 'Feishu', resourceId: workflowRef, useCommonAlertSchema: true,
            callbackUrl: `[listCallbackUrl(resourceId('Microsoft.Logic/workflows/triggers', '${workflowName}', 'manual'), '2016-06-01').value]`,
          }],
        },
      },
      {
        type: 'Microsoft.Insights/metricAlerts', apiVersion: '2018-03-01',
        name: alertName, location: 'global', dependsOn: [actionGroupId],
        properties: {
          description: `Monitor HTTP 429 on ${account}/${model}; window ${windowMinutes} minutes, threshold ${threshold}.`,
          severity, enabled: true, scopes: [accountId],
          evaluationFrequency: `PT${frequencyMinutes}M`, windowSize: `PT${windowMinutes}M`, autoMitigate: true,
          criteria: {
            'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria',
            allOf: [{
              name: 'Http429', metricName, metricNamespace: 'Microsoft.CognitiveServices/accounts',
              operator: 'GreaterThan', threshold, timeAggregation: 'Total', criterionType: 'StaticThresholdCriterion',
              dimensions: [
                { name: 'StatusCode', operator: 'Include', values: ['429'] },
                { name: 'ModelDeploymentName', operator: 'Include', values: [model] },
              ],
            }],
          },
          actions: [{ actionGroupId }],
        },
      },
    ],
  };
}

function parameters() {
  return { feishuUrl: { value: config.feishuUrl }, feishuKey: { value: config.feishuKey } };
}

async function preflight() {
  const account = await management(`${config.accountId}?api-version=2024-10-01`);
  if (account.properties.provisioningState !== 'Succeeded') throw new Error('Foundry account is not ready.');
  const deployment = await management(`${config.accountId}/deployments/${config.model}?api-version=2024-10-01`);
  if (deployment.properties.provisioningState !== 'Succeeded') throw new Error('Model deployment is not ready.');
  const definitions = await management(`${config.accountId}/providers/Microsoft.Insights/metricDefinitions?api-version=2018-01-01`);
  const metric = definitions.value.find((entry) => entry.name.value === config.metricName);
  if (!metric || !['StatusCode', 'ModelDeploymentName'].every((name) => metric.dimensions.some((dimension) => dimension.value === name))) {
    throw new Error('Configured metric is unavailable or lacks StatusCode/ModelDeploymentName dimensions.');
  }
  const integrations = await management(`/subscriptions/${config.subscription}/providers/Microsoft.Logic/integrationAccounts?api-version=2019-05-01`);
  const existing = integrations.value.find((entry) => entry.id.toLowerCase() === `${config.prefix}/providers/Microsoft.Logic/integrationAccounts/${config.integrationName}`.toLowerCase());
  if (existing && (existing.location.toLowerCase() !== config.location || existing.sku.name !== config.integrationSku)) {
    throw new Error('Existing Integration Account region/SKU differs from .env; refusing to move or change its pricing tier.');
  }
  if (config.integrationSku === 'Free' && integrations.value.some((entry) => entry.location.toLowerCase() === config.location && entry.sku.name === 'Free' && entry.id !== existing?.id)) {
    throw new Error('A Free Integration Account already exists in this region. Set INTEGRATION_ACCOUNT_NAME and AZURE_RESOURCE_GROUP to reuse it, or explicitly select a paid SKU after reviewing costs.');
  }
  console.log('Preflight passed: existing account, model and metric verified; model quota will not be changed.');
  console.log(config.integrationSku === 'Free' ? 'Integration Account: Free, test-only and no SLA.' : `Integration Account: ${config.integrationSku}; fixed charges apply.`);
}

async function waitForDeployment(path) {
  const deadline = Date.now() + config.deploymentTimeout * 1000;
  while (Date.now() < deadline) {
    const deployment = await management(`${path}?api-version=2022-09-01`);
    const state = deployment.properties.provisioningState;
    console.log(`Deployment: ${state}`);
    if (state === 'Succeeded') return;
    if (['Failed', 'Canceled'].includes(state)) throw new Error(redact(JSON.stringify(deployment.properties.error || { state })));
    await new Promise((complete) => setTimeout(complete, 10000));
  }
  throw new Error('Deployment wait timed out; Azure may still be deploying. Run node monitor.mjs status before retrying.');
}

export async function run(command, argument) {
  config = readConfiguration();
  const { subscription, prefix, accountId, model, workflowId, alertName, deploymentName, metricName } = config;
  if (command === 'check') {
    const definition = template(config);
    assert.equal(definition.resources.length, 5);
    assert.equal(definition.parameters.feishuKey.type, 'securestring');
    assert.equal(definition.resources.at(-1).properties.criteria.allOf[0].dimensions[1].values[0], model);
    const serialized = JSON.stringify(definition);
    assert.ok(!serialized.includes(config.feishuKey));
    assert.ok(!serialized.includes(config.feishuUrl));
    parameters();
    console.log('Template checks passed; credentials stay out of the template.');
  } else if (command === 'validate' || command === 'deploy') {
    await preflight();
    const body = { properties: { mode: 'Incremental', template: template(config), parameters: parameters() } };
    const deploymentPath = `${prefix}/providers/Microsoft.Resources/deployments/${deploymentName}`;
    await management(`${deploymentPath}/validate?api-version=2022-09-01`, 'POST', body);
    console.log('ARM validation accepted.');
    if (command === 'deploy') {
      await management(`${deploymentPath}?api-version=2022-09-01`, 'PUT', body);
      await waitForDeployment(deploymentPath);
      console.log(`Ready: ${config.workflowName} -> ${alertName}. No test notifications or model requests were sent.`);
    }
  } else if (command === 'status') {
    const deployment = await management(`${prefix}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=2022-09-01`);
    console.log(JSON.stringify({ state: deployment.properties.provisioningState, error: deployment.properties.error }, null, 2));
  } else if (command === 'notify-test') {
    const state = argument || 'Fired';
    if (!['Fired', 'Resolved'].includes(state)) throw new Error('notify-test state must be Fired or Resolved.');
    const callback = await management(`${workflowId}/triggers/manual/listCallbackUrl?api-version=2016-06-01`, 'POST');
    const payload = {
      schemaId: 'azureMonitorCommonAlertSchema',
      data: {
        essentials: {
          alertRule: `${alertName}-notification-test`, monitorCondition: state,
          description: 'TEST ONLY: signed Logic Apps notification; not a real model error.',
        },
        alertContext: { condition: { allOf: [{ metricValue: state === 'Resolved' ? config.threshold : config.threshold + 1 }] } },
        customProperties: { test: true },
      },
    };
    const response = await fetch(callback.value, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(120000),
    });
    console.log(`Logic App test HTTP ${response.status}`);
    if (response.status !== 200) throw new Error('Notification test did not confirm delivery; inspect run status.');
    const result = await response.json();
    assert.equal(result.delivered, true);
    console.log('Feishu accepted the signed notification (business code 0).');
  } else if (command === 'runs') {
    const result = await management(`${workflowId}/runs?api-version=2016-06-01&$top=5`);
    console.log(JSON.stringify(result.value.map((run) => ({
      name: run.name, status: run.properties.status, start: run.properties.startTime,
      error: run.properties.error,
    })), null, 2));
  } else if (command === 'observe') {
    const query = new URLSearchParams({
      'api-version': '2018-01-01', metricnames: metricName,
      timespan: `${new Date(Date.now() - 30 * 60000).toISOString()}/${new Date().toISOString()}`,
      interval: 'PT1M', aggregation: 'Total',
      '$filter': `ModelDeploymentName eq '${model}' and StatusCode eq '429'`,
    });
    const metrics = await management(`${accountId}/providers/Microsoft.Insights/metrics?${query}`);
    const alerts = await management(`/subscriptions/${subscription}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-03-01&timeRange=1h&targetResource=${encodeURIComponent(accountId)}`);
    const runs = await management(`${workflowId}/runs?api-version=2016-06-01&$top=10`);
    const rule = await management(`${prefix}/providers/Microsoft.Insights/metricAlerts/${alertName}?api-version=2018-03-01`);
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(), ruleEnabled: rule.properties.enabled,
      metric429: metrics.value.flatMap((metric) => metric.timeseries.flatMap((series) => series.data.filter((point) => point.total > 0))),
      alerts: alerts.value.filter((alert) => alert.properties.essentials.alertRule.toLowerCase().endsWith(`/${alertName}`) || alert.properties.essentials.alertRule === alertName).map((alert) => ({
        name: alert.name, ...alert.properties.essentials,
      })),
      runs: runs.value.map((run) => ({ name: run.name, status: run.properties.status, start: run.properties.startTime })),
    }, null, 2));
  } else if (command === 'evidence') {
    const result = await management(`${workflowId}/runs?api-version=2016-06-01&$top=5`);
    for (const run of result.value) {
      const link = run.properties.trigger?.outputsLink?.uri;
      if (!link) continue;
      const response = await fetch(link, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`Cannot read trigger evidence: HTTP ${response.status}`);
      const output = await response.json();
      const essentials = output.body?.data?.essentials;
      const context = output.body?.data?.alertContext;
      const actions = await management(`${workflowId}/runs/${run.name}/actions?api-version=2016-06-01`);
      const messageLink = actions.value.find((action) => action.name === 'Message')?.properties.outputsLink?.uri;
      let message;
      if (messageLink) {
        const messageResponse = await fetch(messageLink, { signal: AbortSignal.timeout(30000) });
        if (!messageResponse.ok) throw new Error(`Cannot read message evidence: HTTP ${messageResponse.status}`);
        message = await messageResponse.json();
      }
      console.log(JSON.stringify({
        run: run.name, status: run.properties.status, start: run.properties.startTime,
        rule: essentials?.alertRule, condition: essentials?.monitorCondition,
        firedAt: essentials?.firedDateTime, resolvedAt: essentials?.resolvedDateTime,
        evaluatedMetrics: context?.condition?.allOf,
        message,
      }, null, 2));
    }
  } else if (command === 'burst') {
    const accessToken = token(config.scope.slice(0, -'.default'.length));
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = await fetch(`${config.endpoint}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: 'Reply OK.', max_output_tokens: 16, store: false }),
        signal: AbortSignal.timeout(60000),
      });
      const result = await response.json();
      console.log(JSON.stringify({ attempt, httpStatus: response.status, errorCode: result.error?.code, requestId: response.headers.get('apim-request-id') }));
      if (response.status === 429) {
        console.log('Observed real 429; stopped generating requests.');
        return;
      }
      if (!response.ok) throw new Error(`Model test stopped on HTTP ${response.status}; error code ${result.error?.code}`);
    }
    throw new Error('No 429 within the three-request safety limit; no further requests sent.');
  } else {
    throw new Error('Usage: node monitor.mjs check|validate|deploy|status|notify-test [Fired|Resolved]|runs|observe|evidence|burst');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  run(process.argv[2], process.argv[3]).catch((error) => {
    console.error(redact(error.message));
    process.exitCode = 1;
  });
}