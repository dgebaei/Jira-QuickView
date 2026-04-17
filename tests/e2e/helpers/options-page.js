function optionsPageModel(page) {
  return {
    root: page.getByTestId('options-root'),
    statusPill: page.getByTestId('options-status-pill'),
    heroVersionLink: page.getByTestId('options-hero-version-link'),
    heroLinks: page.getByTestId('options-hero-links'),
    heroLinkDownload: page.getByTestId('options-hero-link-download'),
    heroLinkWebsite: page.getByTestId('options-hero-link-website'),
    heroLinkGuide: page.getByTestId('options-hero-link-guide'),
    heroLinkRepo: page.getByTestId('options-hero-link-repo'),
    heroLinkIssues: page.getByTestId('options-hero-link-issues'),
    heroLinkNewIssue: page.getByTestId('options-hero-link-new-issue'),
    instanceUrlInput: page.getByTestId('options-instance-url'),
    domainsInput: page.getByTestId('options-domains'),
    advancedToggle: page.getByTestId('options-advanced-toggle'),
    hoverDepthSelect: page.getByTestId('options-hover-depth'),
    hoverModifierSelect: page.getByTestId('options-hover-modifier'),
    fieldLibrary: page.getByTestId('options-field-library'),
    fieldLibraryAddButton: page.getByTestId('options-field-library-add'),
    fieldLibraryInput: page.getByTestId('options-field-library-input'),
    fieldLibraryValidation: page.getByTestId('options-field-library-validation'),
    fieldLibrarySaveButton: page.getByTestId('options-field-library-save'),
    fieldLibraryCancelButton: page.getByTestId('options-field-library-cancel'),
    contentBlocksDropzone: page.getByTestId('options-content-blocks-dropzone'),
    teamSyncPanel: page.getByTestId('options-team-sync-panel'),
    teamSyncStatus: page.getByTestId('options-team-sync-status'),
    teamSyncMessage: page.getByTestId('options-team-sync-message'),
    teamSyncSourceTypeSelect: page.getByTestId('options-team-sync-source-type'),
    teamSyncUrlInput: page.getByTestId('options-team-sync-url'),
    teamSyncIssueKeyInput: page.getByTestId('options-team-sync-issue-key'),
    teamSyncFileNameInput: page.getByTestId('options-team-sync-file-name'),
    teamSyncNowButton: page.getByTestId('options-team-sync-now'),
    teamSyncDisconnectButton: page.getByTestId('options-team-sync-disconnect'),
    saveButton: page.getByTestId('options-save'),
    discardButton: page.getByTestId('options-discard'),
    saveNotice: page.getByTestId('options-save-notice'),
  };
}

function customFieldLibraryItem(page, fieldId) {
  return page.getByTestId(`options-field-library-item-custom_${fieldId}`);
}

function contentBlockItem(page, blockKey) {
  return page.getByTestId(`options-content-block-item-${blockKey}`);
}

async function openAdvancedSettings(page) {
  const advancedToggle = page.getByTestId('options-advanced-toggle');
  const expanded = await advancedToggle.getAttribute('aria-expanded');
  if (expanded !== 'true') {
    await advancedToggle.click();
  }
}

module.exports = {
  contentBlockItem,
  customFieldLibraryItem,
  optionsPageModel,
  openAdvancedSettings,
};
