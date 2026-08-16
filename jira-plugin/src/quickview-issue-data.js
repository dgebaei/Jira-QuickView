import {buildPopupIssueMetadataUrl} from 'src/jira-issue-helpers';
import {createIssueDataCacheRepository} from 'src/quickview-issue-data/cache-repository';

const DEFAULT_FRESHNESS_MS = 60 * 1000;

function copyValue(value) {
  if (Array.isArray(value)) {
    return value.map(copyValue);
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((copy, [key, entry]) => {
      copy[key] = copyValue(entry);
      return copy;
    }, {});
  }
  return value;
}

function normalizeFailure(error) {
  return {
    message: String(error?.message || error?.inner || error || 'Request failed'),
    name: String(error?.name || 'Error'),
  };
}

function isAbort(error, signal) {
  return signal?.aborted || error?.name === 'AbortError';
}

function normalizeInstanceUrl(instanceUrl) {
  const value = String(instanceUrl || '').trim();
  return value && !value.endsWith('/') ? `${value}/` : value;
}

function normalizeFreshnessPolicy(policy = {}) {
  function duration(value) {
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_FRESHNESS_MS;
  }
  return {
    coreMs: duration(policy.coreMs),
    historyMs: duration(policy.historyMs),
    summaryMs: duration(policy.summaryMs),
  };
}

function buildHistorySection(changelog) {
  const data = changelog && typeof changelog === 'object'
    ? changelog
    : {histories: []};
  const histories = Array.isArray(data.histories) ? data.histories : [];
  return {
    status: histories.length ? 'ready' : 'empty',
    data: {...copyValue(data), histories: copyValue(histories)},
    failure: null,
  };
}

export function createQuickViewIssueData(options = {}) {
  const jira = options.jira;
  if (!jira || typeof jira.read !== 'function') {
    throw new Error('QuickViewIssueData requires a Jira adapter');
  }

  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const customFields = Array.isArray(options.customFields) ? options.customFields : [];
  const freshnessPolicy = normalizeFreshnessPolicy(options.freshnessPolicy);
  const getEpicLinkFieldIds = typeof options.getEpicLinkFieldIds === 'function'
    ? options.getEpicLinkFieldIds
    : async () => [];
  const getSprintFieldIds = typeof options.getSprintFieldIds === 'function'
    ? options.getSprintFieldIds
    : async () => [];
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const cache = createIssueDataCacheRepository({clock});
  let revision = 0;

  function invalidateIssue(issueKey, mutation = {}) {
    cache.invalidate('core', issueKey);
    cache.invalidate('history', issueKey);
    const fieldId = String(mutation.fieldId || '').toLowerCase();
    if (mutation.kind === 'issueChanged' || (mutation.kind === 'fieldChanged' && fieldId === 'summary')) {
      cache.invalidate('summary', issueKey);
    }
  }

  async function loadCore(issueKey, signal) {
    return cache.read({
      family: 'core',
      key: issueKey,
      ttlMs: freshnessPolicy.coreMs,
      load: async () => {
        const [sprintFieldIds, epicLinkFieldIds] = await Promise.all([
          getSprintFieldIds(instanceUrl),
          getEpicLinkFieldIds(instanceUrl),
        ]);
        return jira.read({
          path: buildPopupIssueMetadataUrl(instanceUrl, issueKey, {
            sprintFieldIds,
            epicLinkFieldIds,
            customFields,
          }),
          signal,
        });
      },
    });
  }

  async function loadSummary(issueKey, signal) {
    return cache.read({
      family: 'summary',
      key: issueKey,
      ttlMs: freshnessPolicy.summaryMs,
      load: async () => {
        const data = await jira.read({
          path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}?fields=summary`,
          signal,
        });
        return {
          key: issueKey,
          summary: data?.fields?.summary || issueKey,
        };
      },
    });
  }

  async function loadHistory(issueKey, signal) {
    return cache.read({
      family: 'history',
      key: issueKey,
      ttlMs: freshnessPolicy.historyMs,
      load: async () => {
        const response = await jira.read({
          path: `${instanceUrl}rest/api/2/issue/${encodeURIComponent(issueKey)}?expand=changelog&fields=id`,
          signal,
        });
        return response?.changelog || {histories: []};
      },
    });
  }

  async function openIssue({issueKey, requirements = {}, freshness = 'cached', signal} = {}) {
    const normalizedIssueKey = String(issueKey || '').trim();
    if (!normalizedIssueKey) {
      return {
        kind: 'failed',
        issueKey: normalizedIssueKey,
        revision: ++revision,
        snapshot: null,
        failures: {core: {message: 'Issue key is required', name: 'Error'}},
      };
    }

    const coreRequirement = requirements.core === 'summary' ? 'summary' : 'full';
    const includeHistory = requirements.history === true;
    if (freshness === 'refresh') {
      cache.invalidate(coreRequirement === 'summary' ? 'summary' : 'core', normalizedIssueKey);
      if (includeHistory) {
        cache.invalidate('history', normalizedIssueKey);
      }
    }

    let core;
    try {
      core = coreRequirement === 'summary'
        ? await loadSummary(normalizedIssueKey, signal)
        : await loadCore(normalizedIssueKey, signal);
    } catch (error) {
      const resultRevision = ++revision;
      return {
        kind: isAbort(error, signal) ? 'aborted' : 'failed',
        issueKey: normalizedIssueKey,
        revision: resultRevision,
        snapshot: null,
        failures: {core: normalizeFailure(error)},
      };
    }

    let history = {status: 'unavailable', data: null, failure: null};
    const failures = {};
    if (includeHistory) {
      try {
        history = buildHistorySection(await loadHistory(normalizedIssueKey, signal));
      } catch (error) {
        if (isAbort(error, signal)) {
          return {
            kind: 'aborted',
            issueKey: normalizedIssueKey,
            revision: ++revision,
            snapshot: null,
            failures: {history: normalizeFailure(error)},
          };
        }
        history = {status: 'failed', data: {histories: []}, failure: normalizeFailure(error)};
        failures.history = history.failure;
      }
    }

    const resultRevision = ++revision;
    return {
      kind: Object.keys(failures).length ? 'partial' : 'loaded',
      issueKey: normalizedIssueKey,
      revision: resultRevision,
      snapshot: {
        issueKey: normalizedIssueKey,
        issueId: core?.id ? String(core.id) : '',
        revision: resultRevision,
        core: copyValue(core),
        sections: {history},
      },
      failures,
    };
  }

  async function refreshAfterMutation({issueKey, mutation, requirements = {}, signal} = {}) {
    const normalizedIssueKey = String(issueKey || '').trim();
    if (normalizedIssueKey) {
      invalidateIssue(normalizedIssueKey, mutation);
    }
    const outcome = await openIssue({
      issueKey: normalizedIssueKey,
      requirements,
      signal,
    });
    return {...outcome, mutation: copyValue(mutation || {kind: 'issueChanged'})};
  }

  return {openIssue, refreshAfterMutation};
}
