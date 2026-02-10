import { error, group } from 'console';
import { type NetlistId, SignalId, type RowId, StateChangeType, type DocumentId, SavedNetlistVariable, SavedSignalSeparator, SavedSignalGroup, CollapseState, SavedCustomVariable } from '../common/types';
import { Viewport } from './viewport';
import { LabelsPanels } from './labels';
import { ControlBar } from './control_bar';
import { RowHandler } from './row_handler';
import { WaveformDataManager } from './data_manager';
import { NetlistVariable, CustomVariable, SignalGroup, SignalSeparator, type RowItem } from './signal_item';
import { copyWaveDrom } from './wavedrom';

declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: any): void;
  setState(newState: any): void;
  getState(): any;
}

export enum DataType {
  None,
  Variable,
  Group,
}

export enum ActionType {
  MarkerSet,
  SignalSelect,
  Zoom,
  ReorderSignals,
  AddVariable,
  RemoveVariable,
  RedrawVariable,
  Resize,
  UpdateColorTheme,
  ExitBatchMode,
}

let resizeDebounce: any = 0;

export interface ViewerState {
  uri: any;
  documentId: DocumentId;
  markerTime: number | null;
  altMarkerTime: number | null;
  selectedSignal: RowId[];
  lastSelectedSignal: RowId | null;
  displayedSignals: number[];
  displayedSignalsFlat: number[];
  visibleSignalsFlat: RowId[]
  zoomRatio: number;
  scrollLeft: number;
  touchpadScrolling: boolean;
  autoTouchpadScrolling: boolean;
  mouseupEventType: string | null;
  autoReload: boolean;
}

export const viewerState: ViewerState = {
  uri: null,
  documentId: "",
  markerTime: null,
  altMarkerTime: null,
  selectedSignal: [],
  lastSelectedSignal: null,
  displayedSignals: [],
  displayedSignalsFlat: [],
  visibleSignalsFlat: [],
  zoomRatio: 1,
  scrollLeft: 0,
  touchpadScrolling: false,
  autoTouchpadScrolling: false,
  mouseupEventType: null,
  autoReload: false,
};

export class EventHandler {
  private subscribers: Map<ActionType, ((...args: any[]) => void)[]> = new Map();
  private batchMode: boolean = false;
  public get isBatchMode(): boolean {return this.batchMode;}
  private signalSelectArgs: any[] = [];

  enterBatchMode() {
    console.log("entering batch mode");
    this.batchMode = true;
  }

  exitBatchMode() {
    console.log("exiting batch mode");
    this.batchMode = false;
    this.dispatch(ActionType.SignalSelect, ...this.signalSelectArgs);
    this.dispatch(ActionType.ExitBatchMode);
  }

  subscribe(action: ActionType, callback: (...args: any[]) => void) {
    if (!this.subscribers.has(action)) {
      this.subscribers.set(action, []);
    }
    this.subscribers.get(action)?.push(callback);
  }

  dispatch(action: ActionType, ...args: any[]) {
    if (action === ActionType.SignalSelect) {
      this.signalSelectArgs = args;
      if (this.batchMode) {return;}
    } else if (action == ActionType.RedrawVariable) {
      if (this.batchMode) {return;}
    }
    this.subscribers.get(action)?.forEach((callback) => callback(...args));
  }
}

export function restoreState() {
  const state = vscode.getState();
  vscode.postMessage({
    command: 'restoreState',
    state: state,
    uri: viewerState.uri,
  });
}

export function updateDisplayedSignalsFlat() {
  viewerState.displayedSignalsFlat = [];
  viewerState.visibleSignalsFlat = [];
  viewerState.displayedSignals.forEach((rowId) => {
    const signalItem = rowHandler.rowItems[rowId];
    viewerState.displayedSignalsFlat = viewerState.displayedSignalsFlat.concat(signalItem.getFlattenedRowIdList(false, -1));
    viewerState.visibleSignalsFlat = viewerState.visibleSignalsFlat.concat(signalItem.getFlattenedRowIdList(true, -1));
  });
}

export function getParentGroupId(rowId: RowId | null): number | null {
  if (rowId === null) {return null;}
  if (viewerState.displayedSignals.includes(rowId)) {
    return 0;
  }
  for (const id of viewerState.displayedSignals) {
    const signalItem = rowHandler.rowItems[id];
    const parentGroupId = signalItem.findParentGroupId(rowId);
    if (parentGroupId !== null) {
      return parentGroupId;
    }
  };
  return null;
}

export function getParentGroupIdList(rowId: RowId | null | undefined): number[] {
  let result: number[] = [];
  if (rowId === null || rowId === undefined) {return result;}
  const parentGroupId = getParentGroupId(rowId);
  if (!parentGroupId) {return result;}
  const parentGroupRowId = rowHandler.groupIdTable[parentGroupId];
  if (parentGroupRowId === null) {return result;}
  result = getParentGroupIdList(parentGroupRowId);
  result.push(parentGroupId);

  return result;
}

