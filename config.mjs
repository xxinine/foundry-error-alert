import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export function loadConfiguration(values) {
  const required = (name) => {
    const value = values[name]?.trim();
    if (!value || value.startsWith('<')) throw new Error(`Configure ${name} in .env.`);
    return value;
  };
  const checked = (name, value, pattern) => {
    if (!pattern.test(value)) throw new Error(`Invalid ${name} in .env.`);
    return value;
  };
  const integer = (name, fallback, minimum, maximum) => {
    const text = values[name]?.trim() || String(fallback);
    const value = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
    }
    return value;
  };
  const subscription = checked('AZURE_SUBSCRIPTION_ID', required('AZURE_SUBSCRIPTION_ID'), /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i);
  const resourceGroup = checked('AZURE_RESOURCE_GROUP', required('AZURE_RESOURCE_GROUP'), /^(?!.*\.$)[\w().-]{1,90}$/);
  const location = checked('AZURE_LOCATION', required('AZURE_LOCATION').toLowerCase(), /^[a-z][a-z0-9]+$/);
  const account = checked('FOUNDRY_ACCOUNT_NAME', required('FOUNDRY_ACCOUNT_NAME'), /^[a-zA-Z0-9][a-zA-Z0-9-]{1,63}$/);
  const model = checked('MODEL', required('MODEL'), /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/);
  const resourcePrefix = checked('RESOURCE_PREFIX', values.RESOURCE_PREFIX?.trim() || 'foundry-alerts', /^[a-zA-Z][a-zA-Z0-9-]{1,39}$/);
  const resourceName = (name, suffix) => checked(name, values[name]?.trim() || `${resourcePrefix}-${suffix}`, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
  const workflowName = resourceName('LOGIC_APP_NAME', 'feishu');
  const integrationName = resourceName('INTEGRATION_ACCOUNT_NAME', 'integration');
  const actionGroupName = resourceName('ACTION_GROUP_NAME', 'action-group');
  const alertName = resourceName('ALERT_RULE_NAME', '429');
  const deploymentName = resourceName('DEPLOYMENT_NAME', 'deployment');
  const actionGroupShortName = checked('ACTION_GROUP_SHORT_NAME', values.ACTION_GROUP_SHORT_NAME?.trim() || 'foundry429', /^[a-zA-Z0-9_-]{1,12}$/);
  const integrationSku = values.INTEGRATION_ACCOUNT_SKU?.trim() || 'Free';
  if (!['Free', 'Basic', 'Standard'].includes(integrationSku)) throw new Error('INTEGRATION_ACCOUNT_SKU must be Free, Basic or Standard.');
  const metricName = values.AZURE_METRIC_NAME?.trim() || 'AzureOpenAIRequests';
  if (!['AzureOpenAIRequests', 'ModelRequests'].includes(metricName)) throw new Error('AZURE_METRIC_NAME must be AzureOpenAIRequests or ModelRequests.');
  const windowMinutes = integer('ALERT_WINDOW_MINUTES', 5, 1, 1440);
  const frequencyMinutes = integer('ALERT_FREQUENCY_MINUTES', 1, 1, 60);
  if (![1, 5, 15, 30, 60, 360, 720, 1440].includes(windowMinutes)) throw new Error('Unsupported ALERT_WINDOW_MINUTES.');
  if (![1, 5, 15, 30, 60].includes(frequencyMinutes) || frequencyMinutes > windowMinutes) throw new Error('ALERT_FREQUENCY_MINUTES must be supported and no greater than the window.');
  const threshold = integer('ALERT_THRESHOLD', 0, 0, 1000000000);
  const severity = integer('ALERT_SEVERITY', 2, 0, 4);
  const deploymentTimeout = integer('DEPLOYMENT_TIMEOUT_SECONDS', 600, 60, 3600);
  const endpoint = (values.ENDPOINT?.trim() || `https://${account}.services.ai.azure.com/openai/v1`).replace(/\/+$/, '');
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { throw new Error('Invalid ENDPOINT in .env.'); }
  if (endpointUrl.protocol !== 'https:' || ![`${account}.services.ai.azure.com`, `${account}.openai.azure.com`].includes(endpointUrl.hostname)
    || endpointUrl.pathname !== '/openai/v1' || endpointUrl.search || endpointUrl.hash || endpointUrl.username || endpointUrl.password || endpointUrl.port) {
    throw new Error('ENDPOINT must be the configured Foundry account HTTPS /openai/v1 endpoint.');
  }
  const scope = values.SCOPE?.trim() || 'https://ai.azure.com/.default';
  if (!['https://ai.azure.com/.default', 'https://cognitiveservices.azure.com/.default'].includes(scope)) throw new Error('Unsupported SCOPE for public Azure.');
  const feishuUrl = required('FEISHU_WEBHOOK_URL');
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9-]+$/.test(feishuUrl)) throw new Error('Invalid FEISHU_WEBHOOK_URL in .env.');
  const feishuKey = required('FEISHU_WEBHOOK_KEY');
  const prefix = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}`;
  return {
    subscription, resourceGroup, location, account, model, resourcePrefix,
    workflowName, integrationName, actionGroupName, alertName, deploymentName, actionGroupShortName,
    integrationSku, metricName, windowMinutes, frequencyMinutes, threshold, severity, deploymentTimeout,
    endpoint, scope, feishuUrl, feishuKey, prefix,
    accountId: `${prefix}/providers/Microsoft.CognitiveServices/accounts/${account}`,
    workflowId: `${prefix}/providers/Microsoft.Logic/workflows/${workflowName}`,
  };
}

export function readConfiguration() {
  let contents;
  try {
    contents = readFileSync(new URL('.env', import.meta.url), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing .env. Copy .env.example to .env and configure it first.');
    throw error;
  }
  return loadConfiguration(parseEnv(contents));
}