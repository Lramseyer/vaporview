import { EventHandler, viewport, arrayMove, NetlistId, ActionType, viewerState, dataManager, RowId, getChildrenByGroupId, getIndexInGroup, sendWebviewContext} from './vaporview';
import { ValueFormat } from './value_format';
import { vscode, getParentGroupId } from './vaporview';
import { SignalGroup, VariableItem, htmlSafe } from './signal_item';

export class LabelsPanels {

  resizeElement: any = null;
  events: EventHandler;

  webview: HTMLElement;
  labels: HTMLElement;
  valueDisplay: HTMLElement;
  labelsScroll: HTMLElement;
  valuesScroll: HTMLElement;
  resize1: HTMLElement;
  resize2: HTMLElement;
  dragDivider: HTMLElement | null = null;

  // drag handler variables
  labelsList: any            = [];
  idleItems: any             = [];
  idleGroups: any            = [];
  draggableItem: any         = null;
  closestItem: any           = null;
  groupContainer: any        = null;
  indexOffset: number        = 0;
  pointerStartX: any         = null;
  pointerStartY: any         = null;
  scrollStartY: any          = null;
  resizeIndex: any           = null;
  defaultDragDividerY: number= 0;
  dragActive: boolean        = false;
  dragInProgress: boolean    = false;
  dragFreeze: boolean        = true;
  dragFreezeTimeout: any     = null;
  renameActive: boolean      = false;
  valueAtMarker: any         = {};

