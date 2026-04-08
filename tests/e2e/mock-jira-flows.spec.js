const {test, expect, configureExtension, hoverIssueKey, injectContentScript} = require('./helpers/extension-fixtures');
const {popupModel} = require('./helpers/popup');
const {deleteIssueComment, getIssueComments, getLiveIssue, getMentionUsers, jiraApiPattern} = require('./helpers/live-jira-api');
const {ensurePreviewAttachment} = require('./helpers/live-jira-seed');
const {patchJsonResponse} = require('./helpers/jira-route-mocks');
const {buildExtensionConfig, requireJiraTestTarget, replaceIssueKeysOnPage, resolveTargetIssueKeys} = require('./helpers/test-targets');

const TEST_PNG_BYTES = Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0wAAAABJRU5ErkJggg==',
  'base64'
));

function baseConfig(servers, target) {
  return buildExtensionConfig(servers, {
    customFields: target.mode === 'mock' ? [{fieldId: 'customfield_12345', row: 2}] : [],
  }, target);
}

async function openPopup(extensionApp, servers, target) {
  const resolvedTarget = await resolveTargetIssueKeys(target);
  const page = await extensionApp.context.newPage();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {origin: servers.allowedPage.origin});
  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
  await replaceIssueKeysOnPage(page, [
    {from: 'JRACLOUD-97846', to: resolvedTarget.primaryIssueKey},
    {from: 'JRACLOUD-98123', to: resolvedTarget.secondaryIssueKey},
  ]);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toContainText(resolvedTarget.primaryIssueKey);
  return {page, target: resolvedTarget};
}

async function pasteImageIntoTextarea(locator) {
  await locator.evaluate((element, bytes) => {
    const file = new File([new Uint8Array(bytes)], 'paste.png', {type: 'image/png'});
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const event = typeof ClipboardEvent === 'function'
      ? new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: dataTransfer})
      : new Event('paste', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'clipboardData', {
      value: dataTransfer,
    });
    Object.defineProperty(event, 'originalEvent', {
      value: {clipboardData: dataTransfer},
    });
    element.dispatchEvent(event);
  }, TEST_PNG_BYTES);
}

async function expectMentionMenuNearTextareaCaret(inputLocator, menuLocator) {
  const [inputBox, menuBox] = await Promise.all([
    inputLocator.boundingBox(),
    menuLocator.boundingBox(),
  ]);

  if (!inputBox || !menuBox) {
    throw new Error('Expected both the textarea and mention menu to have bounding boxes.');
  }

  expect(menuBox.y).toBeGreaterThan(inputBox.y + 8);
  expect(menuBox.y).toBeLessThan(inputBox.y + inputBox.height - 8);
}

test('renders Jira metadata, comments, attachments, pull requests, and custom fields', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  if (target.mode === 'mock') {
    await expect(popup).toContainText('Pressing END removes non-command text');
    await expect(popup).toContainText('Medium');
    await expect(popup).toContainText('Sprint 42');
    await expect(popup).toContainText('Customer impact: High');
    await expect(popup).toContainText('Initial comment with a link');
    await expect(popup).toContainText('Fix slash command cursor behavior');
    await expect(page.locator('._JX_thumb').first()).toBeVisible();
  } else {
    const issue = await getLiveIssue(resolvedTarget.primaryIssueKey, resolvedTarget);
    await expect(popup).toContainText(issue.fields.summary);
    if (issue.fields.priority?.name) {
      await expect(popup).toContainText(issue.fields.priority.name);
    }
    if ((issue.renderedFields?.comment?.comments || []).length) {
      await expect(page.locator('._JX_comment').first()).toBeVisible();
    }
    if ((issue.fields.attachment || []).length) {
      await expect(page.locator('._JX_attachment, ._JX_thumb').first()).toBeVisible();
    }
  }
  await page.close();
});

test('keeps editable custom fields visible when they are currently empty @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Empty custom field placeholder coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+(?:\\?.*)?$', payload => ({
    ...payload,
    names: {
      ...payload.names,
      customfield_22222: 'Customer Tier',
    },
    fields: {
      ...payload.fields,
      customfield_22222: null,
    },
  }));
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => ({
    ...payload,
    fields: {
      ...payload.fields,
      customfield_22222: {
        required: false,
        name: 'Customer Tier',
        key: 'customfield_22222',
        schema: {
          type: 'option',
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select',
        },
        operations: ['set'],
        allowedValues: [
          {id: '20001', value: 'Gold'},
          {id: '20002', value: 'Silver'},
        ],
      },
    },
  }));
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_22222', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('Customer Tier: --');
  await expect(page.locator('button[data-field-key="customfield_22222"]')).toBeVisible();

  await page.close();
});

test('supports search-based editing for user picker custom fields @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'User-picker custom field coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+(?:\\?.*)?$', payload => ({
    ...payload,
    names: {
      ...payload.names,
      customfield_54321: 'Approver',
    },
    fields: {
      ...payload.fields,
      customfield_54321: null,
    },
  }));
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', payload => ({
    ...payload,
    fields: {
      ...payload.fields,
      customfield_54321: {
        required: false,
        name: 'Approver',
        key: 'customfield_54321',
        schema: {
          type: 'user',
          custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker',
        },
        operations: ['set'],
      },
    },
  }));
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_54321', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('Approver: --');
  await page.locator('button[data-field-key="customfield_54321"]').click();
  await page.locator('input[data-field-key="customfield_54321"]').fill('Alex');
  const alexOption = page.locator('button[data-field-key="customfield_54321"]').filter({hasText: 'Alex Reviewer'}).first();
  await expect(alexOption).toBeVisible();

  await page.close();
});

