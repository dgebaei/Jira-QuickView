const {jiraApiPattern} = require('./live-jira-api');

async function fulfillJson(route, status, payload, extraHeaders = {}) {
  await route.fulfill({
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
}

async function failWithJson(context, instanceUrl, pathPattern, status, payload) {
  await context.route(jiraApiPattern(instanceUrl, pathPattern), async route => {
    await fulfillJson(route, status, payload);
  });
}

async function fulfillMalformedJson(context, instanceUrl, pathPattern, body = '{') {
  await context.route(jiraApiPattern(instanceUrl, pathPattern), async route => {
    await route.fulfill({
      status: 200,
      headers: {'content-type': 'application/json; charset=utf-8'},
      body,
    });
  });
}

async function patchJsonResponse(context, instanceUrl, pathPattern, patcher) {
  await context.route(jiraApiPattern(instanceUrl, pathPattern), async route => {
    const response = await route.fetch();
    const payload = await response.json();
    const nextPayload = await patcher(payload, route.request());
    await route.fulfill({
      status: response.status(),
      headers: {
        ...response.headers(),
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(nextPayload),
    });
  });
}

module.exports = {
  failWithJson,
  fulfillMalformedJson,
  patchJsonResponse,
};