export function getIndexInGroup(rowId: RowId, groupId: number | null) {
  let parentGroupId = groupId;
  if (parentGroupId === null) {parentGroupId = getParentGroupId(rowId);}
  if (parentGroupId === null) {return -1;}
  if (parentGroupId === 0) {return viewerState.displayedSignals.indexOf(rowId);}
  const groupRowId = rowHandler.groupIdTable[parentGroupId];
  const groupItem = rowHandler.rowItems[groupRowId];
  if (!(groupItem instanceof SignalGroup)) {
    return -1;
  }
  return groupItem.children.indexOf(rowId);
}

export function getChildrenByGroupId(groupId: number) {
  if (groupId === 0) {
    return viewerState.displayedSignals;
  }
  const groupRowId = rowHandler.groupIdTable[groupId];
  const groupItem = rowHandler.rowItems[groupRowId];
  if (!(groupItem instanceof SignalGroup)) {
    return [];
  }
  return groupItem.children;
}

export function revealSignal(rowId: RowId) {
  if (rowId === null) {return;}

  const parentList = getParentGroupIdList(rowId);

  parentList.forEach((groupId) => {
    const groupRowId = rowHandler.groupIdTable[groupId];
    if (groupRowId === undefined) {return;}
    const groupItem: RowItem = rowHandler.rowItems[groupRowId];
    if (!(groupItem instanceof SignalGroup)) {return;}
    if (groupItem.collapseState === CollapseState.Collapsed) {
      groupItem.expand();
    }
  });

  const labelElement = document.getElementById(`label-${rowId}`);
  const labelsPanel  = vaporview.labelsScroll;
  if (!labelElement) {return;}
  const labelBounds  = labelElement.getBoundingClientRect();
  const windowBounds = labelsPanel.getBoundingClientRect();
  let newScrollTop   = labelsPanel.scrollTop;

  if (labelBounds.top < windowBounds.top + RULER_HEIGHT) {
    newScrollTop = Math.max(0, labelsPanel.scrollTop + (labelBounds.top - (windowBounds.top + RULER_HEIGHT)));
  } else if (labelBounds.bottom > windowBounds.bottom) {
    newScrollTop = Math.min(labelsPanel.scrollHeight - labelsPanel.clientHeight, labelsPanel.scrollTop + (labelBounds.bottom - windowBounds.bottom) + WAVE_HEIGHT);
  }

  if (newScrollTop !== labelsPanel.scrollTop) {
    vaporview.syncVerticalScroll({deltaY: 0}, newScrollTop);
  }
}

export function handleClickSelection(event: MouseEvent, rowId: RowId) {
  let newSelection: RowId[] = [rowId];
  if (viewerState.selectedSignal.length === 0 || viewerState.lastSelectedSignal === null) {
    // No existing selection, just select the clicked row
  }
  else if (event.shiftKey) {
    const lastSelectedIndex = viewerState.visibleSignalsFlat.indexOf(viewerState.lastSelectedSignal);
    const clickedIndex      = viewerState.visibleSignalsFlat.indexOf(rowId);
    const startIndex        = Math.min(lastSelectedIndex, clickedIndex);
    const endIndex          = Math.max(lastSelectedIndex, clickedIndex);
    const addedSignals      = viewerState.visibleSignalsFlat.slice(startIndex, endIndex + 1).filter(id => !viewerState.selectedSignal.includes(id));
    newSelection            = viewerState.selectedSignal.concat(addedSignals);
  } else if (event.ctrlKey || event.metaKey) {
    if (viewerState.selectedSignal.includes(rowId)) {
      newSelection = viewerState.selectedSignal.filter(id => id !== rowId);
    } else {
      newSelection = viewerState.selectedSignal.concat([rowId]);
    }
  }
  events.dispatch(ActionType.SignalSelect, newSelection, rowId);
  console.log('handleClickSelection');
  sendWebviewContext(StateChangeType.User);
}

export const WAVE_HEIGHT = parseInt(window.getComputedStyle(document.body).getPropertyValue('--waveform-height'));
export const RULER_HEIGHT = parseInt(window.getComputedStyle(document.body).getPropertyValue('--ruler-height'));

export function getRowHeightCssClass(height: number) {
  switch (height) {
    case 2:  {return "height2x";}
    case 4:  {return "height4x";}
    case 8:  {return "height8x";}
    default: {return "height1x";}
  }
}

// ----------------------------------------------------------------------------
// Event handler helper functions
// ----------------------------------------------------------------------------

export function sendDisplayedSignals() {
  vscode.postMessage({
    command: 'setDisplayedSignals',
    signals: viewerState.displayedSignals
  });
}