test('renders text custom fields with a plain prefilled input instead of select-style search UI @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Text custom field coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+\\?fields=[^#]+$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    return {
      ...payload,
      names: {
        ...payload.names,
        customfield_12345: 'CustomTextField',
      },
      fields: {
        ...payload.fields,
        customfield_12345: payload.fields?.customfield_12345 === 'Customer impact: High'
          ? 'Sun is shining!'
          : payload.fields?.customfield_12345,
      },
    };
  });
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    return {
      ...payload,
      fields: {
        ...payload.fields,
        customfield_12345: {
          required: false,
          name: 'CustomTextField',
          key: 'customfield_12345',
          schema: {
            type: 'string',
            custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
          },
          operations: ['set'],
        },
      },
    };
  });
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'customfield_12345', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('CustomTextField: Sun is shining!');
  await page.locator('button[data-field-key="customfield_12345"]').click();

  const input = page.locator('input[data-field-key="customfield_12345"]');
  const options = page.locator('button[data-field-key="customfield_12345"]._JX_edit_option');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('Sun is shining!');
  await expect(input).toHaveAttribute('placeholder', 'Type customtextfield');
  await expect(options).toHaveCount(0);

  await input.fill('Rain is coming');
  await input.press('Enter');
  await expect(popup.root).toContainText('CustomTextField: Rain is coming');

  await page.close();
});

test('supports editing non-custom Jira fields added through popup layout configuration @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'System field layout coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  const resolutionOptions = [
    {id: '1', name: 'Done'},
    {id: '2', name: "Won't Fix"},
  ];
  let currentResolution = null;

  await optionsPage.context().route(jiraApiPattern(target.instanceUrl, '/rest/api/2/issue/[^/]+(?:\\?.*)?$'), async route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      const payload = JSON.parse(request.postData() || '{}');
      const nextResolutionId = String(payload?.fields?.resolution?.id || '');
      currentResolution = resolutionOptions.find(option => option.id === nextResolutionId) || null;
      await route.fulfill({
        status: 204,
        headers: {'access-control-allow-origin': '*'},
        body: '',
      });
      return;
    }

    const response = await route.fetch();
    const payload = await response.json();
    await route.fulfill({
      status: response.status(),
      headers: {
        ...response.headers(),
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        ...payload,
        names: {
          ...payload.names,
          resolution: 'Resolution',
        },
        fields: {
          ...payload.fields,
          resolution: currentResolution,
        },
      }),
    });
  });

  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    return {
      ...payload,
      fields: {
        ...payload.fields,
        resolution: {
          required: false,
          name: 'Resolution',
          key: 'resolution',
          schema: {
            type: 'option',
          },
          operations: ['set'],
          allowedValues: resolutionOptions,
        },
      },
    };
  });

  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: [{fieldId: 'resolution', row: 2}],
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await expect(popup.root).toContainText('Resolution: --');
  await popup.editButton('resolution').click();
  const doneOption = popup.editOptions('resolution').filter({hasText: 'Done'}).first();
  await expect(doneOption).toBeVisible();
  await doneOption.click();
  await popup.editInput('resolution').press('Enter');

  await expect(popup.root).toContainText('Resolution updated');
  await expect(popup.root).toContainText('Resolution: Done');

  await page.close();
});

test('always shows the Description section and saves plain text edits through reopen in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description editor coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  let forceInitialEmptyDescription = true;
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+\\?fields=[^#]+$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    if (!forceInitialEmptyDescription) {
      return payload;
    }
    forceInitialEmptyDescription = false;
    return {
      ...payload,
      fields: {
        ...payload.fields,
        description: null,
      },
      renderedFields: {
        ...payload.renderedFields,
        description: '',
      },
    };
  });
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^/]+/editmeta(?:\\?.*)?$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    return {
      ...payload,
      fields: {
        ...payload.fields,
        description: {
          name: 'Description',
          operations: ['set'],
          schema: {type: 'string'},
        },
      },
    };
  });
  await configureExtension(optionsPage, buildExtensionConfig(servers, {
    customFields: target.mode === 'mock' ? [{fieldId: 'customfield_12345', row: 2}] : [],
    tooltipLayout: {
      row1: ['issueType', 'status', 'priority'],
      row2: ['epicParent', 'sprint', 'affects', 'fixVersions'],
      row3: ['environment', 'labels'],
      contentBlocks: ['timeTracking', 'pullRequests', 'comments'],
      people: ['reporter', 'assignee'],
    },
  }, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);
  const descriptionBlock = page.locator('[data-content-block="description"]');

  await expect(descriptionBlock).toContainText('Description');
  await expect(page.getByTestId('jira-popup-description-empty')).toContainText('No description yet.');

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await expect(input).toBeVisible();
  await input.fill('This task needs more context.');
  await page.getByTestId('jira-popup-description-save').click();

  await expect(page.getByTestId('jira-popup-description-status')).toContainText('Description updated');
  await expect(page.getByTestId('jira-popup-description-rendered')).toContainText('This task needs more context.');

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(popup.root).toContainText('JRACLOUD-97846');
  await expect(page.getByTestId('jira-popup-description-rendered')).toContainText('This task needs more context.');

  await page.close();
});

