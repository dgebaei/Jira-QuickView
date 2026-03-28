/*global chrome */
import React, {useEffect, useState, useCallback, useRef} from 'react';
import ReactDOM from 'react-dom';
import defaultConfig, {buildTooltipLayoutFromDisplayFields} from 'options/config';
import {
  DndContext,
  DragOverlay,
  rectIntersection,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {CSS} from '@dnd-kit/utilities';
import {storageGet, storageSet, permissionsRequest} from 'src/chrome';
import {hasPathSlash, resetDeclarativeMapping, toMatchUrl} from 'options/declarative';
import {DEFAULT_THEME_MODE, SUPPORTED_THEME_MODES, normalizeThemeMode, syncDocumentTheme} from 'src/theme';

import 'options/options.scss';

const FIELD_OPTIONS = [
  {key: 'issueType', label: 'Issue Type'},
  {key: 'status', label: 'Status'},
  {key: 'priority', label: 'Priority'},
  {key: 'sprint', label: 'Sprint'},
  {key: 'fixVersions', label: 'Fix Version'},
  {key: 'affects', label: 'Affects Version'},
  {key: 'environment', label: 'Environment'},
  {key: 'labels', label: 'Labels'},
  {key: 'epicParent', label: 'Epic/Parent'},
  {key: 'attachments', label: 'Attachments'},
  {key: 'comments', label: 'Comments'},
  {key: 'description', label: 'Description'},
  {key: 'reporter', label: 'Reporter'},
  {key: 'assignee', label: 'Assignee'},
  {key: 'pullRequests', label: 'Related Pull Requests'}
];

const FIELD_GROUPS = [
  {
    title: 'Top bar - row 1',
    description: 'Issue identity and triage context shown in the first summary row.',
    keys: ['issueType', 'status', 'priority', 'epicParent']
  },
  {
    title: 'Top bar - row 2',
    description: 'Planning and release context shown in the second summary row.',
    keys: ['sprint', 'affects', 'fixVersions']
  },
  {
    title: 'Top bar - row 3',
    description: 'Metadata chips shown in the third summary row.',
    keys: ['environment', 'labels']
  },
  {
    title: 'Description block',
    description: 'Rich issue description shown below the summary rows.',
    keys: ['description']
  },
  {
    title: 'Attachments block',
    description: 'Image previews and attachment indicators in the body area.',
    keys: ['attachments']
  },
  {
    title: 'Comments block',
    description: 'Rendered Jira comments in the body area.',
    keys: ['comments']
  },
  {
    title: 'People',
    description: 'Reporter and assignee avatars shown in the title area.',
    keys: ['reporter', 'assignee']
  },
  {
    title: 'Related development',
    description: 'Pull request summary table appended beneath the issue content.',
    keys: ['pullRequests']
  }
];

function normalizeInstanceUrl(instanceUrl) {
  let normalized = String(instanceUrl || '').trim();
  if (!normalized) {
    return '';
  }
  if (!hasPathSlash.test(normalized)) {
    normalized += '/';
  }
  if (normalized.indexOf('://') === -1) {
    normalized = 'https://' + normalized;
  }
  return normalized;
}

function normalizeCustomFields(customFields) {
  if (!Array.isArray(customFields)) {
    return [];
  }
  const seen = {};
  return customFields
    .map(field => ({
      fieldId: String(field && field.fieldId || '').trim(),
      row: Math.min(3, Math.max(1, Number(field && field.row) || 3))
    }))
    .filter(field => {
      if (!field.fieldId || seen[field.fieldId]) {
        return false;
      }
      seen[field.fieldId] = true;
      return true;
    });
}

async function fetchFieldCatalog(instanceUrl) {
  if (!instanceUrl) {
    return {};
  }
  try {
    const response = await fetch(instanceUrl + 'rest/api/2/field', {
      credentials: 'include'
    });
    if (!response.ok) {
      return {};
    }
    const fields = await response.json();
    if (!Array.isArray(fields)) {
      return {};
    }
    return fields.reduce((acc, field) => {
      if (field && field.id) {
        acc[field.id] = field.name || field.id;
      }
      return acc;
    }, {});
  } catch (ex) {
    return {};
  }
}

function getCustomFieldError(fieldId, fieldCatalog) {
  const trimmed = String(fieldId || '').trim();
  if (!trimmed) {
    return '';
  }
  if (!/^customfield_\d+$/i.test(trimmed)) {
    return 'Use a Jira custom field ID in the form customfield_12345.';
  }
  if (Object.keys(fieldCatalog).length && !fieldCatalog[trimmed]) {
    return 'This field ID was not found in Jira.';
  }
  return '';
}

async function main() {
  const storedConfig = await storageGet(defaultConfig);
  syncDocumentTheme(document, storedConfig.themeMode || DEFAULT_THEME_MODE);
  ReactDOM.render(
    <ConfigPage {...storedConfig} />,
    document.getElementById('container')
  );
}

const ROW_FIELD_KEYS = ['issueType', 'status', 'priority', 'epicParent', 'sprint', 'affects', 'fixVersions', 'environment', 'labels'];
const CONTENT_BLOCK_KEYS = [
  { key: 'description', label: 'Description', required: true },
  { key: 'attachments', label: 'Attachments' },
  { key: 'comments', label: 'Comments' },
  { key: 'pullRequests', label: 'Pull Requests' },
  { key: 'timeTracking', label: 'Time Tracking' }
];
const DRAGGABLE_CONTENT_KEYS = CONTENT_BLOCK_KEYS.filter(k => !k.required).map(k => k.key);
const DRAGGABLE_ZONES = ['row1', 'row2', 'row3'];
const CONTENT_BLOCKS_DROPPABLE = 'contentBlocks';

function SortableField({ id, label, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className='fieldPill' data-testid={`options-tooltip-row-item-${id}`} tabIndex={0} {...attributes} {...listeners}>
      <span className='fieldPillLabel'>{label}</span>
      {onRemove && (
        <button
          type='button'
          className='fieldPillRemove'
          onClick={(e) => { e.stopPropagation(); onRemove(id); }}
          title='Remove from layout'
        >
          ×
        </button>
      )}
    </div>
  );
}

function DraggableLibraryField({ id, label }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });

  const style = {
    opacity: isDragging ? 0.5 : 1,
    cursor: 'grab',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`fieldPill ${isDragging ? 'fieldPillDragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      <span className='fieldPillLabel'>{label}</span>
    </div>
  );
}

function FieldLibrary({ fields, onAddField, onRemoveCustomField, existingCustomFieldIds, fieldCatalog }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const trimmed = draft.trim();

  let validationMsg = '';
  let validationTone = '';
  if (trimmed) {
    if (!/^customfield_\d+$/i.test(trimmed)) {
      validationMsg = 'Format: customfield_12345';
      validationTone = 'error';
    } else if (existingCustomFieldIds.includes(trimmed)) {
      validationMsg = 'Already added';
      validationTone = 'error';
    } else if (Object.keys(fieldCatalog).length && !fieldCatalog[trimmed]) {
      validationMsg = 'Not found in Jira';
      validationTone = 'error';
    } else if (fieldCatalog[trimmed]) {
      validationMsg = fieldCatalog[trimmed];
      validationTone = 'success';
    } else {
      validationMsg = 'Checking\u2026';
      validationTone = 'neutral';
    }
  }
  const canSave = trimmed && validationTone === 'success';

  const handleSave = () => {
    if (!canSave) return;
    onAddField(trimmed);
    setDraft('');
    setAdding(false);
  };

  const handleCancel = () => {
    setDraft('');
    setAdding(false);
  };

  return (
    <div className='fieldLibrary' data-testid='options-field-library'>
      {fields.map(field => (
        <div key={field.key} className='fieldLibraryItem' data-testid={`options-field-library-item-${field.key}`}>
          <DraggableLibraryField id={field.key} label={field.label} />
          {field.key.startsWith('custom_') && (
            <button type='button' data-testid={`options-field-library-remove-${field.key}`} className='fieldLibraryRemove' onClick={() => onRemoveCustomField(field.key)} title='Remove field'>×</button>
          )}
        </div>
      ))}
      {fields.length === 0 && !adding && (
        <div className='fieldLibraryEmpty'>All fields are placed in the layout.</div>
      )}
      {adding ? (
        <div className='fieldLibraryAdd'>
          <input
            type='text'
            data-testid='options-field-library-input'
            className='fieldLibraryInput'
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') handleCancel(); }}
            placeholder='customfield_12345'
            autoFocus
          />
          {validationMsg && (
            <div data-testid='options-field-library-validation' className={`fieldLibraryValidation fieldLibraryValidation--${validationTone}`}>{validationMsg}</div>
          )}
          <div className='fieldLibraryAddActions'>
            <button type='button' data-testid='options-field-library-cancel' className='fieldLibraryAddBtn' onClick={handleCancel} title='Cancel'>✕</button>
            <button type='button' data-testid='options-field-library-save' className='fieldLibraryAddBtn fieldLibraryAddBtnSave' onClick={handleSave} disabled={!canSave} title='Save'>✓</button>
          </div>
        </div>
      ) : (
        <button type='button' data-testid='options-field-library-add' className='fieldLibraryAddFieldBtn' onClick={() => setAdding(true)}>
          + Add field
        </button>
      )}
    </div>
  );
}

function ContentBlockToggle({ block, checked, onChange }) {
  return (
    <label className='contentBlockToggle'>
      <input
        type='checkbox'
        checked={checked}
        onChange={(e) => onChange(block.key, e.target.checked)}
      />
      <span className='contentBlockToggleSwitch' />
      <span className='contentBlockToggleLabel'>{block.label}</span>
    </label>
  );
}

function DroppableZone({ id, title, fields, onRemove, isOver }) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      data-testid={`options-tooltip-row-${id}`}
      data-layout-order={fields.map(field => field.key).join(',')}
      className={`tooltipPreviewRow ${isOver ? 'tooltipPreviewRowOver' : ''}`}
    >
      <span className='tooltipPreviewRowLabel'>{title}</span>
      <SortableContext items={fields.map(f => f.key)} strategy={verticalListSortingStrategy}>
        <div className='tooltipPreviewRowContent'>
          {fields.map(field => (
            <SortableField
              key={field.key}
              id={field.key}
              label={field.label}
              onRemove={onRemove}
            />
          ))}
          {fields.length === 0 && (
            <span className='tooltipPreviewRowEmpty'>Drop fields here</span>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

function SortableContentBlock({ id, label, onRemove }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className='contentBlockItem' data-testid={`options-content-block-item-${id}`} tabIndex={0} {...attributes} {...listeners}>
      <span className='contentBlockDragHandle'>⋮⋮</span>
      <span>{label}</span>
      <button
        type='button'
        className='contentBlockRemove'
        onClick={() => onRemove(id)}
      >
        ×
      </button>
    </div>
  );
}

function DraggableContentBlock({ id, label }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });

  const style = {
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid={`options-content-block-library-item-${id}`}
      tabIndex={0}
      className={`contentBlockItem ${isDragging ? 'contentBlockItemDragging' : ''}`}
      {...listeners}
      {...attributes}
    >
      <span className='contentBlockDragHandle'>⋮⋮</span>
      <span>{label}</span>
    </div>
  );
}

function DroppableContentBlocks({ id, isOver, children, order }) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div ref={setNodeRef} data-testid='options-content-blocks-dropzone' data-content-order={order.join(',')} className={`tooltipPreviewContentList ${isOver ? 'tooltipPreviewContentListOver' : ''}`}>
      {children}
    </div>
  );
}

function TooltipLayoutEditor({ tooltipLayout, setTooltipLayout, customFields, setCustomFields, fieldCatalog, onAddField, onRemoveCustomField }) {
  const [activeId, setActiveId] = useState(null);
  const [overId, setOverId] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const allFields = {};
  FIELD_OPTIONS.forEach(opt => {
    if (ROW_FIELD_KEYS.includes(opt.key)) {
      allFields[opt.key] = opt.label;
    }
  });
  customFields.forEach(cf => {
    const key = cf.fieldId ? `custom_${cf.fieldId}` : `custom_${cf._uid}`;
    const name = cf.fieldId ? (fieldCatalog[cf.fieldId] || cf.fieldId) : '(unsaved)';
    allFields[key] = name;
  });

  const placedRowKeys = new Set([
    ...tooltipLayout.row1,
    ...tooltipLayout.row2,
    ...tooltipLayout.row3,
  ]);

  const libraryFields = Object.keys(allFields)
    .filter(key => !placedRowKeys.has(key))
    .map(key => ({ key, label: allFields[key] }));

  const getZoneForKey = (key) => {
    if (tooltipLayout.row1.includes(key)) return 'row1';
    if (tooltipLayout.row2.includes(key)) return 'row2';
    if (tooltipLayout.row3.includes(key)) return 'row3';
    return null;
  };

  const handleRemoveFromZone = (zone, key) => {
    setTooltipLayout(prev => ({
      ...prev,
      [zone]: prev[zone].filter(k => k !== key)
    }));
  };

  const handleToggleContentBlock = (key, checked) => {
    setTooltipLayout(prev => {
      if (checked) {
        return { ...prev, contentBlocks: [...prev.contentBlocks, key] };
      } else {
        return { ...prev, contentBlocks: prev.contentBlocks.filter(k => k !== key) };
      }
    });
  };

  const handleDragStart = (event) => {
    setActiveId(event.active.id);
  };

  const handleDragOver = (event) => {
    const { over } = event;
    if (over) {
      setOverId(over.id);
    } else {
      setOverId(null);
    }
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    setActiveId(null);
    setOverId(null);

    if (!over) return;

    const activeKey = active.id;
    const overId = over.id;

    if (tooltipLayout.contentBlocks.includes(activeKey) && tooltipLayout.contentBlocks.includes(overId)) {
      const oldIndex = tooltipLayout.contentBlocks.indexOf(activeKey);
      const newIndex = tooltipLayout.contentBlocks.indexOf(overId);
      if (oldIndex !== newIndex) {
        setTooltipLayout(prev => {
          const newBlocks = [...prev.contentBlocks];
          newBlocks.splice(oldIndex, 1);
          newBlocks.splice(newIndex, 0, activeKey);
          return { ...prev, contentBlocks: newBlocks };
        });
      }
      return;
    }

    if (DRAGGABLE_CONTENT_KEYS.includes(activeKey) && (overId === CONTENT_BLOCKS_DROPPABLE || tooltipLayout.contentBlocks.includes(overId))) {
      if (!tooltipLayout.contentBlocks.includes(activeKey)) {
        setTooltipLayout(prev => {
          const newBlocks = [...prev.contentBlocks, activeKey];
          return { ...prev, contentBlocks: newBlocks };
        });
      }
      return;
    }

    const fromZone = getZoneForKey(activeKey);

    let toZone = null;
    if (DRAGGABLE_ZONES.includes(overId)) {
      toZone = overId;
    } else {
      toZone = getZoneForKey(overId);
    }

    if (!toZone) return;

    if (fromZone === toZone) {
      const overIndex = tooltipLayout[toZone].indexOf(overId);
      if (overIndex >= 0 && activeKey !== overId) {
        setTooltipLayout(prev => {
          const newZone = [...prev[toZone]];
          const activeIndex = newZone.indexOf(activeKey);
          if (activeIndex >= 0) {
            newZone.splice(activeIndex, 1);
            newZone.splice(overIndex, 0, activeKey);
          }
          return { ...prev, [toZone]: newZone };
        });
      }
      return;
    }

    if (fromZone) {
      setTooltipLayout(prev => {
        const newLayout = { ...prev };
        newLayout[fromZone] = prev[fromZone].filter(k => k !== activeKey);

        const overIndex = prev[toZone].indexOf(overId);
        if (overIndex >= 0) {
          newLayout[toZone] = [...prev[toZone]];
          newLayout[toZone].splice(overIndex, 0, activeKey);
        } else {
          newLayout[toZone] = [...prev[toZone], activeKey];
        }

        return newLayout;
      });
    } else if (DRAGGABLE_ZONES.includes(toZone)) {
      const overIndex = tooltipLayout[toZone].indexOf(overId);
      if (overIndex >= 0) {
        setTooltipLayout(prev => {
          const newZone = [...prev[toZone]];
          newZone.splice(overIndex, 0, activeKey);
          return { ...prev, [toZone]: newZone };
        });
      } else {
        setTooltipLayout(prev => ({
          ...prev,
          [toZone]: [...prev[toZone], activeKey]
        }));
      }
    }
  };

  const activeField = activeId ? { key: activeId, label: allFields[activeId] || activeId } : null;

  const getFieldsForZone = (zone) => {
    return (tooltipLayout[zone] || []).map(key => ({
      key,
      label: allFields[key] || key
    }));
  };

  return (
    <div className='tooltipLayoutWrapper'>
      <div className='tooltipLayoutEditor'>
        <DndContext
          sensors={sensors}
          collisionDetection={rectIntersection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
        >
          <div className='tooltipLayoutFieldsLeft'>
            <div className='tooltipLayoutSidebar'>
              <div className='tooltipLayoutSidebarHeader'>
                <h4>Available Fields</h4>
                <p>Drag fields into rows</p>
              </div>
              <FieldLibrary
                fields={libraryFields}
                onAddField={onAddField}
                onRemoveCustomField={onRemoveCustomField}
                existingCustomFieldIds={customFields.map(cf => cf.fieldId).filter(Boolean)}
                fieldCatalog={fieldCatalog}
              />
            </div>
          </div>

          <div className='tooltipLayoutBlocksLeft'>
            <div className='tooltipLayoutBlocksSidebar'>
              <div className='tooltipLayoutBlocksSidebarHeader'>
                <h4>Available Blocks</h4>
                <p>Drag to content</p>
              </div>
              <div className='blocksLibrary'>
                {DRAGGABLE_CONTENT_KEYS.filter(key => !tooltipLayout.contentBlocks.includes(key)).map(key => {
                  const block = CONTENT_BLOCK_KEYS.find(b => b.key === key);
                  if (!block) return null;
                  return (
                    <DraggableContentBlock
                      key={key}
                      id={key}
                      label={block.label}
                    />
                  );
                })}
                {DRAGGABLE_CONTENT_KEYS.filter(key => !tooltipLayout.contentBlocks.includes(key)).length === 0 && (
                  <div className='blocksLibraryEmpty'>All blocks added</div>
                )}
              </div>
            </div>
          </div>

          <div className='tooltipLayoutFieldsRight'>
            <div className='tooltipLayoutPreview'>
              <div className='tooltipPreview'>
                <div className='tooltipPreviewHeader'>
                  <div className='tooltipPreviewLeft'>
                    <div className='tooltipPreviewPeople'>
                      <div className='tooltipPreviewPerson tooltipPreviewPersonR' title='Reporter'>Re</div>
                      <div className='tooltipPreviewPerson tooltipPreviewPersonA' title='Assignee'>As</div>
                    </div>
                    <div className='tooltipPreviewTitle'>
                      <span className='tooltipPreviewKey'>[PROJECT-123]</span>
                      <span className='tooltipPreviewTitleText'>My Awesome Feature Implementation</span>
                    </div>
                  </div>
                  <div className='tooltipPreviewActions'>
                    <span className='tooltipPreviewAction' title='Copy'>⎘</span>
                    <span className='tooltipPreviewAction' title='Pin'>📌</span>
                    <span className='tooltipPreviewAction' title='More'>···</span>
                    <span className='tooltipPreviewAction tooltipPreviewActionClose' title='Close'>×</span>
                  </div>
                </div>

                <div className='tooltipPreviewSection'>
                  <DroppableZone
                    id='row1'
                    title='Row 1'
                    fields={getFieldsForZone('row1')}
                    onRemove={(key) => handleRemoveFromZone('row1', key)}
                    isOver={overId === 'row1'}
                  />
                  <DroppableZone
                    id='row2'
                    title='Row 2'
                    fields={getFieldsForZone('row2')}
                    onRemove={(key) => handleRemoveFromZone('row2', key)}
                    isOver={overId === 'row2'}
                  />
                  <DroppableZone
                    id='row3'
                    title='Row 3'
                    fields={getFieldsForZone('row3')}
                    onRemove={(key) => handleRemoveFromZone('row3', key)}
                    isOver={overId === 'row3'}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className='tooltipLayoutBlocksRight'>
            <div className='tooltipLayoutPreview'>
              <div className='tooltipPreview'>
                <div className='tooltipPreviewContentBlocks'>
                  <span className='tooltipPreviewContentLabel'>Content Blocks</span>
                  <DroppableContentBlocks id={CONTENT_BLOCKS_DROPPABLE} isOver={overId === CONTENT_BLOCKS_DROPPABLE} order={tooltipLayout.contentBlocks}>
                    <div className='contentBlockItem contentBlockItemRequired'>
                      <span>Description</span>
                      <span className='contentBlockAlways'>Always shown</span>
                    </div>
                    {tooltipLayout.contentBlocks.length > 0 && (
                      <SortableContext items={tooltipLayout.contentBlocks} strategy={verticalListSortingStrategy}>
                        {tooltipLayout.contentBlocks.map(key => {
                          const block = CONTENT_BLOCK_KEYS.find(b => b.key === key);
                          if (!block) return null;
                          return (
                            <SortableContentBlock
                              key={key}
                              id={key}
                              label={block.label}
                              onRemove={handleToggleContentBlock}
                            />
                          );
                        })}
                      </SortableContext>
                    )}
                    {tooltipLayout.contentBlocks.length === 0 && (
                      <div className='contentBlockEmpty'>Drag blocks here</div>
                    )}
                  </DroppableContentBlocks>
                </div>
              </div>
            </div>
          </div>

          <DragOverlay>
            {activeId ? (
              <div className='fieldPill fieldPillDragging' data-testid='options-drag-overlay'>
                <span className='fieldPillLabel'>
                  {allFields[activeId] || (CONTENT_BLOCK_KEYS.find(b => b.key === activeId)?.label) || activeId}
                </span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}

function ConfigPage(props) {
  const [instanceUrl, setInstanceUrl] = useState(props.instanceUrl || '');
  const [domainsText, setDomainsText] = useState((props.domains || []).join(', '));
  const [themeMode, setThemeMode] = useState(normalizeThemeMode(props.themeMode || DEFAULT_THEME_MODE));
  const [displayFields, setDisplayFields] = useState({
    ...defaultConfig.displayFields,
    ...(props.displayFields || {})
  });
  const [hoverDepth, setHoverDepth] = useState(props.hoverDepth || 'shallow');
  const [hoverModifierKey, setHoverModifierKey] = useState(props.hoverModifierKey || 'none');
  const [customFields, setCustomFields] = useState(() =>
    normalizeCustomFields(props.customFields).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`}))
  );
  const [tooltipLayout, setTooltipLayout] = useState(() => {
    if (props.tooltipLayout) {
      return props.tooltipLayout;
    }
    return buildTooltipLayoutFromDisplayFields({
      ...defaultConfig.displayFields,
      ...(props.displayFields || {})
    });
  });
  const [fieldCatalog, setFieldCatalog] = useState({});
  const [status, setStatus] = useState('');
  const [statusTone, setStatusTone] = useState('neutral');
  const [isSaving, setIsSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    () => sessionStorage.getItem('jhl_adv') === '1'
  );
  const customFieldErrors = customFields.map(field => getCustomFieldError(field.fieldId, fieldCatalog));
  const hasInvalidCustomFields = customFieldErrors.some(Boolean);

  const savedJsonRef = useRef(JSON.stringify({
    instanceUrl: props.instanceUrl || '',
    domainsText: (props.domains || []).join(', '),
    themeMode: normalizeThemeMode(props.themeMode || DEFAULT_THEME_MODE),
    hoverDepth: props.hoverDepth || 'shallow',
    hoverModifierKey: props.hoverModifierKey || 'none',
    tooltipLayout: tooltipLayout,
    customFields: customFields.map(f => f.fieldId),
  }));
  const currentJson = JSON.stringify({
    instanceUrl, domainsText, themeMode, hoverDepth, hoverModifierKey,
    tooltipLayout,
    customFields: customFields.map(f => f.fieldId),
  });
  const isDirty = currentJson !== savedJsonRef.current;

  const toggleAdvanced = useCallback(() => {
    setShowAdvanced(prev => {
      const next = !prev;
      sessionStorage.setItem('jhl_adv', next ? '1' : '0');
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl || props.instanceUrl);
    fetchFieldCatalog(normalizedInstanceUrl).then(catalog => {
      if (!cancelled) {
        setFieldCatalog(catalog);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [instanceUrl, props.instanceUrl]);

  useEffect(() => syncDocumentTheme(document, themeMode), [themeMode]);

  const setDisplayFieldValue = (key, checked) => {
    setDisplayFields(current => ({
      ...current,
      [key]: checked
    }));
  };

  const addCustomField = (fieldId) => {
    const newField = { fieldId, row: 3, _uid: `cf-${Date.now()}` };
    setCustomFields(current => current.concat(newField));
  };

  const removeCustomFieldByKey = (layoutKey) => {
    const fieldId = layoutKey.replace('custom_', '');
    if (!window.confirm('Remove this custom field from the extension?')) return;
    setCustomFields(current => current.filter(f => f.fieldId !== fieldId));
    setTooltipLayout(prev => ({
      ...prev,
      row1: prev.row1.filter(k => k !== layoutKey),
      row2: prev.row2.filter(k => k !== layoutKey),
      row3: prev.row3.filter(k => k !== layoutKey),
    }));
  };

  const handleThemeChange = (mode) => {
    setThemeMode(normalizeThemeMode(mode));
  };

  const moveContentBlock = useCallback((blockKey, toIndex) => {
    setTooltipLayout(prev => {
      const currentBlocks = Array.isArray(prev.contentBlocks) ? [...prev.contentBlocks] : [];
      const currentIndex = currentBlocks.indexOf(blockKey);
      if (currentIndex === -1) {
        return prev;
      }

      currentBlocks.splice(currentIndex, 1);
      const nextIndex = Math.max(0, Math.min(Number(toIndex) || 0, currentBlocks.length));
      currentBlocks.splice(nextIndex, 0, blockKey);
      return {
        ...prev,
        contentBlocks: currentBlocks,
      };
    });
  }, []);

  useEffect(() => {
    window.__JHL_TEST_API__ = {
      moveContentBlock,
      getTooltipLayout: () => tooltipLayout,
    };

    return () => {
      delete window.__JHL_TEST_API__;
    };
  }, [moveContentBlock, tooltipLayout]);

  const exportSettings = () => {
    const config = {
      version: '2.2.1',
      exportedAt: new Date().toISOString(),
      instanceUrl,
      domains: domainsText.split(',').map(x => x.trim()).filter(x => !!x),
      themeMode,
      hoverDepth,
      hoverModifierKey,
      displayFields,
      tooltipLayout,
      customFields: normalizeCustomFields(customFields)
    };

    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jira-hotlinker-settings.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        const config = JSON.parse(text);

        if (!config.instanceUrl && !config.domains) {
          setStatusTone('error');
          setStatus('Invalid settings file.');
          return;
        }

        setInstanceUrl(config.instanceUrl || '');
        setDomainsText((config.domains || []).join(', '));
        setThemeMode(normalizeThemeMode(config.themeMode || 'system'));
        setHoverDepth(config.hoverDepth || 'shallow');
        setHoverModifierKey(config.hoverModifierKey || 'none');
        setDisplayFields(config.displayFields || defaultConfig.displayFields);
        setTooltipLayout(config.tooltipLayout || defaultConfig.tooltipLayout);
        setCustomFields((config.customFields || []).map((f, i) => ({...f, _uid: f._uid || `cf-${Date.now()}-${i}`})));

        setStatusTone('success');
        setStatus('Settings imported. Click Save to apply.');
      } catch (err) {
        setStatusTone('error');
        setStatus('Failed to import settings file.');
      }
    };
    input.click();
  };

  const showProModal = () => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    modal.innerHTML = `
      <div style="background:white;border-radius:12px;padding:24px;max-width:400px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,0.2);">
        <h3 style="margin:0 0 12px;color:#1e40af;">Team Sync (Pro)</h3>
        <p style="color:#64748b;margin:0 0 16px;">Auto-sync your Jira HotLinker settings across your team. Coming soon!</p>
        <p style="color:#94a3b8;font-size:12px;margin:0 0 16px;">Join the waitlist to get early access.</p>
        <a href="mailto:dgebaei@gmail.com?subject=Team Sync Pro Waitlist" style="display:inline-block;background:#7c3aed;color:white;padding:8px 16px;border-radius:8px;text-decoration:none;font-weight:600;">Join Waitlist</a>
        <button onclick="this.closest('div').parentElement.remove()" style="display:block;margin:12px auto 0;background:transparent;border:none;color:#64748b;cursor:pointer;">Close</button>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  };

  const saveOptions = async () => {
    const domains = domainsText
      .split(',')
      .map(x => x.trim())
      .filter(x => !!x);
    const normalizedInstanceUrl = normalizeInstanceUrl(instanceUrl);

    if (!normalizedInstanceUrl) {
      setStatusTone('error');
      setStatus('You must provide your Jira instance URL.');
      return;
    }

    setInstanceUrl(normalizedInstanceUrl);

    const permissionDomains = domains.concat([normalizedInstanceUrl]);
    const currentInstanceUrl = await storageGet(defaultConfig);
    if (!currentInstanceUrl.instanceUrl) {
      domains.push(normalizedInstanceUrl);
    }

    setIsSaving(true);
    setStatusTone('neutral');
    setStatus('Saving changes...');

    let granted;
    try {
      granted = await permissionsRequest({'origins': permissionDomains.map(toMatchUrl)});
    } catch (ex) {
      setIsSaving(false);
      setStatusTone('error');
      setStatus(ex.message);
      return;
    }

    if (!granted) {
      setIsSaving(false);
      setStatusTone('error');
      setStatus('Options not saved.');
      return;
    }

    await storageSet({
      instanceUrl: normalizedInstanceUrl,
      domains,
      themeMode: normalizeThemeMode(themeMode),
      v15upgrade: true,
      hoverDepth,
      hoverModifierKey,
      displayFields,
      tooltipLayout,
      customFields: normalizeCustomFields(customFields)
    });
    resetDeclarativeMapping();
    setDomainsText(domains.join(', '));
    savedJsonRef.current = JSON.stringify({
      instanceUrl: normalizedInstanceUrl,
      domainsText: domains.join(', '),
      themeMode: normalizeThemeMode(themeMode),
      hoverDepth, hoverModifierKey,
      tooltipLayout,
      customFields: customFields.map(f => f.fieldId),
    });
    setIsSaving(false);
    setStatusTone('success');
    setStatus('Options saved successfully.');
    setTimeout(() => {
      setStatusTone('neutral');
      setStatus('');
    }, 2500);
  };

  const discardOptions = () => {
    window.location.reload();
  };

  const statusMessage = status || (hasInvalidCustomFields ? 'Fix invalid custom field IDs before saving.' : 'Changes are local until you save them.');

  return (
    <div className='optionsPage' data-testid='options-root'>
      {/* ── Hero ─────────────────────────────────────────── */}
      <header className='heroCard'>
        <div className='heroLeft'>
          <div className='heroEyebrow'>Jira HotLinker</div>
          <h1 className='heroTitle'>Extension Options</h1>
          <p className='heroCopy'>
            Configure your Jira connection, theme, and which fields appear in the hover popup.
          </p>
        </div>
        <div className='heroRight'>
          <div className='statusPill' data-testid='options-status-pill'>
            <span className={`statusPillDot ${statusTone === 'success' ? 'statusPillDotActive' : ''}`} />
            {statusMessage}
          </div>
        </div>
      </header>

      {/* ── Settings Grid ───────────────────────────────── */}
      <div className='settingsGrid'>

        {/* ── BASIC: Connection ─────────────────────────── */}
        <section className='settingsCard'>
          <div className='cardHeader'>
            <div className='sectionEyebrow'>Basic</div>
            <h2>Connection</h2>
            <p>Tell the extension where Jira lives and which pages it should activate on.</p>
          </div>
          <div className='cardBody'>
            <label className='formField'>
              <span className='fieldLabel'>Jira instance URL</span>
                <input
                  data-testid='options-instance-url'
                  id='instanceUrl'
                type='text'
                value={instanceUrl}
                onChange={event => setInstanceUrl(event.target.value)}
                placeholder='https://your-company.atlassian.net/' />
              <span className='fieldHelp'>Used for issue metadata, field discovery, and link targets.</span>
            </label>

            <label className='formField'>
              <span className='fieldLabel'>Allowed pages</span>
                <textarea
                  data-testid='options-domains'
                  id='domains'
                value={domainsText}
                onChange={event => setDomainsText(event.target.value)}
                placeholder='github.com, outlook.office.com' />
              <span className='fieldHelp'>
                Comma-separated domains, URLs, or valid{' '}
                <a href='https://developer.chrome.com/extensions/match_patterns' target='_blank' rel='noopener noreferrer'>
                  match patterns
                </a>.
                You can also add a page directly from the extension icon.
              </span>
            </label>
          </div>
        </section>

        {/* ── BASIC: Appearance ──────────────────────────── */}
        <section className='settingsCard'>
          <div className='cardHeader'>
            <h2>Appearance</h2>
            <p>Choose how the options page and hover popup look across light and dark environments.</p>
          </div>
          <div className='cardBody'>
            <span className='fieldLabel'>Color mode</span>
            <div className='themePills'>
              {SUPPORTED_THEME_MODES.map(mode => (
                  <button
                    key={mode}
                    type='button'
                    data-testid={`options-theme-mode-${mode}`}
                    className={`themePill ${themeMode === mode ? 'themePillSelected' : 'themePillUnselected'}`}
                  onClick={() => handleThemeChange(mode)}
                >
                  {mode === 'system' ? 'System' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
            <div className='tipBox'>
              Tip: Most users keep the default System setting. Switch to Light or Dark only if you prefer a fixed appearance regardless of your OS theme.
            </div>
          </div>
        </section>

      </div>

      {/* ── Advanced Toggle ──────────────────────────────── */}
      <div className='advToggleCard'>
        <span className='advToggleIcon' aria-hidden='true'>&#9881;</span>
        <div className='advToggleText'>
          <h3>Show advanced settings</h3>
          <p>Hover trigger depth, modifier keys, field layout editor, custom fields, and settings sync.</p>
        </div>
        <button
          type='button'
          data-testid='options-advanced-toggle'
          className='advToggleBtn'
          onClick={toggleAdvanced}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? 'Hide' : 'Show'}
        </button>
      </div>

      {/* ── ADVANCED Sections ───────────────────────────── */}
      {showAdvanced && (
        <div className='settingsGrid'>
          {/* ── Hover Behavior ───────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <div className='sectionEyebrow sectionEyebrowMuted'>Advanced</div>
              <h2>Hover Behavior</h2>
              <p>Control when the tooltip appears as you move the mouse over Jira issue keys.</p>
            </div>
            <div className='cardBody'>
              <div className='hoverRow'>
                <label className='formField'>
                  <span className='fieldLabel'>Trigger depth</span>
                  <select data-testid='options-hover-depth' value={hoverDepth} onChange={event => setHoverDepth(event.target.value)}>
                    <option value='exact'>Exact — only the hovered element itself</option>
                    <option value='shallow'>Shallow — hovered element + immediate parent</option>
                    <option value='deep'>Deep — walk up to 5 ancestor levels (most sensitive)</option>
                  </select>
                  <span className='fieldHelp'>
                    How aggressively the extension searches surrounding DOM elements for Jira keys.
                    Use &ldquo;Exact&rdquo; if the tooltip triggers too often on pages with dense text.
                  </span>
                </label>

                <label className='formField'>
                  <span className='fieldLabel'>Modifier key</span>
                  <select data-testid='options-hover-modifier' value={hoverModifierKey} onChange={event => setHoverModifierKey(event.target.value)}>
                    <option value='none'>None — hover alone triggers the tooltip</option>
                    <option value='alt'>Alt — press Alt after hovering</option>
                    <option value='ctrl'>Ctrl — press Ctrl after hovering</option>
                    <option value='shift'>Shift — press Shift after hovering</option>
                    <option value='any'>Any — press Alt, Ctrl, or Shift after hovering</option>
                  </select>
                  <span className='fieldHelp'>
                    When set, hover over a Jira key and then press the chosen key to reveal the tooltip.
                    Useful for on-demand activation instead of automatic popups.
                  </span>
                </label>
              </div>
            </div>
          </section>

          {/* ── Tooltip Layout ───────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <h2>Tooltip Layout</h2>
              <p>Drag fields to customize which Jira data appears in each row of the hover card.</p>
            </div>
            <div className='cardBody'>
              <TooltipLayoutEditor
                tooltipLayout={tooltipLayout}
                setTooltipLayout={setTooltipLayout}
                customFields={customFields}
                setCustomFields={setCustomFields}
                fieldCatalog={fieldCatalog}
                onAddField={addCustomField}
                onRemoveCustomField={removeCustomFieldByKey}
              />
            </div>
          </section>

          {/* ── Settings Sync ────────────────────────────── */}
          <section className='settingsCard settingsGridFull'>
            <div className='cardHeader'>
              <h2>Settings Sync</h2>
              <p>Export, import, or auto-sync your extension configuration across your team.</p>
            </div>
            <div className='cardBody'>
              <div className='syncButtons'>
                <button type='button' data-testid='options-export-settings' className='syncBtn' onClick={exportSettings}>
                  &#10132; Export Settings (.json)
                </button>
                <button type='button' data-testid='options-import-settings' className='syncBtn' onClick={importSettings}>
                  &#10132; Import Settings (.json)
                </button>
                <button type='button' data-testid='options-team-sync' className='syncBtn proButton' onClick={showProModal}>
                  &#10022; Team Sync (Pro)
                </button>
              </div>
              <p className='syncProHint'>auto-sync config across your team</p>
            </div>
          </section>

        </div>
      )}

      {/* ── Footer Action Bar ────────────────────────────── */}
      <footer className={`actionBar${isDirty ? ' actionBarDirty' : ''}`}>
        <div className='actionCopy'>
          <strong>Save changes</strong>
          <span>Applies the Jira URL, allowed pages, appearance, and field settings.</span>
        </div>
        <div className='actionControlsRow'>
          {(status || hasInvalidCustomFields) && (
              <span data-testid='options-save-notice' className={`saveNotice saveNotice${statusTone.charAt(0).toUpperCase() + statusTone.slice(1)}`}>
                {status || 'Fix invalid custom field IDs before saving.'}
              </span>
            )}
          <button type='button' data-testid='options-discard' className='ghostButton' onClick={discardOptions} disabled={isSaving}>
            Discard
          </button>
          <button
            type='button'
            data-testid='options-save'
            className={`saveBtn primaryButton${isDirty ? ' saveBtnDirty' : ''}`}
            onClick={saveOptions}
            disabled={isSaving || hasInvalidCustomFields}
          >
            {isSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

document.addEventListener('DOMContentLoaded', main);
