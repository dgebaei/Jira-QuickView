export function snapshotToLegacyPopupState(snapshot) {
  const children = snapshot?.sections?.children;
  const pullRequests = snapshot?.sections?.pullRequests;
  const reactions = snapshot?.sections?.reactions;
  return {
    issueSnapshot: snapshot,
    issueData: snapshot?.core || null,
    children: Array.isArray(children?.items) ? children.items : [],
    childrenJql: children?.jql || '',
    childrenError: children?.status === 'failed' ? (children.failure?.message || 'Could not load child issues') : '',
    pullRequests: Array.isArray(pullRequests?.items) ? pullRequests.items : [],
    commentReactionState: {
      byCommentId: reactions?.byCommentId || {},
      supported: reactions?.supported !== false,
    },
  };
}