function createWebviewContext() {
  let selectedNetlistId: any = null; 
  if (viewerState.selectedSignal.length === 1) {
    const data = rowHandler.rowItems[viewerState.selectedSignal[0]];
    if (data instanceof NetlistVariable) {
      selectedNetlistId = data.netlistId;
    }
  }
  return  {
    markerTime: viewerState.markerTime,
    altMarkerTime: viewerState.altMarkerTime,
    displayTimeUnit: viewport.displayTimeUnit,
    selectedSignal: selectedNetlistId,
    selectedSignalCount: viewerState.selectedSignal.length,
    transitionCount: dataManager.getTransitionCount(),
    zoomRatio: vaporview.viewport.zoomRatio,
    scrollLeft: Math.round(vaporview.viewport.timeScrollLeft),
    autoReload: viewerState.autoReload,
    displayedSignals: signalListForSaveFile(viewerState.displayedSignals),
  }
}

function signalListForSaveFile(rowIdList: RowId[]): any[] {
  const result: any[] = [];
  rowIdList.forEach((rowId) => {
    const data = rowHandler.rowItems[rowId];
    if (data instanceof SignalGroup) {
      result.push({
        dataType:  "signal-group",
        groupName: data.label,
        collapseState: data.collapseState,
        children:  signalListForSaveFile(data.children)
      } as SavedSignalGroup);
    } else if (data instanceof SignalSeparator) {
      result.push({
        dataType: "signal-separator",
        label:    data.label,
        rowHeight: data.rowHeight,
      } as SavedSignalSeparator);
    } else if (data instanceof CustomVariable) {
      // do nothing for now
    }
    if (!(data instanceof NetlistVariable)) {return;}

    const netlistId = data.netlistId;
    result.push({
      dataType:         "netlist-variable",
      netlistId:        netlistId,
      name:             data.scopePath + "." + data.signalName,
      numberFormat:     data.valueFormat.id,
      colorIndex:       data.colorIndex,
      rowHeight:        data.rowHeight,
      verticalScale:    data.verticalScale,
      nameType:         data.nameType,
      customName:       data.customName,
      renderType:       data.renderType.id,
      valueLinkCommand: data.valueLinkCommand,
    } as SavedNetlistVariable);
  });
  return result;
}

export function sendWebviewContext(stateChangeType: number) {
  if (events.isBatchMode) {return;}
  const context: any = createWebviewContext();
  context.stateChangeType = stateChangeType;
  vscode.setState(context);
  context.command = 'contextUpdate';
  vscode.postMessage(context);
}

export function outputLog(message: string) {
  vscode.postMessage({ command: 'logOutput', message: message });
}

class VaporviewWebview {

  // HTML Elements
  webview: HTMLElement;
  labelsScroll: HTMLElement;
  valuesScroll: HTMLElement;
  scrollArea: HTMLElement;
  contentArea: HTMLElement;
  scrollbar: HTMLElement;

  // Components
  viewport: Viewport;
  controlBar: ControlBar;

  // event handler variables
  events: EventHandler;

  lastIsTouchpad: boolean = false;
  touchpadCheckTimer: any = 0;

  constructor(
    events: EventHandler, 
    viewport: Viewport, 
    controlBar: ControlBar
  ) {

    this.events     = events;
    this.viewport   = viewport;
    this.controlBar = controlBar;
    // Assuming you have a reference to the webview element
    const webview       = document.getElementById('vaporview-top');
    const labelsScroll  = document.getElementById('waveform-labels-container');
    const valuesScroll  = document.getElementById('value-display-container');
    const scrollArea    = document.getElementById('scrollArea');
    const contentArea   = document.getElementById('contentArea');
    const scrollbar     = document.getElementById('scrollbar');

    if (webview === null || labelsScroll === null || valuesScroll === null ||
      scrollArea === null || contentArea === null || scrollbar === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview      = webview;
    this.labelsScroll = labelsScroll;
    this.valuesScroll = valuesScroll;
    this.scrollArea   = scrollArea;
    this.contentArea  = contentArea;
    this.scrollbar    = scrollbar;

    webview.style.gridTemplateColumns = `150px 50px auto`;

    // #region Primitive Handlers
    window.addEventListener('message', (e) => {this.handleMessage(e);});
    window.addEventListener('keydown', (e) => {this.keyDownHandler(e);});
    window.addEventListener('keyup',   (e) => {this.keyUpHandler(e);});
    window.addEventListener('mouseup', (e) => {this.handleMouseUp(e, false);});
    window.addEventListener('resize',  ()  => {this.handleResizeViewer();}, false);
    window.addEventListener('blur',    ()  => {this.handleFocusBlur(false);});
    window.addEventListener('focus',   ()  => {this.handleFocusBlur(true);});
    this.scrollArea.addEventListener(  'wheel', (e) => {this.scrollHandler(e);});
    this.scrollArea.addEventListener(  'scroll', () => {this.handleViewportScroll();});
    this.labelsScroll.addEventListener('wheel', (e) => {this.syncVerticalScroll(e, labelsScroll.scrollTop);});
    this.valuesScroll.addEventListener('wheel', (e) => {this.syncVerticalScroll(e, valuesScroll.scrollTop);});
    this.webview.addEventListener('dragover', (e) => {labelsPanel.dragMoveExternal(e);});
    this.webview.addEventListener('drop', (e) => {this.handleDrop(e);});

    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleMarkerSet    = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.reorderSignals     = this.reorderSignals.bind(this);

    this.events.subscribe(ActionType.Resize, this.handleRemoveVariable);
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.reorderSignals);
  }

