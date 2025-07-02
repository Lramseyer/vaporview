import { EventHandler, viewport, arrayMove, NetlistId, ActionType, viewerState, dataManager, RowId} from './vaporview';
import { ValueFormat } from './value_format';
import { vscode } from './vaporview';
import { SignalGroup, VariableItem } from './signal_item';
import { clear } from 'console';

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
  draggableItem: any         = null;
  draggableItemIndex: any    = null;
  draggableItemNewIndex: any = null;
  pointerStartX: any         = null;
  pointerStartY: any         = null;
  scrollStartY: any          = null;
  resizeIndex: any           = null;
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
    this.handleReorderSignals  = this.handleReorderSignals.bind(this);
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
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawVariable);
    this.events.subscribe(ActionType.updateColorTheme, this.handleUpdateColor);
  }

  renderLabelsPanels() {
    this.labelsList  = [];
    const transitions: string[] = [];
    this.labelsList.push('<svg id="drag-divider" style="top: 0px; display:none"><line x1="0" y1="0" x2="100%" y2="0"></line></svg>');
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
    const labelsList   = Array.from(this.labels.querySelectorAll('.waveform-label'));
    const clickedLabel = event.target.closest('.waveform-label');
    const itemIndex    = labelsList.indexOf(clickedLabel);
    if (itemIndex === -1) {return;}
    const rowId = viewerState.displayedSignals[itemIndex];

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

  updateIdleItemsStateAndPosition() {
    const draggableItemRect = this.draggableItem.getBoundingClientRect();
    const labelsRect        = this.labels.getBoundingClientRect();
    const draggableItemY    = draggableItemRect.top + draggableItemRect.height / 2;

    let closestItemAbove: any = null;
    let closestItemBelow: any = null;
    let closestItemAboveRect: any = null;
    let closestItemBelowRect: any = null;
    let closestDistanceAbove  = Infinity;
    let closestDistanceBelow  = Infinity;

    this.idleItems.forEach((item: any) => {
      item.style.border = 'none';
      const itemRect = item.getBoundingClientRect();
      const itemY = itemRect.top + itemRect.height / 2;
      if (draggableItemY >= itemY) {
        const distance = draggableItemY - itemY;
        if (distance < closestDistanceAbove) {
          closestDistanceAbove = distance;
          closestItemAbove     = item;
          closestItemAboveRect = itemRect;
        }
      } else if (draggableItemY < itemY) {
        const distance = itemY - draggableItemY;
        if (distance < closestDistanceBelow) {
          closestDistanceBelow = distance;
          closestItemBelow     = item;
          closestItemBelowRect = itemRect;
        }
      }
    });

    const closestItemAboveIndex = Math.max(this.labelsList.indexOf(closestItemAbove), 0);
    let closestItemBelowIndex = this.labelsList.indexOf(closestItemBelow);
    if (closestItemBelowIndex === -1) {closestItemBelowIndex = this.labelsList.length - 1;}
    
    if (this.dragDivider !== null) {
      if (closestItemBelow !== null) {
        this.dragDivider.style.top = `${closestItemBelowRect.top - labelsRect.top}px`;
      } else if (closestItemAbove !== null) {
        this.dragDivider.style.top = `${closestItemAboveRect.top - labelsRect.top + closestItemAboveRect.height}px`;
      }
    }

    if (this.draggableItemIndex < closestItemAboveIndex) {
      this.draggableItemNewIndex = closestItemAboveIndex;
    } else if (this.draggableItemIndex > closestItemBelowIndex) {
      this.draggableItemNewIndex = closestItemBelowIndex;
    } else {
      this.draggableItemNewIndex = this.draggableItemIndex;
    }
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

  dragStart(event: any) {
    if (event.button !== 0) {return;} // Only allow left mouse button drag
    //event.preventDefault();
    this.labelsList    = Array.from(this.labels.querySelectorAll('.waveform-label'));
    this.draggableItem = event.target.closest('.waveform-label');

    if (!this.draggableItem) {return;}

    this.draggableItem.classList.remove('is-idle');
    this.pointerStartX     = event.clientX;
    this.pointerStartY     = event.clientY;
    this.scrollStartY      = this.labelsScroll.scrollTop;
    this.dragInProgress    = false;
    this.dragFreeze        = true;
    clearTimeout(this.dragFreezeTimeout);
    this.dragFreezeTimeout = setTimeout(() => {this.dragFreeze = false;}, 160);

    document.addEventListener('mousemove', this.dragMove);

    viewerState.mouseupEventType = 'rearrange';
    this.draggableItemIndex    = this.labelsList.indexOf(this.draggableItem);
    this.draggableItemNewIndex = this.draggableItemIndex;
    this.idleItems             = this.labelsList.filter((item: any) => {return item.classList.contains('is-idle');});
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

    this.updateIdleItemsStateAndPosition();
  }

  dragEnd(event: MouseEvent | KeyboardEvent, abort) {
    if (!this.dragInProgress) {return;}
    if (!this.draggableItem) {return;}
    event.preventDefault();

    this.idleItems.forEach((item: any) => {item.style = null;});
    document.removeEventListener('mousemove', this.dragMove);
    if (!abort) {
      this.events.dispatch(ActionType.ReorderSignals, this.draggableItemIndex, this.draggableItemNewIndex);
    }

    this.labelsList            = [];
    this.idleItems             = [];
    this.dragInProgress        = false;
    this.draggableItemIndex    = null;
    this.draggableItemNewIndex = null;
    this.pointerStartX         = null;
    this.pointerStartY         = null;
    this.draggableItem         = null;
    clearTimeout(this.dragFreezeTimeout);

    if (abort) {this.renderLabelsPanels();}
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