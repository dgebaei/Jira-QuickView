const {test, expect} = require('@playwright/test');
const {
  buildIssueLinkCreatePayload,
  buildLinkedIssuesPanelView,
  buildRelationshipOptions,
  parseLinkedIssueKeys,
} = require('../../jira-plugin/src/content-linked-issues-helpers');

test('groups both directions of a symmetric relationship together', () => {
  const panel = buildLinkedIssuesPanelView({
    linkedIssuesState: {
      issueDetailsByKey: {},
      pendingRemoveIds: [],
      selectedIssues: [],
    },
  }, {
    fields: {
      issuelinks: [
        {
          id: 'link-1',
          type: {id: '10003', name: 'Relates', outward: 'relates to', inward: 'relates to'},
          outwardIssue: {key: 'APP-1', fields: {summary: 'First issue'}},
        },
        {
          id: 'link-2',
          type: {id: '10003', name: 'Relates', outward: 'relates to', inward: 'relates to'},
          inwardIssue: {key: 'APP-2', fields: {summary: 'Second issue'}},
        },
      ],
    },
  });

  expect(panel.groups).toHaveLength(1);
  expect(panel.groups[0]).toMatchObject({label: 'relates to', count: 2});
});

test('parses unique Jira keys from pasted comma, whitespace, and newline-separated text', () => {
  expect(parseLinkedIssueKeys('app-12, API_2-7\nAPP-12  OPS-004')).toEqual([
    'APP-12',
    'API_2-7',
    'OPS-004',
  ]);
});

test('builds directional options and maps both directions into Jira link payloads', () => {
  const options = buildRelationshipOptions([
    {id: 'blocks', name: 'Blocks', outward: 'blocks', inward: 'is blocked by'},
    {id: 'relates', name: 'Relates', outward: 'relates to', inward: 'relates to'},
  ]);

  expect(options.map(option => option.id)).toEqual([
    'blocks:outward',
    'blocks:inward',
    'relates:outward',
  ]);
  expect(buildIssueLinkCreatePayload('APP-1', options[0], 'APP-2')).toEqual({
    type: {name: 'Blocks'},
    outwardIssue: {key: 'APP-1'},
    inwardIssue: {key: 'APP-2'},
  });
  expect(buildIssueLinkCreatePayload('APP-1', options[1], 'APP-2')).toEqual({
    type: {name: 'Blocks'},
    outwardIssue: {key: 'APP-2'},
    inwardIssue: {key: 'APP-1'},
  });
});
