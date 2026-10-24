const {test, expect, configureExtension, injectContentScript} = require('./helpers/extension-fixtures');
const {buildExtensionConfig, requireJiraTestTarget} = require('./helpers/test-targets');

function attachmentPreviewConfig(servers, target, overrides = {}) {
  return {
    ...buildExtensionConfig(servers, {}, target),
    hoverActivationMode: 'off',
    hoverModifierKey: 'any',
    openQuickViewOnClick: false,
    openAttachmentPreviews: true,
    ...overrides,
  };
}

function jiraBaseUrl(target) {
  return String(target.instanceUrl || '').replace(/\/?$/, '/');
}

async function openAttachmentFixturePage(extensionApp, servers, configure) {
  const page = await extensionApp.context.newPage();
  await page.goto(`${servers.allowedPage.origin}/attachment-links`);
  if (configure) {
    await configure(page);
  }
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);
  return page;
}

async function setLinkHref(page, selector, href) {
  await page.locator(selector).evaluate((link, nextHref) => {
    link.setAttribute('href', nextHref);
  }, href);
}

async function clickAndReportDefaultPrevented(locator, options = {}) {
  return locator.evaluate((link, eventInit) => new Promise(resolve => {
    link.addEventListener('click', event => {
      resolve(event.defaultPrevented);
      event.preventDefault();
    }, {once: true});
    link.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      ...eventInit,
    }));
  }), options);
}

test('previews a direct Jira image attachment link on an allowed page @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const secureUrl = `${jiraBaseUrl(target)}secure/attachment/900/evidence.png`;
  const page = await openAttachmentFixturePage(extensionApp, servers, fixturePage => {
    return setLinkHref(fixturePage, '#attachment-secure-image', secureUrl);
  });
  const originalUrl = page.url();

  await page.locator('#attachment-secure-image').click();

  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\/png/);
  expect(page.url()).toBe(originalUrl);

  await page.locator('._JX_preview_overlay').click({position: {x: 8, y: 8}});
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await page.close();
});

test('resolves REST attachment content links through attachment metadata @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const contentUrl = `${jiraBaseUrl(target)}rest/api/2/attachment/content/900`;
  const page = await openAttachmentFixturePage(extensionApp, servers, fixturePage => {
    return setLinkHref(fixturePage, '#attachment-content-image', contentUrl);
  });
  const originalUrl = page.url();

  await page.locator('#attachment-content-image').click();

  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\/png/);
  expect(page.url()).toBe(originalUrl);
  await page.close();
});

test('unwraps Gmail and Outlook Safe Links wrappers @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const secureUrl = `${jiraBaseUrl(target)}secure/attachment/900/evidence.png`;
  const contentUrl = `${jiraBaseUrl(target)}rest/api/2/attachment/content/900`;
  const googleWrappedUrl = `https://www.google.com/url?q=${encodeURIComponent(secureUrl)}&source=gmail&ust=1`;
  const outlookWrappedUrl = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent(contentUrl)}&data=abc&reserved=0`;
  const page = await openAttachmentFixturePage(extensionApp, servers, async fixturePage => {
    await setLinkHref(fixturePage, '#attachment-wrapped-image', googleWrappedUrl);
    await setLinkHref(fixturePage, '#attachment-secure-image', outlookWrappedUrl);
  });
  const originalUrl = page.url();

  await page.locator('#attachment-wrapped-image').click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\/png/);
  await page.locator('._JX_preview_overlay').click({position: {x: 8, y: 8}});
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);

  await page.locator('#attachment-secure-image').click();
  await expect(page.locator('._JX_preview_overlay')).toHaveClass(/is-open/);
  await expect(page.locator('._JX_preview_image')).toHaveAttribute('src', /^data:image\/png/);
  expect(page.url()).toBe(originalUrl);
  await page.close();
});

test('keeps PDF attachment links native @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const pdfUrl = `${jiraBaseUrl(target)}secure/attachment/904/release-notes.pdf`;
  const page = await openAttachmentFixturePage(extensionApp, servers, fixturePage => {
    return setLinkHref(fixturePage, '#attachment-pdf', pdfUrl);
  });

  await page.locator('#attachment-pdf').click();

  await expect(page).toHaveURL(pdfUrl);
  await expect(page.locator('._JX_preview_overlay')).toHaveCount(0);
  await page.close();
});

test('opens non-image REST attachment links in a tab @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const textUrl = `${jiraBaseUrl(target)}rest/api/2/attachment/content/905`;
  const page = await openAttachmentFixturePage(extensionApp, servers, fixturePage => {
    return setLinkHref(fixturePage, '#attachment-pdf', textUrl);
  });

  const tabPromise = extensionApp.context.waitForEvent('page');
  await page.locator('#attachment-pdf').click();
  const openedTab = await tabPromise;
  await expect(openedTab).toHaveURL(textUrl);
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await openedTab.close();
  await page.close();
});

test('leaves modifier-click and download links native @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target));

  const secureUrl = `${jiraBaseUrl(target)}secure/attachment/900/evidence.png`;
  const page = await openAttachmentFixturePage(extensionApp, servers, async fixturePage => {
    await setLinkHref(fixturePage, '#attachment-download', secureUrl);
    await setLinkHref(fixturePage, '#attachment-secure-image', secureUrl);
  });

  const modifierPrevented = await clickAndReportDefaultPrevented(
    page.locator('#attachment-secure-image'),
    {ctrlKey: true}
  );
  expect(modifierPrevented).toBe(false);

  const downloadPrevented = await clickAndReportDefaultPrevented(page.locator('#attachment-download'));
  expect(downloadPrevented).toBe(false);
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await page.close();
});

test('leaves attachment links native when the option is off @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target, {
    openAttachmentPreviews: false,
  }));

  const secureUrl = `${jiraBaseUrl(target)}secure/attachment/900/evidence.png`;
  const page = await openAttachmentFixturePage(extensionApp, servers, fixturePage => {
    return setLinkHref(fixturePage, '#attachment-secure-image', secureUrl);
  });

  const prevented = await clickAndReportDefaultPrevented(page.locator('#attachment-secure-image'));
  expect(prevented).toBe(false);
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await page.close();
});

test('keeps Jira native attachment behavior on the Jira site @mock-only', async ({extensionApp, optionsPage, servers}) => {
  const target = requireJiraTestTarget(test, servers, {requireAuth: false});
  test.skip(target.mode !== 'mock', 'Attachment previews are deterministic in mocked mode only.');
  await configureExtension(optionsPage, attachmentPreviewConfig(servers, target, {
    domains: [target.instanceUrl],
  }));

  const page = await extensionApp.context.newPage();
  await page.goto(`${target.instanceUrl}/browse/${target.primaryIssueKey}`);
  const secureUrl = `${jiraBaseUrl(target)}secure/attachment/900/evidence.png`;
  await page.evaluate(href => {
    const link = document.createElement('a');
    link.id = 'jira-attachment-link';
    link.href = href;
    link.textContent = 'evidence.png';
    document.body.appendChild(link);
  }, secureUrl);
  await injectContentScript(extensionApp, page);
  await expect.poll(async () => page.locator('._JX_container').count()).toBe(1);

  const prevented = await clickAndReportDefaultPrevented(page.locator('#jira-attachment-link'));
  expect(prevented).toBe(false);
  await expect(page.locator('._JX_preview_overlay')).not.toHaveClass(/is-open/);
  await page.close();
});
