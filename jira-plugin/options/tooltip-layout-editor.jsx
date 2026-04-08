import React, {useState} from 'react';
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
import {BUILT_IN_FIELD_IDS, getCustomFieldLayoutKey, updateCustomFieldRow} from 'options/options-utils';

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
    if (BUILT_IN_FIELD_IDS.has(trimmed)) {
      validationMsg = 'Built-in field';
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
            placeholder='Field ID (e.g. resolution)'
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

export function TooltipLayoutEditor({ tooltipLayout, setTooltipLayout, customFields, setCustomFields, fieldCatalog, onAddField, onRemoveCustomField }) {
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
    const key = getCustomFieldLayoutKey(cf);
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

  const syncCustomFieldRow = (layoutKey, zone) => {
    setCustomFields(current => updateCustomFieldRow(current, layoutKey, zone));
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
      syncCustomFieldRow(activeKey, toZone);
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
      syncCustomFieldRow(activeKey, toZone);
    }
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
                    fields={getFieldsForZone('row1', tooltipLayout, allFields)}
                    onRemove={(key) => handleRemoveFromZone('row1', key)}
                    isOver={overId === 'row1'}
                  />
                  <DroppableZone
                    id='row2'
                    title='Row 2'
                    fields={getFieldsForZone('row2', tooltipLayout, allFields)}
                    onRemove={(key) => handleRemoveFromZone('row2', key)}
                    isOver={overId === 'row2'}
                  />
                  <DroppableZone
                    id='row3'
                    title='Row 3'
                    fields={getFieldsForZone('row3', tooltipLayout, allFields)}
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

function getFieldsForZone(zone, tooltipLayout, allFields) {
  return (tooltipLayout[zone] || []).map(key => ({
    key,
    label: allFields[key] || key
  }));
}
