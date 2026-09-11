function getSprintEntries(issue) {
  const names = issue?.names || {};
  const fields = issue?.fields || {};
  return Object.keys(names).filter(fieldId => String(names[fieldId] || '').toLowerCase().includes('sprint'))
    .flatMap(fieldId => Array.isArray(fields[fieldId]) ? fields[fieldId] : [fields[fieldId]])
    .filter(Boolean);
}

function readSprints(issue) {
  const seen = new Set();
  return getSprintEntries(issue).map(entry => {
    if (typeof entry !== 'string') {
      return {id: String(entry?.id || ''), name: entry?.name || entry?.goal || String(entry?.id || ''), state: entry?.state || ''};
    }
    const read = name => entry.match(new RegExp(`${name}=([^,\\]]+)`, 'i'))?.[1] || '';
    return {id: read('id'), name: read('name') || entry, state: read('state')};
  }).filter(sprint => {
    const key = sprint.id || `${sprint.name}::${sprint.state}`;
    if (!sprint.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readBoardRefs(issue) {
  const projectKey = String(issue?.key || '').split('-')[0];
  const seen = new Set();
  const refs = [];
  getSprintEntries(issue).forEach(entry => {
    const ids = [];
    if (typeof entry === 'string') {
      ['rapidViewId', 'boardId', 'originBoardId'].forEach(name => {
        const value = entry.match(new RegExp(`${name}=([^,\\]]+)`, 'i'))?.[1];
        if (value) ids.push(value);
      });
    } else {
      ids.push(entry?.rapidViewId, entry?.boardId, entry?.originBoardId, entry?.board?.id, entry?.rapidView?.id);
    }
    ids.forEach(id => {
      const value = String(id || '');
      if (!value || seen.has(value)) return;
      seen.add(value);
      refs.push({id: value, name: entry?.board?.name || entry?.rapidView?.name || '', projectKey});
    });
  });
  return refs;
}

function mergeBoards(projectKey, ...lists) {
  const byId = new Map();
  lists.flat().forEach(board => {
    const id = String(board?.id || '');
    if (!id) return;
    byId.set(id, {...byId.get(id), ...board, id, projectKey: board?.projectKey || projectKey});
  });
  return [...byId.values()];
}

export function createFieldOptions(options = {}) {
  const cache = options.cache;
  const fieldFacts = options.fieldFacts;
  const instanceUrl = options.instanceUrl;
  const jira = options.jira;
  const loadCore = options.loadCore;
  const ttlMs = options.ttlMs;

  async function loadVersions(issueKey, signal) {
    const projectKey = issueKey.split('-')[0];
    return cache.read({
      family: 'fieldOptions:versions',
      key: projectKey,
      ttlMs,
      load: async () => {
        const response = await jira.read({
          path: `${instanceUrl}rest/api/2/project/${encodeURIComponent(projectKey)}/versions`,
          signal,
        });
        return (Array.isArray(response) ? response : []).filter(version => version?.name && !version?.archived);
      },
    });
  }

  async function loadSprints(issueKey, signal) {
    const issue = await loadCore(issueKey, signal);
    const projectKey = issueKey.split('-')[0];
    const boardKey = readBoardRefs(issue).map(board => board.id).sort().join(',');
    return cache.read({
      family: 'fieldOptions:sprints',
      key: `${projectKey}::${boardKey}`,
      ttlMs,
      load: async () => {
        const sprintIds = await fieldFacts.getCatalogFieldIds('sprint', signal).catch(() => []);
        if (!sprintIds.length) return [];
        let boardResponse = null;
        let boardError = null;
        try {
          boardResponse = await jira.read({
            path: `${instanceUrl}rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=50`,
            signal,
          });
        } catch (error) {
          boardError = error;
        }
        const projectBoards = (Array.isArray(boardResponse?.values) ? boardResponse.values : []).map(board => ({
          ...board,
          id: String(board?.id || ''),
          projectKey: board?.projectKey || projectKey,
        })).filter(board => board.id);
        const boards = mergeBoards(projectKey, projectBoards, readBoardRefs(issue));
        if (boardError && !boards.length) throw boardError;
        const settled = await Promise.allSettled(boards.map(async board => ({
          board,
          response: await jira.read({
            path: `${instanceUrl}rest/agile/1.0/board/${encodeURIComponent(board.id)}/sprint?state=active,future&maxResults=50`,
            signal,
          }),
        })));
        if (boards.length && !settled.some(result => result.status === 'fulfilled')) {
          throw settled.find(result => result.status === 'rejected')?.reason || new Error('Could not load Sprint options');
        }
        const byId = new Map();
        settled.filter(result => result.status === 'fulfilled').forEach(result => {
          const board = result.value.board;
          (result.value.response?.values || []).forEach(sprint => {
            if (!sprint?.id || !sprint?.name) return;
            const id = String(sprint.id);
            const prior = byId.get(id) || {};
            const boardRefs = [...(prior.boardRefs || [])];
            if (!boardRefs.some(ref => String(ref.id) === board.id)) boardRefs.push(board);
            byId.set(id, {...prior, ...sprint, boardRefs});
          });
        });
        readSprints(issue).forEach(sprint => {
          if (sprint.id && !byId.has(sprint.id)) byId.set(sprint.id, {...sprint, boardRefs: []});
        });
        const stateOrder = {active: 0, future: 1, closed: 2};
        return [...byId.values()].sort((left, right) => {
          const delta = (stateOrder[String(left?.state || '').toLowerCase()] ?? 99) -
            (stateOrder[String(right?.state || '').toLowerCase()] ?? 99);
          return delta || String(left?.name || '').localeCompare(String(right?.name || ''));
        });
      },
    });
  }

  async function load({issueKey, fieldId, signal}) {
    if (['versions', 'fixVersions'].includes(fieldId)) return loadVersions(issueKey, signal);
    if (fieldId === 'sprint') return loadSprints(issueKey, signal);
    return [];
  }

  function invalidateIssue(mutation = {}) {
    const fieldId = String(mutation.fieldId || '');
    if (mutation.kind === 'issueChanged' || (mutation.kind === 'fieldChanged' && ['versions', 'fixVersions'].includes(fieldId))) {
      cache.invalidateFamily('fieldOptions:versions');
    }
    if (mutation.kind === 'issueChanged' || mutation.kind === 'quickAction' || (mutation.kind === 'fieldChanged' && fieldId.toLowerCase().includes('sprint'))) {
      cache.invalidateFamily('fieldOptions:sprints');
    }
  }

  return {invalidateIssue, load};
}
