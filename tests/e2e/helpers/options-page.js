function optionsPageModel(page) {
  return {
    root: page.getByTestId('options-root'),
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