  // Function to test whether or not the user is using a touchpad
  // Sometimes it returns false negatives when flicking the touchpad,
  // hence the timer to prevent multiple checks in a short period of time
  isTouchpad(e: any) {

    if (performance.now() < this.touchpadCheckTimer) {
      return this.lastIsTouchpad;
    }

    if (e.wheelDeltaY) {
      if (e.wheelDeltaY === (e.deltaY * -3)) {
        this.lastIsTouchpad = true;
        return true;
      }
    //} else if (e.wheelDeltaX && !e.shiftKey) {
    //  if (e.wheelDeltaX === (e.deltaX * -3)) {
    //    this.lastIsTouchpad = true;
    //    return true;
    //  }
    } else if (e.deltaMode === 0) {
      this.lastIsTouchpad = true;
      return true;
    }
    this.lastIsTouchpad = false;
    return false;
  }

  scrollHandler(e: any) {
    e.preventDefault();
    //console.log(event);
    //if (!isTouchpad) {e.preventDefault();}

    const deltaY = e.deltaY;
    const deltaX = e.deltaX;
    const touchpadScrollDivisor = 18;
    const mouseMode = !viewerState.autoTouchpadScrolling && !viewerState.touchpadScrolling;

    if (e.shiftKey) {
      e.stopPropagation();
      this.scrollArea.scrollTop      += deltaY || deltaX;
      this.labelsScroll.scrollTop     = this.scrollArea.scrollTop;
      this.valuesScroll.scrollTop = this.scrollArea.scrollTop;
    } else if (e.ctrlKey) {
      if      (this.viewport.updatePending) {return;}
      // Touchpad mode detection returns false positives with pinches, so we
      // just clamp the deltaY value to prevent zooming in/out too fast
      const bounds      = this.scrollArea.getBoundingClientRect();
      const pixelLeft   = Math.round(e.pageX - bounds.left);
      const time        = Math.round((pixelLeft + this.viewport.pseudoScrollLeft) * this.viewport.pixelTime);
      const zoomOffset  = Math.min(touchpadScrollDivisor, Math.max(-touchpadScrollDivisor, deltaY));

      //if (deltaY !== zoomOffset) {console.log('deltaY: ' + deltaY + '; zoomOffset: ' + zoomOffset);}
      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (mouseMode && (deltaY > 0)) {this.events.dispatch(ActionType.Zoom, 1, time, pixelLeft);}
      else if (mouseMode && (deltaY < 0)) {this.events.dispatch(ActionType.Zoom,-1, time, pixelLeft);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else {
        this.events.dispatch(ActionType.Zoom, zoomOffset / touchpadScrollDivisor, time, pixelLeft);
      }

    } else {
      //if (isTouchpad) {
      //  this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + e.deltaX);
      //  this.scrollArea.scrollTop       += e.deltaY;
      //  this.labelsScroll.scrollTop      = this.scrollArea.scrollTop;
      //  this.valuesScroll.scrollTop  = this.scrollArea.scrollTop;
      //} else {
      //  this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + deltaY);
      //}

      const isTouchpad = viewerState.autoTouchpadScrolling ? this.isTouchpad(e) : viewerState.touchpadScrolling;
      this.touchpadCheckTimer = performance.now() + 100;

      if (e.deltaX !== 0 || isTouchpad) {
        this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + deltaX);
        this.scrollArea.scrollTop  += e.deltaY;
        this.labelsScroll.scrollTop = this.scrollArea.scrollTop;
        this.valuesScroll.scrollTop = this.scrollArea.scrollTop;
      } else {
        this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + deltaY);
      }
    }
  }

  keyDownHandler(e: any) {

    let updateState = false;

    if (controlBar.searchInFocus || labelsPanel.renameActive) {return;} 
    else {e.preventDefault();}

    // debug handler to print the data cache
    if (e.key === 'd' && e.ctrlKey) {
      console.log(this.viewport.updatePending);
      console.log(viewerState);
      console.log(rowHandler.rowItems);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition

    let selectedSignalIndex: number | null = null;
    if (viewerState.lastSelectedSignal !== null) {
      selectedSignalIndex = viewerState.visibleSignalsFlat.indexOf(viewerState.lastSelectedSignal);
    }

    if ((e.key === 'ArrowRight') && (viewerState.markerTime !== null)) {
      if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0); updateState = true;}
      else if (e.altKey || e.ctrlKey) {/* Do nothing */}
      else           {controlBar.goToNextTransition(1, []);}
    } else if ((e.key === 'ArrowLeft') && (viewerState.markerTime !== null)) {
      if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, 0, 0); updateState = true;}
      else if (e.altKey || e.ctrlKey) {/* Do nothing */}
      else           {controlBar.goToNextTransition(-1, []);}


    // up and down arrow keys move the selected signal
    // alt + up and down arrow keys reorder the selected signal up and down
    } else if ((e.key === 'ArrowUp') && (selectedSignalIndex !== null)) {
      const newIndex = Math.max(selectedSignalIndex - 1, 0);
      const newRowId = viewerState.visibleSignalsFlat[newIndex];
      if (e.altKey) {this.handleReorderArrowKeys(-1);}
      else          {this.events.dispatch(ActionType.SignalSelect, [newRowId], newRowId); updateState = true;}
    } else if ((e.key === 'ArrowDown') && (selectedSignalIndex !== null)) {
      const newIndex = Math.min(selectedSignalIndex + 1, viewerState.visibleSignalsFlat.length - 1);
      const newRowId = viewerState.visibleSignalsFlat[newIndex];
      if (e.altKey) {this.handleReorderArrowKeys(1);}
      else          {this.events.dispatch(ActionType.SignalSelect, [newRowId], newRowId); updateState = true;}
    }

    // handle Home and End keys to move to the start and end of the waveform
    else if (e.key === 'Home') {this.events.dispatch(ActionType.MarkerSet, 0, 0); updateState = true;}
    else if (e.key === 'End')  {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0); updateState = true;}

    // "N" and Shift + "N" go to the next transition
    else if (e.key === 'n') {controlBar.goToNextTransition(1, []);}
    else if (e.key === 'N') {controlBar.goToNextTransition(-1, []);}

    else if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !controlBar.searchInFocus && !labelsPanel.renameActive) {
      e.preventDefault();
      controlBar.defocusSearchBar();
      this.events.dispatch(ActionType.SignalSelect, viewerState.displayedSignalsFlat, null);
      updateState = true;
    }

    else if (e.key === 'Escape') {this.handleMouseUp(e, true);}
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      viewerState.selectedSignal.forEach((rowId) => {
        const rowItem = rowHandler.rowItems[rowId];
        if (rowItem instanceof SignalGroup && rowItem.children.length > 0) {return;}
        rowHandler.removeVariable(undefined, rowId, true);
      });
    }

    else if (e.key === 'Control' || e.key === 'Meta') {viewport.setValueLinkCursor(true);}

    if (updateState) {
      console.log('keyDownHandler');
      sendWebviewContext(StateChangeType.User);
    }
  }

  handleReorderArrowKeys(direction: number) {

    if (viewerState.selectedSignal.length !== 1) {return;}
    const rowId = viewerState.selectedSignal[0];
    if (rowId === null) {return;}
    let parentGroupId = getParentGroupId(rowId);
    let parentList: RowId[] = [];
    if (parentGroupId === null) {return;}
    if (parentGroupId === 0) {
      parentList = viewerState.displayedSignals;
    } else {
      const parentRowId = rowHandler.groupIdTable[parentGroupId];
      const parentItem = rowHandler.rowItems[parentRowId];
      if (!(parentItem instanceof SignalGroup)) {return;}
      parentList = parentItem.children;
    }

    const localIndex = getIndexInGroup(rowId, parentGroupId);
    let newIndex = localIndex + direction;

    // First check to see if we're moving it outside the parent group
    if (newIndex < 0 || newIndex >= parentList.length) {
      const parentGroupRowId = rowHandler.groupIdTable[parentGroupId];
      const grandparentGroupId = getParentGroupId(parentGroupRowId);
      if (grandparentGroupId === null) {return;}
      const parentIndex = getIndexInGroup(rowHandler.groupIdTable[parentGroupId], grandparentGroupId);
      newIndex = parentIndex;
      if (direction > 0) {newIndex += direction;}
      parentGroupId = grandparentGroupId;
    } else {
      // if the adjacent row is a group, and the group is expanded, we place it in the top or bottom of the group
      const adjacentRowId = parentList[newIndex];
      const adjacentGroupId = rowHandler.groupIdTable.indexOf(adjacentRowId);
      if (adjacentGroupId !== -1) {
        const groupItem = rowHandler.rowItems[rowHandler.groupIdTable[adjacentGroupId]];
        if (groupItem instanceof SignalGroup && groupItem.collapseState === CollapseState.Expanded) {
          parentGroupId = adjacentGroupId;
          if (direction > 0) {newIndex = 0;}
          else {
            const adjacentGroup = rowHandler.rowItems[rowHandler.groupIdTable[adjacentGroupId]];
            if (!(adjacentGroup instanceof SignalGroup)) {return;}
            newIndex = adjacentGroup.children.length;
          }
        }
      // not sure why, but we need to increment the index if moving down
      } else if (direction > 0) {
        newIndex += 1;
      }
    }

    this.events.dispatch(ActionType.ReorderSignals, [rowId], parentGroupId, newIndex);
    console.log('handleReorderArrowKeys');
    sendWebviewContext(StateChangeType.User);
  }

  updateVerticalScale(event: any, scale: number) {
    let rowIdList: RowId[] = viewerState.selectedSignal;
    if (event && event.rowId !== undefined && !viewerState.selectedSignal.includes(event.rowId)) {
      rowIdList = [event.rowId];
    }

    rowIdList.forEach((rowId) => {
      if (rowId === null) {return;}
      const netlistData = rowHandler.rowItems[rowId];
      if (!(netlistData instanceof NetlistVariable) && !(netlistData instanceof CustomVariable)) {return;}
      const renderType = netlistData.renderType.id;
      if (renderType === "multiBit" || renderType === "binary") {return;}
      netlistData.verticalScale = Math.max(1, netlistData.verticalScale * scale);
      this.events.dispatch(ActionType.RedrawVariable, rowId);
    }); 
  }

  externalKeyDownHandler(e: any) {
    switch (e.keyCommand) {
      case 'nextEdge': {controlBar.goToNextTransition(1, []); break;}
      case 'previousEdge': {controlBar.goToNextTransition(-1, []); break}
      case 'zoomToFit': {this.events.dispatch(ActionType.Zoom, Infinity, 0, 0); break}
      case 'increaseVerticalScale': {this.updateVerticalScale(e.event, 2); break;}
      case 'decreaseVerticalScale': {this.updateVerticalScale(e.event, 0.5); break;}
      case 'resetVerticalScale':    {this.updateVerticalScale(e.event, 0); break;}
    }
  }

  keyUpHandler(e: any) {
    if (e.key === 'Control' || e.key === 'Meta') {viewport.setValueLinkCursor(false);}
  }

  handleFocusBlur(state: boolean) {
    vscode.postMessage({
      command: 'executeCommand',
      commandName: 'setContext', 
      args: ['vaporview.waveformViewerFocused', state]
    });
  }

  handleMouseUp(event: MouseEvent | KeyboardEvent, abort: boolean) {
    //console.log('mouseup event type: ' + viewerState.mouseupEventType);
    if (viewerState.mouseupEventType === 'rearrange') {
      labelsPanel.dragEnd(event, abort);
    } else if (viewerState.mouseupEventType === 'dragAndDrop') {
      labelsPanel.dragEndExternal(event, abort);
    } else if (viewerState.mouseupEventType === 'resize') {
      labelsPanel.resizeElement.classList.remove('is-resizing');
      labelsPanel.resizeElement.classList.add('is-idle');
      document.removeEventListener("mousemove", labelsPanel.resize, false);
      this.handleResizeViewer();
    } else if (viewerState.mouseupEventType === 'scroll') {
      this.scrollbar.classList.remove('is-dragging');
      document.removeEventListener('mousemove', this.viewport.handleScrollbarMove);
      this.viewport.scrollbarMoved = false;
    } else if (viewerState.mouseupEventType === 'highlightZoom') {
      this.scrollArea.removeEventListener('mousemove', viewport.drawHighlightZoom, false);
      viewport.highlightListenerSet = false;
      viewport.highlightZoom(abort);
    } else if (viewerState.mouseupEventType === 'markerSet') {
      this.scrollArea.removeEventListener('mousemove', viewport.drawHighlightZoom, false);
      clearTimeout(viewport.highlightDebounce);
      viewport.handleScrollAreaClick(viewport.highlightStartEvent, 0);
      viewport.highlightListenerSet = false;
      if (viewport.highlightElement) {
        viewport.highlightElement.remove();
        viewport.highlightElement = null;
      }
    } else if (viewerState.mouseupEventType === null && abort) {
      if (!labelsPanel.renameActive) {
        this.events.dispatch(ActionType.SignalSelect, [], null);
        console.log('handleMouseUp');
        sendWebviewContext(StateChangeType.User);
      }
    }
    viewerState.mouseupEventType = null;
  }

  // #region Global Events
  reorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {
    let lastSelectedRowId: RowId | null = viewerState.lastSelectedSignal;
    if (rowIdList.length === 1) {lastSelectedRowId = rowIdList[0];}
    //this.events.dispatch(ActionType.SignalSelect, [rowIdList], lastSelectedRowId);
  }

  handleResizeViewer() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(this.events.dispatch.bind(this.events, ActionType.Resize), 100);
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.viewport.timeStop || time < 0) {return;}

    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'markerSet',
      uri: viewerState.uri,
      time: time,
      units: this.viewport.timeUnit,
    });
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null = null) {

    //const filteredRowIdList = dataManager.removeChildrenFromSignalList(rowIdList);

    //if (rowIdList.length === 0) {return;}
    viewerState.lastSelectedSignal = lastSelected;
    viewerState.selectedSignal = rowIdList;

    //if (lastSelected === null) {return;}
    if (rowIdList.length > 0) {
      revealSignal(rowIdList[0]);
    }
    viewerState.selectedSignal = rowIdList;

    const netlistIdList: number[] = [];
    const instancePathList: string[] = [];
    rowIdList.forEach(rowId => {
      const netlistData = rowHandler.rowItems[rowId];
      if (netlistData === undefined) {return;}
      if (!(netlistData instanceof NetlistVariable)) {return;}
      netlistIdList.push(netlistData.netlistId);
      let instancePath = netlistData.scopePath + '.' + netlistData.signalName;
      if (netlistData.scopePath === "") {instancePath = netlistData.signalName;}
      instancePathList.push(instancePath);
    });

    if (rowIdList.length === 1) {
      vscode.postMessage({
        command: 'emitEvent',
        eventType: 'signalSelect',
        uri: viewerState.uri,
        instancePath: instancePathList,
        netlistId: netlistIdList,
      });
    }
  }

