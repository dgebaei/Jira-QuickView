// GitLab enrichment is deliberately read-only and separate from Jira transport.
// Only URLs identifying an MR are accepted; callers cannot supply arbitrary API paths.
export function parseGitLabMergeRequestUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const match = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)(?:\/(?:diffs|commits|pipelines))?\/?$/);
    if (!match) return null;
    const project = decodeURIComponent(match[1]);
    if (!project.includes('/') || project.split('/').some(part => !part || part === '.' || part === '..' || /[?#\\\s]/.test(part))) return null;
    return {origin: url.origin, project, iid: match[2], url: `${url.origin}/${match[1]}/-/merge_requests/${match[2]}`};
  } catch (error) {
    return null;
  }
}

async function readAll(read, path) {
  const items = [];
  let page = '1';
  for (let count = 0; count < 20; count += 1) {
    const response = await read(`${path}?per_page=100&page=${page}`);
    if (!Array.isArray(response.data)) throw new Error('Invalid GitLab list response');
    items.push(...response.data);
    if (!response.nextPage) return items;
    if (!/^\d+$/.test(response.nextPage) || Number(response.nextPage) <= Number(page)) break;
    page = response.nextPage;
  }
  throw new Error('GitLab returned too many pages; complete counts are unavailable');
}

export async function loadGitLabPullRequest(mr, read) {
  const path = `/projects/${encodeURIComponent(mr.project)}/merge_requests/${mr.iid}`;
  const {data} = await read(path);
  if (!data || !Number.isInteger(data.iid) || !['opened', 'closed', 'merged', 'locked'].includes(data.state)) {
    throw new Error('Expected GitLab merge request data. Sign in to GitLab and retry.');
  }
  const result = {
    status: 'ready',
    iid: data.iid,
    title: data.title,
    sourceBranch: data.source_branch,
    targetBranch: data.target_branch,
    state: data.state === 'opened' ? (data.draft ? 'DRAFT' : 'OPEN') : data.state.toUpperCase(),
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    mergedAt: data.merged_at,
    mergedBy: data.merge_user || data.merged_by,
    closedAt: data.closed_at,
    closedBy: data.closed_by,
    commit: null,
    unresolvedThreads: null,
    pipeline: null,
    conflicts: null,
    approvedBy: null,
    approvalsLeft: null,
    failure: '',
  };
  const closed = ['closed', 'merged'].includes(data.state);

  // Mergeability is asynchronous. A checking/unchecked response is not a clean bill of health.
  const mergeStatus = data.detailed_merge_status;
  if (mergeStatus === 'conflict') result.conflicts = true;
  else if (data.has_conflicts === true) result.conflicts = true;
  else if (mergeStatus === 'mergeable') result.conflicts = false;
  const pipeline = data.head_pipeline;
  const diffHead = data.sha || data.diff_refs?.head_sha;
  if (pipeline?.sha && pipeline.sha === diffHead) {
    result.pipeline = {status: pipeline.status, url: pipeline.web_url || ''};
  }

  const reads = [async () => {
    const {data: approvals} = await read(`${path}/approvals`);
    if (!Array.isArray(approvals?.approved_by) || approvals.approved_by.some(entry => !entry?.user)) {
      throw new Error('GitLab approval details unavailable');
    }
    result.approvedBy = approvals.approved_by.map(entry => ({
      name: entry.user.name || entry.user.username || `User ${entry.user.id}`,
      username: entry.user.username || '',
      approvedAt: entry.approved_at || '',
    }));
    result.approvalsLeft = Number.isInteger(approvals.approvals_left) ? approvals.approvals_left : null;
  }];
  if (!closed) reads.push(
    async () => {
      const discussions = await readAll(read, `${path}/discussions`);
      result.unresolvedThreads = discussions.filter(discussion => (discussion.notes || [])
        .some(note => note.resolvable === true && note.resolved === false)).length;
    },
    async () => {
      // Fetch the exact head commit, not the first/last item in a loosely ordered commit list.
      if (!/^[a-f0-9]{7,64}$/i.test(diffHead || '') || !Number.isInteger(data.source_project_id)) return;
      const {data: commit} = await read(`/projects/${data.source_project_id}/repository/commits/${diffHead}`);
      if (commit?.id !== diffHead) return;
      result.commit = {
        sha: commit.id,
        title: commit.title,
        author: commit.author_name,
        committedAt: commit.committed_date,
      };
    },
  );
  const settled = await Promise.allSettled(reads.map(run => run()));
  const failures = settled.filter(entry => entry.status === 'rejected');
  if (failures.length) {
    result.status = 'partial';
    result.failure = 'Some GitLab details could not be loaded. Retry to refresh missing signals.';
  }
  return result;
}