test('keeps the Description section visible after clearing it in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description editor coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const descriptionBlock = page.locator('[data-content-block="description"]');

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('');
  await page.getByTestId('jira-popup-description-save').click();

  await expect(page.getByTestId('jira-popup-description-status')).toContainText('Description cleared');
  await expect(descriptionBlock).toContainText('Description');
  await expect(page.getByTestId('jira-popup-description-empty')).toContainText('No description yet.');

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(descriptionBlock).toContainText('Description');
  await expect(page.getByTestId('jira-popup-description-empty')).toContainText('No description yet.');

  await page.close();
});

test('saves Description rich formatting through toolbar actions in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description rich-text coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const descriptionBlock = page.locator('[data-content-block="description"]');
  await page.getByTestId('jira-popup-description-edit').click();

  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('This task needs what?');
  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(5, 9);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="bold"]').click();

  await input.evaluate(element => {
    const start = element.value.indexOf('what');
    element.focus();
    element.setSelectionRange(start, start + 4);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="italic"]').click();
  await page.getByTestId('jira-popup-description-save').click();

  await expect(descriptionBlock.locator('strong', {hasText: 'task'})).toHaveCount(1);
  await expect(descriptionBlock.locator('em', {hasText: 'what'})).toHaveCount(1);

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(descriptionBlock.locator('strong', {hasText: 'task'})).toHaveCount(1);
  await expect(descriptionBlock.locator('em', {hasText: 'what'})).toHaveCount(1);

  await page.getByTestId('jira-popup-description-edit').click();
  await expect(page.getByTestId('jira-popup-description-input')).toHaveValue('This *task* needs _what_?');

  await page.close();
});

test('applies inline Description formatting line by line for multiline selections in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description multiline formatting coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const descriptionBlock = page.locator('[data-content-block="description"]');

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('blu\nblu2\nblu3');
  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(0, element.value.length);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="italic"]').click();
  await expect(input).toHaveValue('_blu_\n_blu2_\n_blu3_');
  await expect(input).toHaveJSProperty('selectionStart', 0);
  await expect(input).toHaveJSProperty('selectionEnd', '_blu_\n_blu2_\n_blu3_'.length);
  await page.getByTestId('jira-popup-description-save').click();

  await expect(descriptionBlock.locator('em')).toHaveText(['blu', 'blu2', 'blu3']);

  await page.getByTestId('jira-popup-description-edit').click();
  await expect(page.getByTestId('jira-popup-description-input')).toHaveValue('_blu_\n_blu2_\n_blu3_');

  await page.close();
});

test('preserves a leading newline when editing Description in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description leading-newline coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('bla');
  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(0, 0);
  });
  await input.press('Enter');

  await expect(input).toHaveValue('\nbla');
  await expect(input).toHaveJSProperty('selectionStart', 1);
  await expect(input).toHaveJSProperty('selectionEnd', 1);

  await page.close();
});

test('preserves existing Description images when saving rich-text edits in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description rich-text image coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  let forceInitialRichDescription = true;
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+\\?fields=[^#]+$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    const payloadWithAttachment = {
      ...payload,
      fields: {
        ...payload.fields,
        attachment: [
          ...(payload.fields?.attachment || []),
          {
            id: 'attachment-001',
            filename: 'image-20260330-204037.png',
            mimeType: 'image/png',
            content: `${target.instanceUrl}rest/api/2/attachment/content/attachment-001`,
            thumbnail: `${target.instanceUrl}rest/api/2/attachment/thumbnail/attachment-001`,
          },
        ],
      },
    };
    if (!forceInitialRichDescription) {
      return payloadWithAttachment;
    }
    forceInitialRichDescription = false;
    return {
      ...payloadWithAttachment,
      fields: {
        ...payloadWithAttachment.fields,
        description: {
          type: 'doc',
          version: 1,
          content: [
            {
              type: 'paragraph',
              content: [{type: 'text', text: 'This task needs what?'}],
            },
            {
              type: 'mediaSingle',
              content: [
                {
                  type: 'media',
                  attrs: {
                    alt: 'evidence.png',
                    collection: '',
                    id: 'attachment-001',
                    type: 'file',
                  },
                },
              ],
            },
          ],
        },
      },
      renderedFields: {
        ...payload.renderedFields,
        description: `<p>This task needs what?</p><p><img src="${target.instanceUrl}rest/api/2/attachment/content/attachment-001" alt="evidence.png" /></p>`,
      },
    };
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const descriptionBlock = page.locator('[data-content-block="description"]');

  await expect(descriptionBlock.locator('img[alt="evidence.png"]')).toHaveCount(1);
  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await expect(input).toHaveValue('This task needs what?\n\n!evidence.png!');

  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(5, 9);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="bold"]').click();
  await page.getByTestId('jira-popup-description-save').click();

  await expect(page.getByTestId('jira-popup-description-status')).toContainText('Description updated');
  await expect(descriptionBlock.locator('strong', {hasText: 'task'})).toHaveCount(1);
  await expect(descriptionBlock.locator('img[alt="evidence.png"]')).toHaveCount(1);

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(descriptionBlock.locator('strong', {hasText: 'task'})).toHaveCount(1);
  await expect(descriptionBlock.locator('img[alt="evidence.png"]')).toHaveCount(1);

  await page.close();
});

