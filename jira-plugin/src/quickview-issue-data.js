import {buildPopupIssueMetadataUrl} from 'src/jira-issue-helpers';
import {createIssueDataCacheRepository} from 'src/quickview-issue-data/cache-repository';
import {createFieldFacts} from 'src/quickview-issue-data/field-facts';
import {createFieldOptions} from 'src/quickview-issue-data/field-options';
import {createImageNormalization} from 'src/quickview-issue-data/image-normalization';
import {createOptionalSectionAcquisition} from 'src/quickview-issue-data/optional-sections';
import {createSearchAcquisition} from 'src/quickview-issue-data/search-acquisition';

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

function unavailableSection(shape = {}) {
  return {status: 'unavailable', failure: null, ...copyValue(shape)};
}

function dataSection(data, shape = {}) {
  const empty = Array.isArray(data) ? data.length === 0 : !data;
  return {status: empty ? 'empty' : 'ready', failure: null, ...copyValue(shape), data: copyValue(data)};
}

export function createQuickViewIssueData(options = {}) {
  const jira = options.jira;
  if (!jira || typeof jira.read !== 'function') {
    throw new Error('QuickViewIssueData requires a Jira adapter');
  }

  const clock = typeof options.clock === 'function' ? options.clock : () => Date.now();
  const customFields = Array.isArray(options.customFields) ? options.customFields : [];
  const freshnessPolicy = normalizeFreshnessPolicy(options.freshnessPolicy);
  const instanceUrl = normalizeInstanceUrl(options.instanceUrl);
  const cache = createIssueDataCacheRepository({clock});
  const fieldFacts = createFieldFacts({
    cache,
    jira,
    instanceUrl,
    ttlMs: freshnessPolicy.coreMs,
  });
  const imageNormalization = createImageNormalization({
    cache,
    jira,
    instanceUrl,
    ttlMs: freshnessPolicy.coreMs,
  });
  const searchAcquisition = createSearchAcquisition({
    cache,
    jira,
    instanceUrl,
    loadCore,
    ttlMs: freshnessPolicy.coreMs,
  });
  const optionalSections = createOptionalSectionAcquisition({
    cache,
    fieldFacts,
    jira,
    instanceUrl,
    ttlMs: freshnessPolicy.coreMs,
  });
  const fieldOptions = createFieldOptions({
    cache,
    fieldFacts,
    jira,
    instanceUrl,
    loadCore,
    ttlMs: freshnessPolicy.coreMs,
  });
  let revision = 0;

  function invalidateIssue(issueKey, mutation = {}, priorSnapshot = null) {
    const coreMutations = new Set([
      'attachmentChanged',
      'commentChanged',
      'descriptionChanged',
      'fieldChanged',
      'issueChanged',
      'linksChanged',
      'quickAction',
      'timeChanged',
      'watchersChanged',
    ]);
    const historyMutations = new Set([
      'attachmentChanged',
      'commentChanged',
      'descriptionChanged',
      'fieldChanged',
      'issueChanged',
      'linksChanged',
      'quickAction',
      'timeChanged',
    ]);
    if (coreMutations.has(mutation.kind)) cache.invalidate('core', issueKey);
    if (historyMutations.has(mutation.kind)) cache.invalidate('history', issueKey);
    const fieldId = String(mutation.fieldId || '').toLowerCase();
    if (mutation.kind === 'issueChanged' || (mutation.kind === 'fieldChanged' && fieldId === 'summary')) {
      cache.invalidate('summary', issueKey);
    }
    fieldFacts.invalidateIssue(issueKey, mutation);
    fieldOptions.invalidateIssue(mutation);
    optionalSections.invalidateIssue(issueKey, priorSnapshot?.issueId || '', mutation);
    searchAcquisition.invalidateIssue(issueKey, mutation);
  }

  async function loadFieldContext(request = {}) {
    const normalizedIssueKey = String(request.issueKey || '').trim();
    const requestedFieldId = String(request.fieldId || '').trim();
    try {
      const result = await fieldFacts.loadFieldContext({...request, issueKey: normalizedIssueKey, fieldId: requestedFieldId});
      if (request.includeOptions) {
        try {
          result.context.options = await fieldOptions.load({
            issueKey: normalizedIssueKey,
            fieldId: requestedFieldId,
            signal: request.signal,
          });
        } catch (error) {
          result.optionsError = error;
        }
      }
      const failures = {};
      if (result.catalogError) failures.catalog = normalizeFailure(result.catalogError);
      if (result.editMetaError) failures.editMeta = normalizeFailure(result.editMetaError);
      if (result.transitionsError) failures.transitions = normalizeFailure(result.transitionsError);
      if (result.optionsError) failures.options = normalizeFailure(result.optionsError);
      return {
        kind: Object.keys(failures).length ? 'partial' : 'loaded',
        issueKey: normalizedIssueKey,
        fieldId: requestedFieldId,
        context: copyValue(result.context),
        failures,
      };
    } catch (error) {
      return {
        kind: isAbort(error, request.signal) ? 'aborted' : 'failed',
        issueKey: normalizedIssueKey,
        fieldId: requestedFieldId,
        context: null,
        failures: {fieldContext: normalizeFailure(error)},
      };
    }
  }

  async function search(request = {}) {
    const purpose = String(request.purpose || '').trim();
    const issueKey = String(request.issueKey || '').trim();
    const query = String(request.query || '').trim();
    try {
      const result = await searchAcquisition.search({...request, purpose, issueKey, query});
      if (['assignee', 'userPicker', 'watcher'].includes(purpose)) {
        await imageNormalization.normalizeUsers(result.items, request.signal);
      } else if (['parent', 'linkedIssue'].includes(purpose)) {
        await imageNormalization.normalizeIssues(result.items, request.signal);
      }
      return {
        kind: 'loaded',
        purpose,
        issueKey,
        query,
        items: copyValue(result.items || []),
        strategyUsed: result.strategyUsed || '',
        failure: null,
      };
    } catch (error) {
      return {
        kind: isAbort(error, request.signal) ? 'aborted' : 'failed',
        purpose,
        issueKey,
        query,
        items: [],
        strategyUsed: '',
        failure: normalizeFailure(error),
      };
    }
  }

  async function loadCore(issueKey, signal) {
    return cache.read({
      family: 'core',
      key: issueKey,
      ttlMs: freshnessPolicy.coreMs,
      load: async () => {
        const [sprintFieldIds, epicLinkFieldIds] = await Promise.all([
          fieldFacts.getCatalogFieldIds('sprint', signal).catch(() => []),
          fieldFacts.getCatalogFieldIds('epicLink', signal).catch(() => []),
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

    const sections = {
      children: unavailableSection({items: [], jql: ''}),
      history: unavailableSection({data: null}),
      linkedIssues: unavailableSection({detailsByKey: {}, items: [], linkTypes: []}),
      pullRequests: unavailableSection({items: []}),
      reactions: unavailableSection({byCommentId: {}, supported: true}),
      watchers: unavailableSection({data: null, items: []}),
    };
    let viewer = {status: 'unavailable', user: null, failure: null};
    const failures = {};
    const plans = [];
    if (includeHistory) plans.push({name: 'history', load: () => loadHistory(normalizedIssueKey, signal)});
    if (requirements.children === true) plans.push({name: 'children', load: () => optionalSections.loadChildren(normalizedIssueKey, signal)});
    if (requirements.pullRequests === true) plans.push({name: 'pullRequests', load: () => optionalSections.loadPullRequests(String(core?.id || ''), signal)});
    if (requirements.linkedIssues === true) plans.push({name: 'linkedIssues', load: () => optionalSections.loadLinkedIssues(core, signal)});
    if (requirements.watchers === true) plans.push({name: 'watchers', load: () => optionalSections.loadWatchers(normalizedIssueKey, signal)});
    if (requirements.viewer === true) plans.push({name: 'viewer', load: () => optionalSections.loadViewer(signal)});
    if (requirements.reactions === true) {
      const commentIds = (core?.fields?.comment?.comments || []).map(comment => comment?.id).filter(Boolean);
      plans.push({name: 'reactions', load: () => optionalSections.loadReactions(commentIds, signal)});
    }
    const settled = await Promise.all(plans.map(async plan => {
      try {
        return {name: plan.name, status: 'fulfilled', value: await plan.load()};
      } catch (error) {
        return {name: plan.name, status: 'rejected', reason: error};
      }
    }));
    for (const result of settled) {
      if (result.status === 'rejected') {
        if (isAbort(result.reason, signal)) {
          return {
            kind: 'aborted',
            issueKey: normalizedIssueKey,
            revision: ++revision,
            snapshot: null,
            failures: {[result.name]: normalizeFailure(result.reason)},
          };
        }
        const failure = normalizeFailure(result.reason);
        failures[result.name] = failure;
        if (result.name === 'viewer') {
          viewer = {status: 'failed', user: null, failure};
        } else {
          sections[result.name] = {...sections[result.name], status: 'failed', failure};
        }
        continue;
      }
      if (result.name === 'history') {
        sections.history = buildHistorySection(result.value);
      } else if (result.name === 'children') {
        await imageNormalization.normalizeIssues(result.value.items, signal);
        sections.children = {
          status: result.value.items.length ? 'ready' : 'empty',
          items: copyValue(result.value.items),
          jql: result.value.jql || '',
          failure: null,
        };
      } else if (result.name === 'pullRequests') {
        await imageNormalization.normalizePullRequests(result.value, signal);
        sections.pullRequests = {
          status: result.value.length ? 'ready' : 'empty',
          items: copyValue(result.value),
          failure: null,
        };
      } else if (result.name === 'linkedIssues') {
        await imageNormalization.normalizeIssues(result.value.items, signal);
        sections.linkedIssues = {
          status: result.value.items.length ? 'ready' : 'empty',
          detailsByKey: copyValue(result.value.detailsByKey),
          items: copyValue(result.value.items),
          linkTypes: copyValue(result.value.linkTypes),
          failure: null,
        };
      } else if (result.name === 'watchers') {
        await imageNormalization.normalizeUsers(result.value.watchers, signal);
        sections.watchers = {
          ...dataSection(result.value, {items: result.value.watchers || []}),
          status: (result.value.watchers || []).length ? 'ready' : 'empty',
        };
      } else if (result.name === 'reactions') {
        sections.reactions = {
          status: Object.keys(result.value.byCommentId || {}).length ? 'ready' : 'empty',
          byCommentId: copyValue(result.value.byCommentId || {}),
          supported: result.value.supported !== false,
          failure: null,
        };
      } else if (result.name === 'viewer') {
        viewer = {status: result.value?.id ? 'ready' : 'empty', user: copyValue(result.value), failure: null};
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
        core: await imageNormalization.normalizeCore(copyValue(core), signal),
        viewer,
        sections,
      },
      failures,
    };
  }

  async function refreshAfterMutation({issueKey, priorSnapshot = null, mutation, requirements = {}, signal} = {}) {
    const normalizedIssueKey = String(issueKey || '').trim();
    if (normalizedIssueKey) {
      invalidateIssue(normalizedIssueKey, mutation, priorSnapshot);
    }
    const outcome = await openIssue({
      issueKey: normalizedIssueKey,
      requirements,
      signal,
    });
    if (priorSnapshot && outcome.snapshot) {
      Object.entries(outcome.snapshot.sections || {}).forEach(([name, section]) => {
        const priorSection = priorSnapshot.sections?.[name];
        if (section?.status !== 'failed' || !priorSection || ['failed', 'unavailable'].includes(priorSection.status)) return;
        outcome.snapshot.sections[name] = {
          ...copyValue(priorSection),
          status: 'staleRetained',
          failure: copyValue(section.failure),
        };
      });
    }
    return {...outcome, mutation: copyValue(mutation || {kind: 'issueChanged'})};
  }

  return {loadFieldContext, openIssue, refreshAfterMutation, search};
}
