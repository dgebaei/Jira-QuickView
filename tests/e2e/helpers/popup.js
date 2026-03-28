function popupModel(page) {
  return {
    root: page.getByTestId('jira-popup-root'),
    actionsToggle: page.getByTestId('jira-popup-actions-toggle'),
    previewOverlay: page.getByTestId('jira-popup-preview-overlay'),
    previewImage: page.getByTestId('jira-popup-preview-image'),
    field: fieldKey => page.getByTestId(`jira-popup-field-${fieldKey}`),
    editButton: fieldKey => page.getByTestId(`jira-popup-edit-button-${fieldKey}`),
    editPopover: fieldKey => page.getByTestId(`jira-popup-edit-popover-${fieldKey}`),
    editInput: fieldKey => page.getByTestId(`jira-popup-edit-input-${fieldKey}`),
    editOptions: fieldKey => page.getByTestId(`jira-popup-edit-option-${fieldKey}`),
    editCancel: fieldKey => page.getByTestId(`jira-popup-edit-cancel-${fieldKey}`),
    editDiscard: fieldKey => page.getByTestId(`jira-popup-edit-discard-${fieldKey}`),
    editSave: fieldKey => page.getByTestId(`jira-popup-edit-save-${fieldKey}`),
  };
}

module.exports = {
  popupModel,
};