test('preserves wiki-style Description storage when formatting existing image markup in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description rich-text image coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  let savedDescriptionPayload = null;
  await optionsPage.context().route('**/rest/api/2/issue/**', async route => {
    const request = route.request();
    if (
      request.method() === 'PUT' &&
      request.url().includes('/rest/api/2/issue/') &&
      !request.url().includes('/comment') &&
      !request.url().includes('/worklog')
    ) {
      savedDescriptionPayload = JSON.parse(request.postData() || '{}');
    }
    await route.continue();
  });
  await patchJsonResponse(optionsPage.context(), target.instanceUrl, '/rest/api/2/issue/[^?]+\\?fields=[^#]+$', (payload, request) => {
    if (request.method() !== 'GET') {
      return payload;
    }
    return {
      ...payload,
      fields: {
        ...payload.fields,
        attachment: [
          ...(Array.isArray(payload.fields?.attachment) ? payload.fields.attachment : []),
          {
            id: 'attachment-001',
            filename: 'image-20260330-204037.png',
            mimeType: 'image/png',
            content: `${target.instanceUrl}rest/api/2/attachment/content/attachment-001`,
            thumbnail: `${target.instanceUrl}rest/api/2/attachment/thumbnail/attachment-001`,
          },
        ],
        description: 'This task needs what?\n\n!image-20260330-204037.png|width=401,alt="image-20260330-204037.png"!',
      },
      renderedFields: {
        ...payload.renderedFields,
        description: `<p>This task needs what?</p><p><img src="${target.instanceUrl}rest/api/2/attachment/content/attachment-001" alt="image-20260330-204037.png" /></p>`,
      },
    };
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await expect(input).toHaveValue('This task needs what?\n\n!image-20260330-204037.png|width=401,alt="image-20260330-204037.png"!');
  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(0, 4);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="italic"]').click();
  await page.getByTestId('jira-popup-description-save').click();

  await expect(page.getByTestId('jira-popup-description-status')).toContainText('Description updated');
  await expect(page.getByTestId('jira-popup-description-status')).not.toContainText('New pasted images');
  await expect.poll(() => savedDescriptionPayload).not.toBeNull();
  expect(typeof savedDescriptionPayload.fields.description).toBe('string');
  expect(savedDescriptionPayload.fields.description).toContain('_This_ task needs what?');
  expect(savedDescriptionPayload.fields.description).toContain('!image-20260330-204037.png|width=401,alt="image-20260330-204037.png"!');

  await page.close();
});