// #region Helper Functions

  syncVerticalScroll(e: any, scrollLevel: number) {
    const deltaY = e.deltaY;
    if (this.viewport.updatePending) {return;}
    this.viewport.updatePending = true;
    this.labelsScroll.scrollTop = scrollLevel + deltaY;
    this.valuesScroll.scrollTop = scrollLevel + deltaY;
    this.scrollArea.scrollTop   = scrollLevel + deltaY;
    // labelsScroll position = relative, which allows it to scroll past the bottom
    this.labelsScroll.scrollTop = this.scrollArea.scrollTop;
    viewport.renderAllWaveforms(false);
    labelsPanel.dragMove(e);
    this.viewport.updatePending = false;
  }

  handleViewportScroll() {
    if (this.viewport.updatePending) {return;}
    this.viewport.updatePending = true;
    this.labelsScroll.scrollTop = this.scrollArea.scrollTop;
    this.valuesScroll.scrollTop = this.scrollArea.scrollTop;
    viewport.renderAllWaveforms(false);
    this.viewport.updatePending = false;
  }

  unload() {
    viewerState.selectedSignal       = [];
    viewerState.markerTime           = null;
    viewerState.altMarkerTime        = null;
    viewerState.displayedSignals     = [];
    viewerState.displayedSignalsFlat = [];
    viewerState.visibleSignalsFlat   = [];
    viewerState.zoomRatio            = 1;
    dataManager.unload();
    labelsPanel.renderLabelsPanels();
    // we don't need to do anything to the viewport, because the ready message will reinitialize it
    vscode.postMessage({command: 'ready'});
  }

  handleRemoveVariable(rowIdList: RowId[], recursive: boolean) {
    const instancePathList: string[] = [];
    const netlistIdList: number[] = []
    rowIdList.forEach(rowId => {
      const signalItem = rowHandler.rowItems[rowId];
      if (!(signalItem instanceof NetlistVariable)) {return;}
      netlistIdList.push(signalItem.netlistId);
      instancePathList.push(signalItem.scopePath + '.' + signalItem.signalName);
    });
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'removeVariable',
      uri: viewerState.uri,
      instancePath: instancePathList,
      netlistId: netlistIdList,
    });
  }

  handleSetConfigSettings(settings: any) {
    if (settings.scrollingMode !== undefined) {
      controlBar.setScrollMode(settings.scrollingMode);
    }
    if (settings.rulerLines !== undefined) {
      this.viewport.setRulerLines(settings.rulerLines);
    }
    if (settings.fillMultiBitValues !== undefined) {
      this.viewport.fillMultiBitValues = settings.fillMultiBitValues;
      this.viewport.renderAllWaveforms(true);
      this.viewport.setRulerVscodeContext();
    }
    if (settings.customColors !== undefined) {
      dataManager.customColorKey = settings.customColors;
    }
  }

  handleSetSelectedSignal(netlistId: NetlistId | undefined) {
    if (netlistId === undefined) {return;}
    const rowIdList = rowHandler.getRowIdsFromNetlistId(netlistId);
    if (rowIdList.length === 0) {return;}
    this.events.dispatch(ActionType.SignalSelect, rowIdList, rowIdList[0]);
    console.log('handleSetSelectedSignal');
    sendWebviewContext(StateChangeType.User);
  }

  handleDrop(e: DragEvent) {
    e.preventDefault();

    if (!e.dataTransfer) {return;}
    const data    = e.dataTransfer.getData('codeeditors');
    if (!data) {return;}
    const dataObj = JSON.parse(data);
    const uriList = dataObj.map((d: any) => {return d.resource;});

    const {newGroupId, newIndex} = labelsPanel.dragEndExternal(e, false);

    // get the group path for the new group id
    let groupPath: string[] = [];
    const groupRowId = rowHandler.groupIdTable[newGroupId];
    if (groupRowId || groupRowId === 0) {
      groupPath = getParentGroupIdList(groupRowId).map((id) => {
        const item = rowHandler.rowItems[rowHandler.groupIdTable[id]];
        if (item instanceof SignalGroup) {
          return item.label;
        }
        return '';
      });
      const groupItem = rowHandler.rowItems[groupRowId];
      if (groupItem instanceof SignalGroup) {
        groupPath.push(groupItem.label);
      }
    }

    vscode.postMessage({
      command: 'handleDrop',
      groupPath: groupPath,
      dropIndex: newIndex,
      resourceUriList: uriList,
      uri: viewerState.uri,
    });
  }

  handleMessage(e: any) {
    const message = e.data;

    switch (message.command) {
      case 'initViewport':          {this.viewport.init(message.metadata, message.uri, message.documentId); break;}
      case 'unload':                {this.unload(); break;}
      case 'setConfigSettings':     {this.handleSetConfigSettings(message); break;}
      case 'getContext':            {sendWebviewContext(StateChangeType.None); break;}
      case 'apply-state':           {rowHandler.applyState(message.settings, message.stateChangeType); break;}
      case 'add-variable':          {rowHandler.addVariable(message.signalList, message.groupPath, undefined, message.index); break;}
      case 'add-separator':         {rowHandler.addSeparator(message.name, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected); break;}
      case 'add-bit-slice':         {rowHandler.addBitSlice(message.name, message.groupPath, message.parentGroupId, message.eventRowId, undefined, message.msb, message.lsb); break;}
      case 'newSignalGroup':        {rowHandler.addSignalGroup(message.groupName, message.groupPath, message.parentGroupId, message.eventRowId, message.moveSelected); break;}
      case 'setDisplayFormat':      {rowHandler.setDisplayFormat(message); break;}
      case 'renameSignalGroup':     {rowHandler.renameSignalGroup(message.rowId, message.groupName); break;}
      case 'editSignalGroup':       {rowHandler.editSignalGroup(message); break;}
      case 'remove-signal':         {rowHandler.removeVariable(message.netlistId, message.rowId, message.removeAllSelected); break;}
      case 'remove-group':          {rowHandler.removeSignalGroup(message.groupId, message.recursive); break;}
      case 'remove-separator':      {rowHandler.removeVariable(undefined, message.rowId, message.removeAllSelected); break;}
      case 'update-waveform-chunk': {dataManager.updateWaveformChunk(message); break;}
      case 'update-waveform-chunk-compressed': {dataManager.updateWaveformChunkCompressed(message); break;}
      case 'update-enum-chunk':     {dataManager.updateEnumChunk(message); break;}
      case 'handle-keypress':       {this.externalKeyDownHandler(message); break;}
      case 'setWaveDromClock':      {dataManager.waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'setMarker':             {this.events.dispatch(ActionType.MarkerSet, message.time, message.markerType); console.log('handleMessage - setMarker'); sendWebviewContext(StateChangeType.User); break;}
      case 'setViewportTo':         {this.viewport.moveViewToTime(message.time); break;}
      case 'setViewportRange':      {this.viewport.setViewportRange(message.startTime, message.endTime); break;}
      case 'setTimeUnits':          {this.viewport.updateUnits(message.units, true); break;}
      case 'setSelectedSignal':     {this.handleSetSelectedSignal(message.netlistId); break;}
      case 'copyWaveDrom':          {copyWaveDrom(); break;}
      case 'copyValueAtMarker':     {labelsPanel.copyValueAtMarker(message.rowId); break;}
      case 'updateColorTheme':      {this.events.dispatch(ActionType.UpdateColorTheme); break;}
      default:                      {outputLog('Unknown webview message type: ' + message.command); break;}
    }
  }
}

export const events      = new EventHandler();
export const dataManager = new WaveformDataManager(events);
export const rowHandler  = new RowHandler(events);
export const controlBar  = new ControlBar(events);
export const viewport    = new Viewport(events);
export const labelsPanel = new LabelsPanels(events);
const vaporview          = new VaporviewWebview(events, viewport, controlBar);

vscode.postMessage({ command: 'ready' });

//function getNonce(): string {
//  let text = '';
//  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//  for (let i = 0; i < 32; i++) {
//    text += possible.charAt(Math.floor(Math.random() * possible.length));
//  }
//  return text;
//}