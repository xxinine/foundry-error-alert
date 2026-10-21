import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { loadConfiguration } from './config.mjs';
import { template, notificationContent } from './monitor.mjs';

const example = {
  AZURE_SUBSCRIPTION_ID: '11111111-2222-3333-4444-555555555555',
  AZURE_RESOURCE_GROUP: 'customer-rg', AZURE_LOCATION: 'westus2',
  FOUNDRY_ACCOUNT_NAME: 'customer-foundry', MODEL: 'customer-model',
  FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/open-apis/bot/v2/hook/test-hook',
  FEISHU_WEBHOOK_KEY: 'test-only-secret',
};

test('configuration uses customer subscription, account, model and derived resource names', () => {
  const config = loadConfiguration({ ...example, RESOURCE_PREFIX: 'customer-alerts' });
  assert.equal(config.subscription, example.AZURE_SUBSCRIPTION_ID);
  assert.equal(config.model, example.MODEL);
  assert.equal(config.location, 'westus2');
  assert.equal(config.workflowName, 'customer-alerts-feishu');
  assert.equal(config.endpoint, 'https://customer-foundry.services.ai.azure.com/openai/v1');
  assert.ok(config.accountId.includes('/resourceGroups/customer-rg/'));
});

test('spaced and quoted dotenv values and explicit names remain supported', () => {
  const config = loadConfiguration({ ...example, ...parseEnv('MODEL = "other-model"\nLOGIC_APP_NAME = "existing-workflow"') });
  assert.equal(config.model, 'other-model');
  assert.equal(config.workflowName, 'existing-workflow');
  assert.equal(loadConfiguration({ ...example, AZURE_RESOURCE_GROUP: 'r' }).resourceGroup, 'r');
});

test('missing required configuration fails without echoing credentials', () => {
  for (const name of Object.keys(example)) {
    assert.throws(() => loadConfiguration({ ...example, [name]: '' }), (error) => {
      assert.ok(error.message.includes(name));
      assert.ok(!error.message.includes(example.FEISHU_WEBHOOK_KEY));
      return true;
    });
  }
});

test('numeric values, resource names and endpoint mismatches are rejected', () => {
  for (const overrides of [
    { ALERT_THRESHOLD: '-1' }, { ALERT_THRESHOLD: 'NaN' }, { ALERT_WINDOW_MINUTES: '7' },
    { ALERT_FREQUENCY_MINUTES: '15', ALERT_WINDOW_MINUTES: '5' }, { ALERT_SEVERITY: '5' },
    { LOGIC_APP_NAME: "invalid'name" }, { ENDPOINT: 'https://another-account.services.ai.azure.com/openai/v1' },
    { AZURE_SUBSCRIPTION_ID: 'not-a-subscription' }, { INTEGRATION_ACCOUNT_SKU: 'invalid' },
  ]) assert.throws(() => loadConfiguration({ ...example, ...overrides }));
});

test('generated template contains only customer targets and configured alert settings', () => {
  const config = loadConfiguration({
    ...example, RESOURCE_PREFIX: 'customer-alerts', AZURE_METRIC_NAME: 'ModelRequests',
    ALERT_WINDOW_MINUTES: '15', ALERT_FREQUENCY_MINUTES: '5', ALERT_THRESHOLD: '3', ALERT_SEVERITY: '1',
  });
  const definition = template(config);
  const rule = definition.resources.at(-1).properties;
  assert.equal(rule.criteria.allOf[0].metricName, 'ModelRequests');
  assert.deepEqual(rule.scopes, [config.accountId]);
  assert.equal(rule.criteria.allOf[0].dimensions[1].values[0], 'customer-model');
  assert.equal(rule.criteria.allOf[0].threshold, 3);
  assert.equal(rule.windowSize, 'PT15M');
  assert.equal(rule.evaluationFrequency, 'PT5M');
  assert.equal(rule.severity, 1);
  assert.ok(rule.autoMitigate);
  const serialized = JSON.stringify(definition);
  for (const forbidden of ['ai-foundry-xs', 'gpt-5.6-luna', 'dev-xueshu', example.FEISHU_WEBHOOK_KEY, example.FEISHU_WEBHOOK_URL]) {
    assert.ok(!serialized.includes(forbidden));
  }
  assert.equal(definition.parameters.feishuKey.type, 'securestring');
});

test('notification uses recovery-specific details, evaluated count and event timestamps', () => {
  const config = loadConfiguration(example);
  const content = notificationContent(config);
  assert.ok(content.includes("if(equals(triggerBody()?['data']?['essentials']?['monitorCondition'], 'Resolved'), 'Recovered:"));
  assert.ok(content.includes('no longer exceeds the threshold.'));
  assert.ok(content.includes('**Trigger condition:** HTTP 429 count > 0'));
  assert.ok(content.includes('**Evaluated 429 count:**'));
  assert.ok(content.includes("['metricValue'], 'Unavailable'"));
  assert.ok(content.includes("['resolvedDateTime']"));
  assert.ok(!content.includes("['description']"));
  const workflow = template(config).resources.find((resource) => resource.type === 'Microsoft.Logic/workflows');
  assert.equal(workflow.properties.definition.actions.Message.inputs, content);
  assert.equal(workflow.properties.definition.actions.Send_Feishu.inputs.body.card.elements[0].text.content, "@outputs('Message')");
  assert.deepEqual(workflow.properties.definition.actions.Sign.runtimeConfiguration.secureData.properties, ['inputs', 'outputs']);
});