test('shows inline error feedback when saving the Description fails in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description save failure coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await optionsPage.context().route('**/rest/api/2/issue/**', async route => {
    const request = route.request();
    const url = request.url();
    if (
      request.method() === 'PUT' &&
      url.includes('/rest/api/2/issue/') &&
      !url.includes('/comment') &&
      !url.includes('/worklog')
    ) {
      await route.fulfill({
        status: 500,
        headers: {'content-type': 'application/json; charset=utf-8'},
        body: JSON.stringify({errorMessages: ['Could not update description']}),
      });
      return;
    }
    await route.continue();
  });
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('This description should fail to save.');
  await page.getByTestId('jira-popup-description-save').click();

  await expect(page.getByTestId('jira-popup-description-status')).toContainText('Could not update description');
  await expect(input).toHaveValue('This description should fail to save.');
  await expect(page.getByTestId('jira-popup-description-save')).toHaveText('Save');

  await page.close();
});

test('supports pasted images while editing the Description in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description image coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await pasteImageIntoTextarea(input);
  await expect(input).toHaveValue(/!pasted-image-/);
  await page.getByTestId('jira-popup-description-save').click();

  const renderedImage = page.getByTestId('jira-popup-description-rendered').locator('img._JX_previewable').last();
  await expect(renderedImage).toBeVisible();
  await renderedImage.click();
  const popup = popupModel(page);
  await expect(popup.previewOverlay).toHaveClass(/is-open/);
  await page.keyboard.press('Escape');

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.getByTestId('jira-popup-description-rendered').locator('img._JX_previewable').last()).toBeVisible();

  await page.close();
});

test('supports pasted images together with rich formatting in the Description in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Description image coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);

  await page.getByTestId('jira-popup-description-edit').click();
  const input = page.getByTestId('jira-popup-description-input');
  await input.fill('This task needs context');
  await input.evaluate(element => {
    element.focus();
    element.setSelectionRange(5, 9);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await page.locator('button[data-description-format="bold"]').click();
  await input.evaluate(element => {
    element.setSelectionRange(element.value.length, element.value.length);
    element.dispatchEvent(new Event('select', {bubbles: true}));
  });
  await pasteImageIntoTextarea(input);
  await expect(input).toHaveValue(/\*task\*[\s\S]*!pasted-image-/);
  await page.getByTestId('jira-popup-description-save').click();

  const renderedDescription = page.getByTestId('jira-popup-description-rendered');
  await expect(renderedDescription.locator('strong', {hasText: 'task'})).toHaveCount(1);
  await expect(renderedDescription.locator('img._JX_previewable').last()).toBeVisible();

  await page.close();
});

test('copies the Jira issue link and previews attachment images', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  } else {
    const resolvedTarget = await resolveTargetIssueKeys(target);
    await ensurePreviewAttachment(resolvedTarget.primaryIssueKey, resolvedTarget);
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  await page.locator('._JX_title_copy').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(`browse/${resolvedTarget.primaryIssueKey}`);

  const previewable = page.locator('._JX_previewable');
  await expect.poll(async () => previewable.count(), {timeout: 10000}).toBeGreaterThan(0);
  await previewable.first().click();
  const popup = popupModel(page);
  await expect(popup.previewOverlay).toHaveClass(/is-open/);
  await expect(popup.previewImage).toHaveAttribute('src', /\S+/);
  await page.keyboard.press('Escape');
  await page.close();
});

test('supports quick actions and inline edits against mocked Jira APIs', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = page.locator('._JX_container');

  await page.locator('._JX_actions_toggle').click();
  const assignToMe = page.locator('._JX_action_item[data-action-key="assign-to-me"]');
  if (target.mode === 'mock') {
    await assignToMe.click();
    await expect(popup).toContainText('Assigned to you');
    await expect(page.locator('._JX_title_assignee_slot [title="Assignee: Morgan Agent"]')).toHaveCount(1);

    await page.locator('._JX_field_chip_edit[data-field-key="priority"]').click();
    await page.locator('._JX_edit_option[data-field-key="priority"][data-option-id="1"]').click();
    await page.locator('._JX_edit_input[data-field-key="priority"]').press('Enter');
    await expect(popup).toContainText('Priority set to Highest');
    await expect(popup).toContainText('Highest');

    await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
    const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
    await labelInput.fill('release-candidate');
    await labelInput.press('Enter');
    await page.locator('._JX_edit_save[data-field-key="labels"]').click();
    await expect(popup).toContainText('Labels updated');
    await expect(popup).toContainText('release-candidate');

    await page.locator('._JX_field_chip_edit[data-field-key="status"]').click();
    await page.locator('._JX_edit_option[data-field-key="status"][data-option-id="31"]').click();
    await expect(popup).toContainText('Status moved to In Progress');
    await expect(popup).toContainText('In Progress');
  } else {
    const actionItems = page.locator('._JX_action_item');
    test.skip(await actionItems.count() < 1, 'No quick actions are available for this live Jira issue.');
    await expect(page.locator('._JX_field_chip_edit[data-field-key="priority"]')).toHaveCount(1);
    await expect(page.locator('._JX_field_chip_edit[data-field-key="labels"]')).toHaveCount(1);
    await expect(page.locator('._JX_field_chip_edit[data-field-key="status"]')).toHaveCount(1);
    if (await assignToMe.count()) {
      await expect(assignToMe).toContainText(/Assign to me/i);
    }
  }

  await page.close();
});

test('toggles the top filtered multi-select option with Enter in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Multi-select keyboard coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page);

  await page.locator('._JX_field_chip_edit[data-field-key="labels"]').click();
  const labelInput = page.locator('._JX_edit_input[data-field-key="labels"]');
  await labelInput.fill('release-candidate');
  await labelInput.press('Enter');
  await page.locator('._JX_edit_save[data-field-key="labels"]').click();

  await expect(popup.root).toContainText('Labels updated');
  await expect(popup.root).toContainText('release-candidate');

  await page.close();
});

test('adds and removes watchers from the popup panel in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Watcher mutation coverage currently uses the mock Jira server only.');
  await servers.jira.setScenario('watcher-self-off');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const trigger = page.locator('._JX_watchers_trigger');
  await expect(trigger).toContainText('1');
  await expect(trigger).not.toHaveClass(/is-watching/);

  await trigger.click();
  const searchInput = page.locator('._JX_watchers_search_input');
  await expect(searchInput).toBeVisible();
  await searchInput.fill('Morgan');
  await expect(page.locator('._JX_watchers_search_result[data-watcher-id="user-me"]')).toBeVisible();
  await page.locator('._JX_watchers_search_result[data-watcher-id="user-me"]').click();

  await expect(trigger).toContainText('2');
  await expect(trigger).toHaveClass(/is-watching/);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent added to watchers'})).toBeVisible();
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-me"]')).toBeVisible();
  await page.waitForTimeout(5200);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent added to watchers'})).toHaveCount(0);

  await searchInput.fill('Alex');
  await expect(page.locator('._JX_watchers_search_result[data-watcher-id="user-alex"]')).toHaveCount(0);

  const myRow = page.locator('._JX_watchers_row[data-watcher-id="user-me"]');
  await myRow.hover();
  await myRow.locator('._JX_watchers_remove').click();

  await expect(trigger).toContainText('1');
  await expect(trigger).not.toHaveClass(/is-watching/);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent removed from watchers'})).toBeVisible();
  await expect(page.locator('._JX_watchers_row[data-watcher-id="user-me"]')).toHaveCount(0);
  await page.waitForTimeout(5200);
  await expect(page.locator('._JX_watchers_feedback_row').filter({hasText: 'Morgan Agent removed from watchers'})).toHaveCount(0);
  await page.close();
});

test('groups history entries and nests referenced attachments inside expanded comments in mocked mode', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'History flyout coverage currently uses the mock Jira server only.');
  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const activityStrip = page.locator('._JX_activity_strip');
  await expect(activityStrip.locator('._JX_activity_item')).toHaveCount(1);
  await expect(activityStrip.locator('._JX_watchers_trigger')).toHaveCount(1);

  const historyTrigger = page.locator('._JX_history_toggle');
  await expect(historyTrigger).toHaveAttribute('title', 'View change history');

  await historyTrigger.click();

  const flyout = page.locator('._JX_history_flyout');
  await expect(flyout).toBeVisible();
  await expect(historyTrigger.locator('strong')).toHaveCount(0);

  await expect(flyout.locator('._JX_history_entry')).toHaveCount(3);
  const plainCommentEvent = flyout.locator('._JX_history_rich_event_comment').filter({hasText: 'Initial comment with a link'});
  await expect(plainCommentEvent).toHaveCount(1);
  const attachmentCommentEvent = flyout.locator('._JX_history_rich_event_comment').filter({hasText: 'Testirano na internom testnom okruzenju'});
  await expect(attachmentCommentEvent).toHaveCount(1);
  await expect(attachmentCommentEvent.locator('._JX_history_rich_preview')).toContainText('Testirano na internom testnom okruzenju');
  await expect(attachmentCommentEvent).toContainText('2 attachments');
  await expect(flyout).not.toContainText('Worklog ID');
  await expect(flyout).toContainText('Time estimate:');
  await expect(flyout).not.toContainText('timeestimate:');

  await expect(flyout.locator('._JX_history_change').filter({hasText: 'image-2026-03-17-10-47-20-728.png'})).toHaveCount(0);
  await expect(flyout.locator('._JX_history_change').filter({hasText: 'image-2026-03-17-10-48-30-600.png'})).toHaveCount(0);
  await expect(flyout.locator('._JX_history_change').filter({hasText: 'standalone-graph.png'})).toHaveCount(1);

  await attachmentCommentEvent.locator('summary').click();
  await expect(attachmentCommentEvent.locator('._JX_history_attachment_item')).toHaveCount(2);
  await expect(attachmentCommentEvent.locator('._JX_history_rich_section_body')).toContainText('Prikaz bi trebao biti izjednacen');
  await expect(flyout).toContainText('10m');

  const descriptionEvent = flyout.locator('._JX_history_rich_event_description').first();
  await descriptionEvent.locator('summary').click();
  const descriptionBody = descriptionEvent.locator('._JX_history_rich_section_body');
  await expect(descriptionBody).toContainText('Updated rollout checklist for JRACLOUD-97000');
  await expect(descriptionBody.locator('strong', {hasText: 'A DESCRIPTION'})).toHaveCount(1);
  await expect(descriptionBody.locator('u', {hasText: 'and a rich one!'})).toHaveCount(1);
  await expect(descriptionBody.locator('em', {hasText: 'and a rich one!'})).toHaveCount(1);
  await expect(descriptionBody).toContainText('With images:');
  await expect(descriptionBody.locator('img._JX_previewable[alt="standalone-graph.png"]')).toHaveCount(1);
  await expect(flyout.locator('a._JX_history_issue_link', {hasText: 'JRACLOUD-97000'}).first()).toHaveAttribute('href', /browse\/JRACLOUD-97000$/);

  await page.keyboard.press('Escape');
  await expect(page.locator('._JX_history_flyout')).toHaveCount(0);
  await expect(page.locator('._JX_title')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.locator('._JX_title')).toHaveCount(0);

  await page.close();
});

test('reopens history after closing it while changelog is still loading in mocked mode', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'History flyout loading coverage currently uses the mock Jira server only.');
  await servers.jira.setScenario('editable-slow-changelog');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const historyTrigger = page.locator('._JX_history_toggle');

  await historyTrigger.click();
  await expect(page.locator('._JX_history_loading')).toBeVisible();

  await page.locator('body').click({position: {x: 10, y: 10}});
  await expect(page.locator('._JX_history_flyout')).toHaveCount(0);

  await page.waitForTimeout(350);

  await historyTrigger.click();
  await expect(page.locator('._JX_history_entry')).toHaveCount(3);
  await expect(page.locator('._JX_history_loading')).toHaveCount(0);

  await page.close();
});

test('supports mentions and saving new comments in mocked mode', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  if (target.mode === 'mock') {
    await servers.jira.setScenario('editable');
  }
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page, target: resolvedTarget} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  const mentionQuery = target.mode === 'mock' ? 'mor' : 'ge';
  if (target.mode === 'live') {
    const mentionUsers = await getMentionUsers(mentionQuery, target);
    test.skip(!mentionUsers.length, 'No mention suggestions are available for the live Jira tenant.');
  }
  await commentInput.fill(`@${mentionQuery}`);
  await expect(page.locator('._JX_comment_mention_option').first()).toBeVisible();
  if (target.mode === 'mock') {
    await expectMentionMenuNearTextareaCaret(commentInput, page.locator('._JX_comment_compose ._JX_comment_mentions'));
    await page.locator('._JX_comment_compose ._JX_comment_mention_option', {hasText: 'Morgan Agent'}).click();
  } else {
    await commentInput.press('ArrowDown');
    await commentInput.press('Enter');
  }
  if (target.mode === 'mock') {
    await expect(commentInput).toHaveValue('@Morgan Agent ');
    await expect(commentInput).not.toHaveValue(/\[~/);
  }
  const commentText = ` Investigated and reproduced locally. [playwright-${Date.now()}]`;
  await commentInput.type(commentText);

  const existingCommentIds = target.mode === 'live'
    ? new Set((await getIssueComments(resolvedTarget.primaryIssueKey, resolvedTarget)).map(comment => String(comment.id)))
    : null;

  await page.locator('._JX_comment_save').click();

  const newestComment = page.locator('._JX_comment').last();
  await expect(newestComment).toContainText('Investigated and reproduced locally.');
  if (target.mode === 'mock') {
    await expect(newestComment.locator('._JX_mention')).toContainText('Morgan Agent');
    const [existingCommentFontSize, newestCommentFontSize] = await Promise.all([
      page.locator('._JX_comment').first().locator('._JX_comment_body').evaluate(node => window.getComputedStyle(node).fontSize),
      newestComment.locator('._JX_comment_body').evaluate(node => window.getComputedStyle(node).fontSize),
    ]);
    expect(newestCommentFontSize).toBe(existingCommentFontSize);
    await page.locator('._JX_history_toggle').click();
    await expect(page.locator('._JX_history_rich_preview').first()).toContainText('@Morgan Agent');
  }

  if (target.mode === 'live') {
    const nextComments = await getIssueComments(resolvedTarget.primaryIssueKey, resolvedTarget);
    const createdComment = nextComments.find(comment => !existingCommentIds.has(String(comment.id)) && String(comment.body || '').includes('[playwright-'));
    if (createdComment?.id) {
      await deleteIssueComment(resolvedTarget.primaryIssueKey, createdComment.id, resolvedTarget);
    }
  }
  await page.close();
});

test('silently pins the popup when starting a new comment so pointer exit does not dismiss it @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Comment draft pinning is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page).root;
  const commentInput = page.locator('._JX_comment_input');

  await commentInput.click();
  await commentInput.fill('Draft comment that should stay open');

  await expect(page.locator('._JX_container')).toHaveClass(/container-pinned/);
  await expect(page.locator('body')).not.toContainText('Ticket Pinned! Hit esc to close !');

  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);

  await expect(popup).toBeVisible();
  await expect(commentInput).toHaveValue('Draft comment that should stay open');
  await page.close();
});

test('supports user tagging while editing comments in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Edit mention coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  await commentInput.fill('editable mention test');
  await page.locator('._JX_comment_save').click();

  const newestComment = page.locator('._JX_comment').last();
  await newestComment.locator('._JX_comment_edit_button').click();
  const editInput = newestComment.locator('._JX_comment_edit_input');
  await editInput.fill(`${await editInput.inputValue()} @ale`);
  await expect(page.locator('._JX_comment_edit_mention_option').first()).toBeVisible();
  await expectMentionMenuNearTextareaCaret(editInput, newestComment.locator('._JX_comment_edit_mentions'));
  await page.locator('._JX_comment_edit_mention_option', {hasText: 'Alex Reviewer'}).click();
  await expect(editInput).toHaveValue(/@Alex Reviewer/);
  await expect(editInput).not.toHaveValue(/\[~/);
  await newestComment.locator('._JX_comment_edit_save').click();

  await expect(page.locator('._JX_comment').last()).toContainText('Alex Reviewer');
  await expect(page.locator('._JX_comment').last().locator('._JX_mention')).toContainText('Alex Reviewer');

  await page.close();
});

test('silently pins the popup when editing a comment so pointer exit does not dismiss it @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Comment edit pinning is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const popup = popupModel(page).root;
  const composer = page.locator('._JX_comment_input');
  await composer.fill('Owned comment that will enter edit mode');
  await page.locator('._JX_comment_save').click();

  const comment = page.locator('._JX_comment').last();
  await expect(comment.locator('._JX_comment_edit_button')).toBeVisible();

  await comment.locator('._JX_comment_edit_button').click();

  const editInput = comment.locator('._JX_comment_edit_input');
  await editInput.fill('Edited comment draft that should stay open');

  await expect(page.locator('._JX_container')).toHaveClass(/container-pinned/);
  await expect(page.locator('body')).not.toContainText('Ticket Pinned! Hit esc to close !');

  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);

  await expect(popup).toBeVisible();
  await expect(editInput).toHaveValue('Edited comment draft that should stay open');
  await page.close();
});

test('preserves literal text when editing comments that already contain mentions in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Mention edit coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const commentInput = page.locator('._JX_comment_input');
  await commentInput.fill('@mor');
  await expect(page.locator('._JX_comment_mention_option').first()).toBeVisible();
  await commentInput.press('ArrowDown');
  await commentInput.press('Enter');
  await commentInput.type(' mentioned once.');
  await page.locator('._JX_comment_save').click();

  const newestComment = page.locator('._JX_comment').last();
  await expect(newestComment.locator('._JX_mention')).toHaveCount(1);

  await newestComment.locator('._JX_comment_edit_button').click();
  const editInput = newestComment.locator('._JX_comment_edit_input');
  const originalDraft = await editInput.inputValue();
  await expect(editInput).toHaveValue(/@Morgan Agent/);
  await editInput.fill(`Literal @Morgan Agent\n${originalDraft}`);
  await newestComment.locator('._JX_comment_edit_save').click();

  const savedComment = page.locator('._JX_comment').last();
  await expect(savedComment.locator('._JX_mention')).toHaveCount(1);
  await expect(savedComment.locator('._JX_comment_body')).toContainText('Literal @Morgan Agent');
  await expect(savedComment.locator('._JX_comment_body')).toContainText('mentioned once.');

  await page.close();
});

test('preserves rendered formatting for comments with attachment markup in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Rendered comment formatting coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const formattedComment = page.locator('._JX_comment').filter({hasText: 'Prikaz bi trebao biti izjednacen'}).first();

  await expect(formattedComment.locator('strong')).toContainText('nije dobar');

  await page.close();
});

test('uploads a pasted image into the comment composer in mocked mode @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: process.env.MOCK === 'false'});
  test.skip(target.mode !== 'mock', 'Pasted-image upload coverage is deterministic in mocked mode only.');

  await servers.jira.setScenario('editable');
  await configureExtension(optionsPage, baseConfig(servers, target));

  const {page} = await openPopup(extensionApp, servers, target);
  const persistedCommentText = `Persisted attachment preview ${Date.now()}`;
  await pasteImageIntoTextarea(page.locator('._JX_comment_input'));
  await page.locator('._JX_comment_input').type(`\n\n${persistedCommentText}`);

  await expect(page.locator('._JX_comment_upload_status')).toContainText('Attached to issue');
  await expect(page.locator('._JX_comment_input')).toHaveValue(/!pasted-image.*\.png!/);

  const uploadedFileName = await page.locator('._JX_comment_upload_name').textContent();
  const attachmentThumb = page.locator('._JX_thumb').filter({hasText: uploadedFileName || ''}).locator('img._JX_previewable');
  await expect(attachmentThumb).toHaveCount(1);
  await expect(attachmentThumb).toHaveAttribute('src', /^data:image\//);

  await page.locator('._JX_comment_save').click();
  const savedComment = page.locator('._JX_comment').last();
  const savedCommentImage = savedComment.locator('img._JX_previewable');
  await expect(savedComment).toContainText(persistedCommentText);
  await expect(savedCommentImage).toHaveCount(1);
  await expect(savedCommentImage).toHaveAttribute('src', /^data:image\//);

  await savedCommentImage.click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\//);
  await page.locator('._JX_preview_overlay').click({position: {x: 8, y: 8}});
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);

  await page.locator('._JX_history_toggle').click();
  const commentImageAfterHistoryOpen = page.locator(`._JX_comment img._JX_previewable[alt="${uploadedFileName || ''}"]`);
  await expect(commentImageAfterHistoryOpen).toHaveCount(1);
  const uploadedHistoryAttachment = page.locator('button._JX_history_attachment_preview', {hasText: uploadedFileName || ''}).first();
  await expect(uploadedHistoryAttachment).toHaveCount(1);
  await page.locator('._JX_history_flyout details').filter({hasText: persistedCommentText}).first().locator('summary').click();
  const historyAttachmentInlinePreview = page.locator(`._JX_history_attachment_item img._JX_previewable[alt="${uploadedFileName || ''}"]`).first();
  await expect(historyAttachmentInlinePreview).toHaveCount(1);
  await expect(historyAttachmentInlinePreview).toHaveAttribute('src', /^data:image\//);
  await uploadedHistoryAttachment.click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\//);
  await page.locator('._JX_preview_overlay').click({position: {x: 8, y: 8}});

  await page.locator('._JX_close_button').click();
  await expect(page.locator('._JX_title')).toHaveCount(0);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toContainText('JRACLOUD-97846');

  const samePageReopenedComment = page.locator('._JX_comment').filter({hasText: persistedCommentText}).last();
  const samePageReopenedCommentImage = samePageReopenedComment.locator(`img._JX_previewable[alt="${uploadedFileName || ''}"]`);
  await expect(samePageReopenedCommentImage).toHaveCount(1);
  await expect(samePageReopenedCommentImage).toHaveAttribute('src', /^data:image\//);
  await page.locator('._JX_history_toggle').click();
  const samePageReopenedHistoryEvent = page.locator('._JX_history_rich_event_comment').filter({hasText: persistedCommentText}).first();
  await expect(samePageReopenedHistoryEvent).toHaveCount(1);
  await samePageReopenedHistoryEvent.locator('summary').click();
  const samePageReopenedHistoryImage = samePageReopenedHistoryEvent.locator(`img._JX_previewable[alt="${uploadedFileName || ''}"]`);
  await expect(samePageReopenedHistoryImage).toHaveCount(1);
  await expect(samePageReopenedHistoryImage).toHaveAttribute('src', /^data:image\//);

  await page.goto(`${servers.allowedPage.origin}/popup-actions`);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  await hoverIssueKey(page, '#popup-key');
  await expect(page.locator('._JX_container')).toContainText('JRACLOUD-97846');

  const reopenedComment = page.locator('._JX_comment').filter({hasText: persistedCommentText}).last();
  const reopenedCommentImage = reopenedComment.locator(`img._JX_previewable[alt="${uploadedFileName || ''}"]`);
  await expect(reopenedCommentImage).toHaveCount(1);
  await expect(reopenedCommentImage).toHaveAttribute('src', /^data:image\//);
  await reopenedCommentImage.click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\//);
  await page.locator('._JX_preview_overlay').click({position: {x: 8, y: 8}});

  await page.locator('._JX_history_toggle').click();
  const reopenedHistoryEvent = page.locator('._JX_history_rich_event_comment').filter({hasText: persistedCommentText}).first();
  await expect(reopenedHistoryEvent).toHaveCount(1);
  await reopenedHistoryEvent.locator('summary').click();
  const reopenedHistoryInlinePreview = reopenedHistoryEvent.locator(`img._JX_previewable[alt="${uploadedFileName || ''}"]`);
  await expect(reopenedHistoryInlinePreview).toHaveCount(1);
  await expect(reopenedHistoryInlinePreview).toHaveAttribute('src', /^data:image\//);
  const reopenedHistoryAttachment = reopenedHistoryEvent.locator('button._JX_history_attachment_preview', {hasText: uploadedFileName || ''}).first();
  await expect(reopenedHistoryAttachment).toHaveCount(1);
  await reopenedHistoryAttachment.click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\//);

  await page.close();
});
