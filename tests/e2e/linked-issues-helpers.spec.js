const {test, expect} = require('@playwright/test');
const {
  buildIssueLinkCreatePayload,
  buildLinkedIssuesPanelView,
  buildRelationshipOptions,
  parseLinkedIssueKeys,
} = require('../../jira-plugin/src/content-linked-issues-helpers');

test('groups both directions of a symmetric relationship together', () => {
  const panel = buildLinkedIssuesPanelView({
    linkedIssueView: {
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

  expect(panel.sections.map(section => section.key)).toEqual(['linked']);
  expect(panel.sections[0].groups).toHaveLength(1);
  expect(panel.sections[0].groups[0]).toMatchObject({label: 'relates to', count: 2});
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

test('splits children, linked issues, and external links into ordered sections with a combined count', () => {
  const panel = buildLinkedIssuesPanelView({linkedIssueView: {pendingRemoveIds: [], selectedIssues: []}}, {
    key: 'APP-1',
    fields: {
      subtasks: [{key: 'APP-9', fields: {summary: 'Ignored when children are loaded'}}],
      issuelinks: [{
        id: '501',
        type: {id: 'blocks', name: 'Blocks', outward: 'blocks', inward: 'is blocked by'},
        outwardIssue: {key: 'APP-2', fields: {summary: 'Blocked issue'}},
      }],
    },
  }, {
    instanceUrl: 'https://jira.example/',
    children: [
      {key: 'APP-3', fields: {summary: 'Child one', status: {name: 'Open'}}},
      {key: 'APP-3', fields: {summary: 'Duplicate child'}},
      {key: 'APP-4', fields: {summary: 'Child two'}},
    ],
    childrenJql: 'parent = "APP-1"',
    remoteLinks: [
      {id: 77, object: {url: 'https://qa.example/#/cases/TC-1', title: 'TC-1: Login case'}},
      {id: 78, relationship: 'mentioned in', application: {name: 'Confluence'}, object: {url: 'https://wiki.example/x', title: 'Spec page', status: {resolved: true}}},
      {id: 79, object: {title: 'No URL, skipped'}},
    ],
  });

  expect(panel.count).toBe(5);
  expect(panel.sections.map(section => [section.key, section.title, section.count])).toEqual([
    ['children', 'Children', 2],
    ['linked', 'Linked issues', 1],
    ['external', 'External links', 2],
  ]);
  const [children, linked, external] = panel.sections;
  expect(children.groups[0].hasLabel).toBe(false);
  expect(children.groups[0].rows.map(row => [row.key, row.canRemove])).toEqual([['APP-3', false], ['APP-4', false]]);
  expect(children.viewAllUrl).toBe(`https://jira.example/issues/?jql=${encodeURIComponent('parent = "APP-1"')}`);
  expect(linked.viewAllUrl).toBe(`https://jira.example/issues/?jql=${encodeURIComponent('issue in linkedIssues("APP-1")')}`);
  expect(linked.groups[0].rows[0]).toMatchObject({id: '501', key: 'APP-2', canRemove: true});
  expect(external.viewAllUrl).toBe('');
  expect(external.groups.map(group => group.label)).toEqual(['links to', 'mentioned in']);
  expect(external.groups[0].rows[0]).toMatchObject({
    id: 'remote:77',
    isRemote: true,
    title: 'TC-1: Login case',
    url: 'https://qa.example/#/cases/TC-1',
    sourceText: 'qa.example',
    canRemove: true,
  });
  expect(external.groups[1].rows[0]).toMatchObject({sourceText: 'Confluence', isResolved: true});
  expect(panel.viewInJiraUrl).toBe('https://jira.example/browse/APP-1#linkingmodule');
});

test('falls back to core sub-tasks when the children section has not loaded', () => {
  const panel = buildLinkedIssuesPanelView({linkedIssueView: {pendingRemoveIds: [], selectedIssues: []}}, {
    key: 'APP-1',
    fields: {subtasks: [{key: 'APP-9', fields: {summary: 'Sub-task', issuetype: {name: 'Sub-task', iconUrl: 'x.png'}}}]},
  }, {children: []});

  expect(panel.count).toBe(1);
  expect(panel.sections[0].groups[0].rows[0]).toMatchObject({key: 'APP-9', summary: 'Sub-task', issueTypeIconUrl: 'x.png'});
});

test('reports an empty panel when there is nothing to show', () => {
  const panel = buildLinkedIssuesPanelView({linkedIssueView: {pendingRemoveIds: [], selectedIssues: []}}, {key: 'APP-1', fields: {}});
  expect(panel.count).toBe(0);
  expect(panel.hasSections).toBe(false);
});
