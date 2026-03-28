const fs = require('fs/promises');
const path = require('path');
const {getLiveJiraConfig} = require('./live-jira');

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readStorageState(config = getLiveJiraConfig()) {
  if (!config.storageStatePath) {
    throw new Error('Missing JIRA_LIVE_STORAGE_STATE');
  }
  const raw = await fs.readFile(path.resolve(config.storageStatePath), 'utf8');
  return JSON.parse(raw);
}

function cookieMatchesUrl(cookie, url) {
  const target = new URL(url);
  const cookieDomain = String(cookie.domain || '').replace(/^\./, '');
  const hostname = target.hostname;
  const domainMatches = hostname === cookieDomain || hostname.endsWith(`.${cookieDomain}`);
  const pathMatches = target.pathname.startsWith(cookie.path || '/');
  return domainMatches && pathMatches;
}

async function buildCookieHeader(url, config = getLiveJiraConfig()) {
  const storageState = await readStorageState(config);
  const cookies = Array.isArray(storageState.cookies) ? storageState.cookies : [];
  return cookies
    .filter(cookie => cookieMatchesUrl(cookie, url))
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function getBaseUrl(config = getLiveJiraConfig()) {
  const baseUrl = String(config.instanceUrl || '').replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('Missing JIRA_LIVE_INSTANCE_URL');
  }
  return baseUrl;
}

async function buildRequestHeaders(url, headers = {}, config = getLiveJiraConfig()) {
  const cookieHeader = await buildCookieHeader(url, config);
  const nextHeaders = {
    Accept: 'application/json',
    'X-Atlassian-Token': 'no-check',
    ...headers,
  };
  if (cookieHeader) {
    nextHeaders.Cookie = cookieHeader;
  }
  return nextHeaders;
}

async function jiraApiRequest(apiPath, options = {}, config = getLiveJiraConfig()) {
  const baseUrl = getBaseUrl(config);
  const url = `${baseUrl}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
  const headers = await buildRequestHeaders(url, options.headers || {}, config);
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: 'follow',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${options.method || 'GET'} ${apiPath} failed with ${response.status}: ${errorText.slice(0, 500)}`);
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return response.text();
  }
  return response.json();
}

async function getLiveIssue(issueKey, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary,description,attachment,comment,issuetype,status,priority,labels,environment,versions,parent,fixVersions,assignee,reporter,watches&expand=renderedFields,names`, {}, config);
}

async function getLiveFields(config = getLiveJiraConfig()) {
  return jiraApiRequest('/rest/api/2/field', {}, config);
}

async function getIssueEditmeta(issueKey, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/editmeta`, {}, config);
}

async function getFirstCustomFieldId(config = getLiveJiraConfig()) {
  const fields = await getLiveFields(config);
  const match = (Array.isArray(fields) ? fields : []).find(field => String(field?.id || '').startsWith('customfield_'));
  return match ? match.id : null;
}

async function getFirstSupportedCustomField(config = getLiveJiraConfig()) {
  // Keep this list aligned with the explicitly approved live-test custom fields.
  const supportedIds = ['customfield_10105', 'customfield_10106', 'customfield_10033'];
  const fields = await getLiveFields(config);
  const list = Array.isArray(fields) ? fields : [];
  const preferredMatch = supportedIds
    .map(id => list.find(field => String(field?.id || '') === id))
    .find(Boolean);
  return preferredMatch
    ? {id: preferredMatch.id, name: preferredMatch.name || preferredMatch.id}
    : null;
}

async function getIssueComments(issueKey, config = getLiveJiraConfig()) {
  const data = await jiraApiRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=comment`, {}, config);
  return data?.fields?.comment?.comments || [];
}

async function getAssignableUsers(issueKey, query = '', config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/user/assignable/search?issueKey=${encodeURIComponent(issueKey)}&maxResults=20&query=${encodeURIComponent(query)}`, {}, config);
}

async function getMentionUsers(query = '', config = getLiveJiraConfig()) {
  const data = await jiraApiRequest(`/rest/api/2/user/picker?query=${encodeURIComponent(query)}`, {}, config);
  return data?.users || [];
}

async function getLabelSuggestions(query = '', config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=${encodeURIComponent(query)}`, {}, config);
}

async function getCurrentUser(config = getLiveJiraConfig()) {
  return jiraApiRequest('/rest/api/2/myself', {}, config);
}

async function getProjectVersions(projectKey, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/project/${encodeURIComponent(projectKey)}/versions`, {}, config);
}

async function updateIssueFields(issueKey, fields, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}`, {
    method: 'PUT',
    body: JSON.stringify({fields}),
  }, config);
}

async function uploadIssueAttachment(issueKey, fileName, mimeType, buffer, config = getLiveJiraConfig()) {
  const baseUrl = getBaseUrl(config);
  const apiPath = `/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`;
  const url = `${baseUrl}${apiPath}`;
  const headers = await buildRequestHeaders(url, {}, config);
  delete headers.Accept;

  const form = new FormData();
  form.append('file', new Blob([buffer], {type: mimeType}), fileName);

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: form,
    redirect: 'follow',
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`POST ${apiPath} failed with ${response.status}: ${errorText.slice(0, 500)}`);
  }

  return response.json();
}

async function deleteIssueAttachment(attachmentId, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/attachment/${encodeURIComponent(attachmentId)}`, {
    method: 'DELETE',
  }, config);
}

async function deleteIssueComment(issueKey, commentId, config = getLiveJiraConfig()) {
  return jiraApiRequest(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
    method: 'DELETE',
  }, config);
}

function jiraApiPattern(instanceUrl, pathPattern) {
  return new RegExp(`^${escapeRegex(String(instanceUrl || '').replace(/\/$/, ''))}${pathPattern}`);
}

module.exports = {
  deleteIssueAttachment,
  getAssignableUsers,
  getCurrentUser,
  deleteIssueComment,
  getFirstCustomFieldId,
  getFirstSupportedCustomField,
  getIssueEditmeta,
  getIssueComments,
  getLabelSuggestions,
  getLiveFields,
  getLiveIssue,
  getMentionUsers,
  getProjectVersions,
  jiraApiPattern,
  jiraApiRequest,
  updateIssueFields,
  uploadIssueAttachment,
};
