import { EventHandler, viewport, arrayMove, NetlistId, ActionType, viewerState, dataManager, RowId, getChildrenByGroupId, getIndexInGroup} from './vaporview';
import { ValueFormat } from './value_format';
import { vscode, getParentGroupId } from './vaporview';
import { SignalGroup, VariableItem } from './signal_item';
import { clear } from 'console';
import { sign } from 'crypto';

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
  dragInProgress: boolean    = false;
  dragFreeze: boolean        = true;
  dragFreezeTimeout: any     = null;
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
    //this.handleReorderSignals  = this.handleReorderSignals.bind(this);
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
    //this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignalsHierarchy);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.updateColorTheme, this.handleUpdateColor);
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
    console.log("valueDisplay click event", event);
    const labelsList   = Array.from(this.valueDisplay.querySelectorAll('.value-display-item'));
    const clickedLabel = event.target.closest('.value-display-item');
    const itemIndex    = labelsList.indexOf(clickedLabel);
    if (itemIndex === -1) {return;}
    const rowId = viewerState.displayedSignals[itemIndex];
    this.events.dispatch(ActionType.SignalSelect, rowId);
  }

  clicklabel (event: any) {
    const clickedLabel = event.target.closest('.waveform-label');
    const rowId = parseInt(clickedLabel.id.split('-')[1]);
    if (isNaN(rowId)) {return;}

    if (event.target.classList.contains('codicon-chevron-down') ||
        event.target.classList.contains('codicon-chevron-right')) {
          console.log(`Toggling collapse for rowId: ${rowId}`);
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

  setDraggableItemClasses() {
    if (!this.draggableItem) {return;}
    this.draggableItem.classList.remove('is-idle');
    this.draggableItem.children[0].classList.remove('is-selected');
    this.draggableItem.classList.add('is-draggable');
    this.dragDivider = this.labels.querySelector('#drag-divider');
    if (this.dragDivider) {this.dragDivider.style.display = 'block'};
    this.dragInProgress = true;
  }

  setTreeItemDraggableClasses() {
    this.idleItems   = this.labelsList.filter((item: any) => {return item.classList.contains('is-idle');});
    this.dragDivider = this.labels.querySelector('#drag-divider');
    if (this.dragDivider) {this.dragDivider.style.display = 'block'};
  }


  dragStart(event: any) {
    if (event.button !== 0) {return;} // Only allow left mouse button drag
    //event.preventDefault();
    this.labelsList    = Array.from(this.labels.querySelectorAll('.waveform-label'));
    this.draggableItem = event.target.closest('.waveform-label');

    if (!this.draggableItem) {return;}
    const rowId = parseInt(this.draggableItem.id.split('-')[1]);
    if (isNaN(rowId)) {return;}

    this.draggableItem.classList.remove('is-idle');
    this.pointerStartX     = event.clientX;
    this.pointerStartY     = event.clientY;
    this.scrollStartY      = this.labelsScroll.scrollTop;
    this.dragInProgress    = false;
    this.dragFreeze        = true;
    this.defaultDragDividerY = this.draggableItem.getBoundingClientRect().top;
    clearTimeout(this.dragFreezeTimeout);
    this.dragFreezeTimeout = setTimeout(() => {this.dragFreeze = false;}, 100);
    document.addEventListener('mousemove', this.dragMove);
    viewerState.mouseupEventType = 'rearrange';

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
            left: boundingBox.left,
          });
        }
      }
      //if (element && element.classList.contains('is-idle')) {
      //  this.idleItems.push(element);
      //}
    });
  }

  dragMove(event: MouseEvent | any) {
    if (!this.draggableItem) {return;}
    if (this.dragFreeze) {return;}
    if (!this.dragInProgress) {
      this.setDraggableItemClasses();
    }

    const scrollOffsetY  = this.labelsScroll.scrollTop - this.scrollStartY;
    const pointerOffsetX = event.clientX - this.pointerStartX;
    const pointerOffsetY = event.clientY - this.pointerStartY + scrollOffsetY;

    this.draggableItem.style.transform = `translate(${pointerOffsetX}px, ${pointerOffsetY}px)`;

    this.updateIdleItemsStateAndPosition(event);
  }

  updateIdleItemsStateAndPosition(e) {

    const labelsRect        = this.labels.getBoundingClientRect();
    const draggableItemY    = e.clientY;
    const pointerY          = draggableItemY + this.labelsScroll.scrollTop;
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
        this.closestItem = idleItems[0];
        this.indexOffset = 0;
      } else {
        dragDividerY = this.defaultDragDividerY - labelsRect.top;
        this.closestItem = null;
        this.indexOffset = 0;
      }
    }

    if (this.dragDivider !== null && dragDividerY !== null) {
      this.dragDivider.style.top = `${dragDividerY}px`;
      this.dragDivider.style.left = width + 'px';
    }
  }

  dragEnd(event: MouseEvent | KeyboardEvent, abort) {
    document.removeEventListener('mousemove', this.dragMove);
    if (!this.dragInProgress) {return;}
    if (!this.draggableItem) {return;}
    event.preventDefault();

    const draggableItemRowId = this.getRowIdFromElement(this.draggableItem);
    if (draggableItemRowId === null || isNaN(draggableItemRowId)) {
      throw new Error("Invalid draggable item row ID: " + draggableItemRowId);
    }
    //const draggableItemIndex = getIndexInGroup(draggableItemRowId) || 0;
    const newIndex = this.getRowIdFromElement(this.closestItem) || 0 + this.indexOffset;
    const newGroupRowId = this.getRowIdFromElement(this.groupContainer);
    let newGroupId = 0;
    if (newGroupRowId !== null) {
      newGroupId = dataManager.groupIdTable.indexOf(newGroupRowId);
      if (newGroupId === -1) {
        newGroupId = 0; // If the group is not found, default to group 0
      }
    }

    this.idleItems.forEach((item: any) => {item.style = null;});

    if (!abort) {
      console.log("draggable Item Row ", draggableItemRowId, " in group ", newGroupId, " at index ", newIndex);
      // new
      this.events.dispatch(ActionType.ReorderSignals, draggableItemRowId, newGroupId, newIndex);
      // old
      //this.events.dispatch(ActionType.ReorderSignals, draggableItemIndex, newIndex);
    }

    this.labelsList            = [];
    this.idleItems             = [];
    this.dragInProgress        = false;
    this.pointerStartX         = null;
    this.pointerStartY         = null;
    this.draggableItem         = null;
    clearTimeout(this.dragFreezeTimeout);

    if (abort) {this.renderLabelsPanels();}
  }

  getRowIdFromElement(element: HTMLElement | null): RowId | null {
    console.log(element);
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

  handleRemoveVariable(rowId: any) {
    const index = viewerState.displayedSignals.findIndex((id: any) => {return id === rowId;});
    if (index === -1) {return;}
    viewerState.displayedSignals.splice(index, 1);
    this.renderLabelsPanels();
  }

  handleReorderSignals(oldIndex: number, newIndex: number) {

    if (this.draggableItem) {
      this.draggableItem.style   = null;
      this.draggableItem.classList.remove('is-draggable');
      this.draggableItem.classList.add('is-idle');
    } else {
      this.labelsList = Array.from(this.labels.querySelectorAll('.waveform-label'));
    }

    arrayMove(this.labelsList, oldIndex, newIndex);
    arrayMove(viewerState.displayedSignals, oldIndex, newIndex);
    this.renderLabelsPanels();
  }

  handleReorderSignalsHierarchy(rowId: number, newGroupId: number, newIndex: number) {

    const oldGroupId = getParentGroupId(rowId) || 0;
    const oldGroupChildren = getChildrenByGroupId(oldGroupId);
    const oldIndex = oldGroupChildren.indexOf(rowId);
    if (oldIndex === -1) {return;}
    if (oldGroupId === newGroupId) {
      arrayMove(oldGroupChildren, oldIndex, newIndex);
    } else {
      oldGroupChildren.splice(oldIndex, 1);
      const newGroupChildren = getChildrenByGroupId(newGroupId);
      if (newIndex >= newGroupChildren.length) {
        newGroupChildren.push(rowId);
      } else {
        newGroupChildren.splice(newIndex, 0, rowId);
      }
    }

    this.renderLabelsPanels();
  }

  handleMarkerSet(time: number, markerType: number) {

    if (time > viewport.timeStop || time < 0) {return;}

    if (markerType === 0) {
      viewerState.displayedSignals.forEach((rowId) => {
        const signalItem = dataManager.rowItems[rowId];
        this.valueAtMarker[rowId] = signalItem.getValueAtTime(time);
      });

      this.renderLabelsPanels();
    }
  }

  handleSignalSelect(rowId: RowId | null) {

    if (rowId === null) {return;}

    viewerState.selectedSignal      = rowId;
    viewerState.selectedSignalIndex = viewerState.displayedSignals.findIndex((signal) => {return signal === rowId;});
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
