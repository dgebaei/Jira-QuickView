import {parseGitLabMergeRequestUrl} from 'src/gitlab-pull-requests';

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function exactTime(value) {
  const time = timestamp(value);
  return time ? `${new Date(time).toISOString().replace('T', ' ').slice(0, 19)} UTC` : '';
}

function relativeTime(time, now) {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 60) return 'now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return `${Math.floor(seconds / 86400)}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', ...(new Date(time).getFullYear() !== new Date(now).getFullYear() ? {year: 'numeric'} : {}),
  }).format(time);
}

function person(user) {
  return user?.name || user?.displayName || user?.username || '';
}

function safeLink(value, fallback) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : fallback;
  } catch (error) {
    return fallback;
  }
}

function signal(kind, label, count = '', url = '') {
  return {kind, label, count, url, isComment: kind === 'comments', isFailure: kind === 'failure',
    isPending: kind === 'pending', isSuccess: kind === 'success', isConflict: kind === 'conflict', isUnknown: kind === 'unknown', isApproval: kind === 'approval'};
}

export function buildPullRequestView(pr, index, now = Date.now()) {
  const gitlab = pr.gitlab || {};
  const mr = parseGitLabMergeRequestUrl(pr.url);
  const status = String(gitlab.state || pr.status || '').toUpperCase();
  const closed = ['MERGED', 'CLOSED', 'DECLINED'].includes(status);
  const state = status === 'DECLINED' ? 'CLOSED' : status;
  const source = gitlab.sourceBranch || pr.source?.branch || pr.sourceBranch || pr.fromRef?.displayId || pr.source?.displayId || '';
  const target = gitlab.targetBranch || pr.destination?.branch || pr.target?.branch || pr.targetBranch || pr.toRef?.displayId || pr.destination?.displayId || '';
  const name = gitlab.title || pr.name || pr.title || 'Untitled pull request';
  const url = safeLink(pr.url, '');
  let id = gitlab.iid || mr?.iid;
  let prefix = '!';
  if (!id) {
    const match = url.match(/\/pull\/(\d+)/);
    id = match?.[1] || pr.number || pr.id || pr.key || '—';
    prefix = match ? '#' : '';
  }
  const event = {at: null, label: '', detail: ''};
  if (state === 'MERGED') {
    event.at = gitlab.mergedAt || pr.mergedAt || pr.mergedDate;
    event.label = `Merged${person(gitlab.mergedBy) ? ` by ${person(gitlab.mergedBy)}` : ''}`;
    event.detail = target ? `Into ${target}` : '';
  } else if (state === 'CLOSED') {
    event.at = gitlab.closedAt || pr.closedAt || pr.closedDate;
    event.label = `Closed${person(gitlab.closedBy) ? ` by ${person(gitlab.closedBy)}` : ''}`;
  } else if (timestamp(gitlab.commit?.committedAt)) {
    event.at = gitlab.commit.committedAt;
    event.label = `Latest commit${gitlab.commit.author ? ` by ${gitlab.commit.author}` : ''}`;
    event.detail = `${gitlab.commit.sha.slice(0, 7)} · ${gitlab.commit.title || ''}`;
  }
  if (!timestamp(event.at)) {
    event.at = gitlab.updatedAt || pr.lastUpdate || pr.updatedAt || pr.updatedDate;
    event.label = 'Updated (event details unavailable)';
    event.detail = '';
  }
  if (!timestamp(event.at)) {
    event.at = gitlab.createdAt || pr.createdAt || pr.createdDate;
    event.label = 'Created';
  }
  const time = timestamp(event.at);
  const timeDetails = time ? [event.label, exactTime(event.at), event.detail].filter(Boolean) : ['Last update unavailable'];
  if (gitlab.createdAt && event.label !== 'Created') timeDetails.push(`Created ${exactTime(gitlab.createdAt)}`);
  if (gitlab.updatedAt && timestamp(gitlab.updatedAt) !== time) timeDetails.push(`MR updated ${exactTime(gitlab.updatedAt)} (activity details unavailable)`);
  if (!closed && gitlab.commit) timeDetails.push('Commit author is not necessarily the person who pushed it.');
  const signals = [];
  if (gitlab.approvedBy?.length) {
    const count = gitlab.approvedBy.length;
    const label = `${count} ${count === 1 ? 'approval' : 'approvals'}`;
    const approval = signal('approval', label, count, url);
    approval.details = [
      {text: `Approved · ${label}`},
      ...gitlab.approvedBy.map(user => ({text: `${user.name}${user.username ? ` (@${user.username})` : ''}${exactTime(user.approvedAt) ? ` · ${exactTime(user.approvedAt)}` : ''}`})),
      ...(gitlab.approvalsLeft > 0 ? [{text: `${gitlab.approvalsLeft} more required by GitLab approval rules.`}] : []),
      {text: 'Recorded approvals do not imply this PR is ready to merge.'},
    ];
    signals.push(approval);
  }
  if (!closed) {
    if (gitlab.unresolvedThreads > 0) signals.push(signal('comments', `${gitlab.unresolvedThreads} unresolved review ${gitlab.unresolvedThreads === 1 ? 'thread' : 'threads'}`, gitlab.unresolvedThreads, url));
    const ci = gitlab.pipeline?.status;
    if (ci === 'failed') signals.push(signal('failure', 'CI failed on the current revision', '', safeLink(gitlab.pipeline.url, url)));
    else if (ci === 'success') signals.push(signal('success', 'CI passed on the current revision', '', safeLink(gitlab.pipeline.url, url)));
    else if (ci) signals.push(signal('pending', `CI ${ci.replace(/_/g, ' ')} on the current revision`, '', safeLink(gitlab.pipeline.url, url)));
    if (gitlab.conflicts === true) signals.push(signal('conflict', 'Merge conflicts detected', '', url));
    const unknown = [];
    if (!Array.isArray(gitlab.approvedBy)) unknown.push('approvals');
    if (gitlab.unresolvedThreads === null || gitlab.unresolvedThreads === undefined) unknown.push('review threads');
    if (!ci) unknown.push('CI');
    if (gitlab.conflicts === null || gitlab.conflicts === undefined) unknown.push('conflicts');
    const unknownReason = gitlab.failure || (!mr ? 'Not supplied by Jira.'
      : !gitlab.status ? 'Loading GitLab details.' : 'Not reported for the current revision, or GitLab is still calculating.');
    if (unknown.length) signals.push(signal('unknown', `Unknown: ${unknown.join(', ')}. ${unknownReason}`, '', url));
  }
  return {
    idText: `${prefix}${id}`,
    sortId: Number(id) || 0,
    status: state,
    statusText: state ? `${state[0]}${state.slice(1).toLowerCase()}` : '—',
    branchText: target || '—',
    branchTitle: target || 'Target branch unavailable',
    linkUrl: url,
    title: `${prefix}${id}`,
    linkTitle: [name, mr?.project, source ? `${source} → ${target || '?'}` : target].filter(Boolean).join('\n'),
    detailId: `jqv-pr-${index}-details`,
    timeDetailId: `jqv-pr-${index}-time`,
    timeText: time ? relativeTime(time, now) : '—',
    timeIso: time ? new Date(time).toISOString() : '',
    timeLabel: timeDetails.join('\n'),
    timeDetails: timeDetails.map(text => ({text})),
    timeValue: time,
    signals: signals.map((entry, signalIndex) => ({...entry, detailId: `jqv-pr-${index}-signal-${signalIndex}`, details: entry.details || [{text: entry.label}]})),
    hasSignals: signals.length > 0,
    connection: mr && ['permission-required', 'unavailable', 'partial'].includes(gitlab.status) ? {
      url: mr.url,
      label: gitlab.status === 'permission-required' ? `Connect ${new URL(mr.url).host}` : `Retry GitLab (${new URL(mr.url).host})`,
      title: gitlab.failure || 'Allow read-only GitLab details using your existing signed-in browser session.',
    } : null,
  };
}