  constructor(events: EventHandler) {
    this.events = events;

    const webview      = document.getElementById('vaporview-top');
    const labels       = document.getElementById('waveform-labels');
    const valueDisplay = document.getElementById('value-display');
    const labelsScroll = document.getElementById('waveform-labels-container');
    const valuesScroll = document.getElementById('value-display-container');
    const resize1      = document.getElementById("resize-1");
    const resize2      = document.getElementById("resize-2");

    if (webview === null || labels === null || valueDisplay === null ||
       labelsScroll === null || valuesScroll === null || resize1 === null ||
       resize2 === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview      = webview;
    this.labels       = labels;
    this.valueDisplay = valueDisplay;
    this.labelsScroll = labelsScroll;
    this.valuesScroll = valuesScroll;
    this.resize1      = resize1;
    this.resize2      = resize2;

    this.dragMove              = this.dragMove.bind(this);
    this.resize                = this.resize.bind(this);
    this.dragEnd               = this.dragEnd.bind(this);
    this.dragStart             = this.dragStart.bind(this);
    this.handleResizeMousedown = this.handleResizeMousedown.bind(this);
    this.handleMarkerSet       = this.handleMarkerSet.bind(this);
    this.handleSignalSelect    = this.handleSignalSelect.bind(this);
    this.handleReorderSignalsHierarchy  = this.handleReorderSignalsHierarchy.bind(this);
    this.handleRemoveVariable  = this.handleRemoveVariable.bind(this);
    this.handleAddVariable     = this.handleAddVariable.bind(this);
    this.handleRedrawVariable  = this.handleRedrawVariable.bind(this);
    this.handleUpdateColor     = this.handleUpdateColor.bind(this);

    // Event handlers to handle clicking on a waveform label to select a signal
    labels.addEventListener(      'click', (e) => this.clicklabel(e));
    valueDisplay.addEventListener('click', (e) => this.clickValueDisplay(e));
    // resize handler to handle column resizing
    resize1.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize1, 1);});
    resize2.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize2, 2);});
    // click and drag handlers to rearrange the order of waveform signals
    labels.addEventListener('mousedown', (e) => {this.dragStart(e);});

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignalsHierarchy);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleUpdateColor);
  }

  renderLabelsPanels() {
    this.labelsList  = [];
    const transitions: string[] = [];
    this.labelsList.push('<svg id="drag-divider" style="top: 0px; display:none; pointer-events: none;"><line x1="0" y1="0" x2="100%" y2="0"></line></svg>');
    viewerState.displayedSignals.forEach((rowId, index) => {
      const netlistData = dataManager.rowItems[rowId];
      this.labelsList.push(netlistData.createLabelElement());
      transitions.push(netlistData.createValueDisplayElement());
    });
    this.labels.innerHTML       = this.labelsList.join('');
    this.valueDisplay.innerHTML = transitions.join('');
  }

  clickValueDisplay(event: any) {
    const labelsList   = Array.from(this.valueDisplay.querySelectorAll('.value-display-item'));
    const clickedLabel = event.target.closest('.value-display-item');
    const itemIndex    = labelsList.indexOf(clickedLabel);
    if (itemIndex === -1) {return;}
    const rowId = viewerState.displayedSignals[itemIndex];
    this.events.dispatch(ActionType.SignalSelect, rowId);
  }

  clicklabel (event: any) {
    if (this.dragInProgress) {return;}
    if (this.renameActive) {return;}
    const clickedLabel = event.target.closest('.waveform-label');
    const rowId = this.getRowIdFromElement(clickedLabel);
    if (rowId === null || isNaN(rowId)) {return;}

    if (event.target.classList.contains('codicon-chevron-down') ||
        event.target.classList.contains('codicon-chevron-right')) {
        if (dataManager.rowItems[rowId] instanceof SignalGroup) {
          dataManager.rowItems[rowId].toggleCollapse();
        }
    } else {
      this.events.dispatch(ActionType.SignalSelect, rowId);
    }
  }

  copyValueAtMarker(netlistId: NetlistId | undefined) {

    if (netlistId === undefined) {return;}
    const rowId = dataManager.netlistIdTable[netlistId];
    const value = this.valueAtMarker[rowId];
    if (value === undefined) {return;}
    const variableItem = dataManager.rowItems[rowId];
    if (!(variableItem instanceof VariableItem)) {return;}

    const formatString   = variableItem.valueFormat.formatString;
    const width          = variableItem.signalWidth;
    const bitVector      = value[value.length - 1];
    const formattedValue = formatString(bitVector, width, true);

    vscode.postMessage({command: 'copyToClipboard', text: formattedValue});
  }

  initializeDragHandler(event: MouseEvent | any) {
    this.labelsList        = Array.from(this.labels.querySelectorAll('.waveform-label'));
    this.pointerStartX     = event.clientX;
    this.pointerStartY     = event.clientY;
    this.scrollStartY      = this.labelsScroll.scrollTop;
    this.dragInProgress    = false;
    this.dragActive        = true;
  }

  setIdleItemsState(rowId: RowId) {
    // find all idle items and idle expanded dropus
    this.idleItems = [];
    this.idleGroups = [];
    let idleRowIds: number[] = [];
    viewerState.displayedSignals.forEach((id: RowId) => {
      if (id === rowId) {return;} // Skip the dragged item itself
      const signalItem = dataManager.rowItems[id];
      const rowIdList = signalItem.getFlattenedRowIdList(true, rowId);
      idleRowIds = idleRowIds.concat(rowIdList);
    });

    idleRowIds.forEach((id: RowId) => {
      const element = this.labels.querySelector(`#label-${id}`);
      const signalItem = dataManager.rowItems[id];
      if (signalItem instanceof SignalGroup) {
        if (element) {
          const boundingBox = element.getBoundingClientRect();
          this.idleGroups.push({
            element: element,
            top: boundingBox.top + this.labels.scrollTop,
            bottom: boundingBox.bottom + this.labels.scrollTop,
            left: element.children[1].getBoundingClientRect().left,
          });
        }
      }
    });
  }

  dragStart(event: any) {
    if (event.button !== 0) {return;} // Only allow left mouse button drag
    if (this.renameActive) {return;} // Prevent drag if rename is active
    //event.preventDefault();
    
    this.draggableItem = event.target.closest('.waveform-label');
    if (!this.draggableItem) {return;}
    const rowId = parseInt(this.draggableItem.id.split('-')[1]);
    if (isNaN(rowId)) {return;}
    this.draggableItem.classList.remove('is-idle');

    this.defaultDragDividerY = this.draggableItem.getBoundingClientRect().top + this.labelsScroll.scrollTop;
    clearTimeout(this.dragFreezeTimeout);
    this.dragFreeze = true;
    this.dragFreezeTimeout = setTimeout(() => {this.dragFreeze = false;}, 100);
    document.addEventListener('mousemove', this.dragMove);
    viewerState.mouseupEventType = 'rearrange';

    this.initializeDragHandler(event);
    this.setIdleItemsState(rowId);
  }

  dragStartExternal(event: MouseEvent | any) {

    this.initializeDragHandler(event);
    this.setIdleItemsState(-1);
    this.defaultDragDividerY = this.labels.getBoundingClientRect().bottom + this.labelsScroll.scrollTop;
    viewerState.mouseupEventType = 'dragAndDrop';
  }

  setDraggableItemClasses(isInternal: boolean) {
    if (isInternal) {
      if (!this.draggableItem) {return;}
      this.draggableItem.classList.remove('is-idle');
      this.draggableItem.children[0].classList.remove('is-selected');
      this.draggableItem.classList.add('is-draggable');
    }
    this.dragDivider = this.labels.querySelector('#drag-divider');
    if (this.dragDivider) {this.dragDivider.style.display = 'block'};
    this.dragInProgress = true;
  }

  dragMove(event: MouseEvent | any) {

    if (!this.dragActive) {return;}
    if (!this.draggableItem) {return;}
    if (this.dragFreeze) {return;}
    if (!this.dragInProgress) {
      this.setDraggableItemClasses(true);
    }

    const scrollOffsetY  = this.labelsScroll.scrollTop - this.scrollStartY;
    const pointerOffsetX = event.clientX - this.pointerStartX;
    const pointerOffsetY = event.clientY - this.pointerStartY + scrollOffsetY;
    this.draggableItem.style.transform = `translate(${pointerOffsetX}px, ${pointerOffsetY}px)`;

    this.updateIdleItemsStateAndPosition(event);
  }

  public dragMoveExternal(event: MouseEvent | any) {

    if (!this.dragInProgress) {
      this.dragStartExternal(event);
      this.setDraggableItemClasses(false);
    }

    this.updateIdleItemsStateAndPosition(event);
  }

  updateIdleItemsStateAndPosition(e) {

    const labelsRect        = this.labels.getBoundingClientRect();
    const draggableItemY    = e.clientY;
    const scrollDelta       = this.scrollStartY - this.labelsScroll.scrollTop;
    const pointerY          = draggableItemY - scrollDelta;
    this.groupContainer     = null;
    let groupContainerBox: any = labelsRect;
    let smallestGroupBox: any = Infinity;
    let width = 0;

    // Reset all idle items and groups
    if (e.clientX <= labelsRect.right) {
      this.idleGroups.forEach((item: any) => {
        if (item.element.classList.contains('is-idle') === false) {return;}
        if (item.element.classList.contains('expanded-group') === false) {return;}
        item.element.style.backgroundColor = 'transparent';
        if (item.top < pointerY && item.bottom > pointerY && e.clientX > item.left) {
          const groupHeight = item.bottom - item.top;
          if (groupHeight < smallestGroupBox) {
            smallestGroupBox = groupHeight;
            this.groupContainer = item.element;
            width = item.left;
          }
        }
      });
    }

    let idleItems: any  = [];
    if (this.groupContainer) {
      this.groupContainer.style.backgroundColor = 'var(--vscode-list-dropBackground)';
      groupContainerBox = this.groupContainer.children[1].getBoundingClientRect();
      idleItems = Array.from(this.groupContainer.children[1].children);
      this.closestItem = null;
    } else {
      idleItems = Array.from(this.labels.children);
    }

    let breakFlag = false;
    this.indexOffset = 0;
    let dragDividerY: number | null = groupContainerBox.top - labelsRect.top;

    idleItems.forEach((item: any) => {
      if (breakFlag) {return;}
      if (item.classList.contains('is-idle') === false) {return;}
      const itemRect = item.getBoundingClientRect();
      if (draggableItemY >= itemRect.top && draggableItemY < itemRect.bottom) {
        dragDividerY = itemRect.top - labelsRect.top;
        const itemY = itemRect.top + itemRect.height / 2;
        if (draggableItemY >= itemY) {
          this.indexOffset = 1;
          dragDividerY += itemRect.height;
        }
        breakFlag = true;
        this.closestItem = item;
      }
    });

    if (!breakFlag) {
      if (draggableItemY >= groupContainerBox.bottom) {
        dragDividerY = groupContainerBox.bottom - labelsRect.top;
        this.closestItem = idleItems[idleItems.length - 1];
        this.indexOffset = 1;
      } else if (draggableItemY < groupContainerBox.top) {
        dragDividerY = groupContainerBox.top - labelsRect.top;
        this.closestItem = idleItems[0] || null;
        this.indexOffset = 0;
      } else {
        dragDividerY = (this.defaultDragDividerY - this.labelsScroll.scrollTop) - labelsRect.top;
        this.closestItem = this.draggableItem;
        this.indexOffset = 0;
      }
    }

    if (this.dragDivider !== null && dragDividerY !== null) {
      this.dragDivider.style.top = `${dragDividerY}px`;
      this.dragDivider.style.left = width + 'px';
    }
  }

  public getDropIndex() {
    const newGroupRowId = this.getRowIdFromElement(this.groupContainer);
    let newGroupId = 0;
    if (newGroupRowId !== null) {
      newGroupId = dataManager.groupIdTable.indexOf(newGroupRowId);
      if (newGroupId === -1) {
        newGroupId = 0; // If the group is not found, default to group 0
      }
    }

    let newIndex = 0;
    const closestItemRowId = this.getRowIdFromElement(this.closestItem);
    if (closestItemRowId === null || isNaN(closestItemRowId)) {
      newIndex = 0;
    } else{
      const dropItemIndex  = getIndexInGroup(closestItemRowId, newGroupId) || 0;
      newIndex = dropItemIndex + this.indexOffset;
    }

    return {newGroupId, newIndex};
  }

  clearDragHandler() {
    this.idleItems.forEach((item: any) => {item.style = null;});
    this.idleItems      = [];
    this.labelsList     = [];
    this.dragInProgress = false;
    this.pointerStartX  = null;
    this.pointerStartY  = null;
    this.draggableItem  = null;
    this.dragActive     = false;
  }

  public dragEndExternal(event: MouseEvent | KeyboardEvent | null, abort) {
    this.clearDragHandler();
    if (abort) {this.renderLabelsPanels();}
    return this.getDropIndex();
  }

  dragEnd(event: MouseEvent | KeyboardEvent | null, abort) {

    document.removeEventListener('mousemove', this.dragMove);
    this.dragActive = false;
    if (!this.dragInProgress) {return;}
    if (!this.draggableItem) {return;}
    if (event) {event.preventDefault();}

    let {newGroupId, newIndex} = this.getDropIndex();

    const draggableItemRowId = this.getRowIdFromElement(this.draggableItem);
    if (draggableItemRowId === null || isNaN(draggableItemRowId)) {
      throw new Error("Invalid draggable item row ID: " + draggableItemRowId);
    }
    const oldGroupId = getParentGroupId(draggableItemRowId) || 0;
    const oldIndex   = getIndexInGroup(draggableItemRowId, oldGroupId) || 0;
    if (oldGroupId === newGroupId && newIndex > oldIndex) {
      newIndex = Math.max(newIndex - 1, 0);
    }

    this.clearDragHandler();
    clearTimeout(this.dragFreezeTimeout);

    if (!abort) {
      this.events.dispatch(ActionType.ReorderSignals, draggableItemRowId, newGroupId, newIndex);
    } else {
      this.renderLabelsPanels();
    }
  }

  public showRenameInput(rowId: RowId) {
    this.dragEnd(null, true); // Abort any drag operation
    const signalItem = dataManager.rowItems[rowId];
    if (!(signalItem instanceof SignalGroup)) {return;}
    const labelElement = document.getElementById(`label-${rowId}`);
    if (!labelElement) {return;}
    const waveformRow = labelElement.querySelector('.waveform-row');
    if (!waveformRow) {return;}
    waveformRow.classList.remove('is-selected');
    
    // Get the current name for the textarea
    const currentName = signalItem.label || '';
    waveformRow.innerHTML = `<textarea id="rename-input-${rowId}" class="rename-input" autocorrect="off" autocapitalize="off" spellcheck="false" wrap="off">${htmlSafe(currentName)}</textarea>`;
    this.renameActive = true;

    // Focus the textarea and select all text
    const textarea = document.getElementById(`rename-input-${rowId}`) as HTMLTextAreaElement;
    const oldName  = signalItem.label;
    if (!textarea) {return;}
    textarea.focus();
    textarea.select();

    // Handle Enter key to submit rename
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const newNameInput = textarea.value.trim() || signalItem.label;
        const parentGroupId = getParentGroupId(rowId) || 0;
        const isTaken = dataManager.groupNameExists(newNameInput, parentGroupId);
        const newName = isTaken ? oldName : newNameInput;
        e.preventDefault();
        this.finishRename(signalItem, waveformRow, newName);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.finishRename(signalItem, waveformRow, oldName);
      }
    });

    // Handle blur to cancel rename
    textarea.addEventListener('blur', () => {this.finishRename(signalItem, waveformRow, oldName);});
  }

  private finishRename(signalItem: SignalGroup, waveformRow: Element, newName: string) {
    if (!this.renameActive) {return;}
    this.renameActive     = false;
    signalItem.label      = newName ? newName.trim() : signalItem.label;
    waveformRow.innerHTML = signalItem.createWaveformRowContent();
    if (viewerState.selectedSignal === signalItem.rowId) {
      waveformRow.classList.add('is-selected');
    }
    sendWebviewContext();
  }

  getRowIdFromElement(element: HTMLElement | null): RowId | null {
    if (!element) {return null;}
    const id = element.id.split('-')[1];
    if (!id) {return null;}
    const rowId = parseInt(id);
    if (isNaN(rowId)) {return null;}
    return rowId;
  }

  handleResizeMousedown(event: MouseEvent, element: HTMLElement, index: number) {
    this.resizeIndex   = index;
    this.resizeElement = element;
    //event.preventDefault();
    this.resizeElement.classList.remove('is-idle');
    this.resizeElement.classList.add('is-resizing');
    document.addEventListener("mousemove", this.resize, false);
    viewerState.mouseupEventType = 'resize';
  }

  // resize handler to handle resizing
  resize(e: MouseEvent) {
    const gridTemplateColumns = this.webview.style.gridTemplateColumns;
    const column1 = parseInt(gridTemplateColumns.split(' ')[0]);
    const column2 = parseInt(gridTemplateColumns.split(' ')[1]);

    if (this.resizeIndex === 1) {
      this.webview.style.gridTemplateColumns = `${e.x}px ${column2}px auto`;
      this.resize1.style.left = `${e.x}px`;
      this.resize2.style.left = `${e.x + column2}px`;
    } else if (this.resizeIndex === 2) {
      const newWidth    = Math.max(10, e.x - column1);
      const newPosition = Math.max(10 + column1, e.x);
      this.webview.style.gridTemplateColumns = `${column1}px ${newWidth}px auto`;
      this.resize2.style.left = `${newPosition}px`;
    }
  }

  handleAddVariable(rowIdList: RowId[], updateFlag: boolean) {
    this.renderLabelsPanels();
  }

  handleRemoveVariable(rowId: any, recursive: boolean) {
    this.renderLabelsPanels();
  }

  handleReorderSignalsHierarchy(rowId: number, newGroupId: number, newIndex: number) {
    this.renderLabelsPanels();
  }

  handleMarkerSet(time: number, markerType: number) {

    if (time > viewport.timeStop || time < 0) {return;}

    if (markerType === 0) {
      viewerState.displayedSignalsFlat.forEach((rowId) => {
        const signalItem = dataManager.rowItems[rowId];
        this.valueAtMarker[rowId] = signalItem.getValueAtTime(time);
      });

      this.renderLabelsPanels();
    }
  }

  handleSignalSelect(rowId: RowId | null) {

    this.dragActive = false;
    if (this.dragDivider) {this.dragDivider.style.display = 'none'};
    if (rowId === null) {return;}

    viewerState.selectedSignal      = rowId;
    viewerState.selectedSignalIndex = viewerState.visibleSignalsFlat.findIndex((signal) => {return signal === rowId;});
    if (viewerState.selectedSignalIndex === -1) {viewerState.selectedSignalIndex = null;}
  
    this.renderLabelsPanels();
  }

  handleRedrawVariable(rowId: RowId) {
    this.renderLabelsPanels();
  }

  handleUpdateColor() {
    this.renderLabelsPanels();
  }
}
