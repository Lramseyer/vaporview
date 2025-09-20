import { Viewport } from './viewport';
import { LabelsPanels } from './labels';
import { ControlBar } from './control_bar';
import { formatBinary, formatHex, ValueFormat, valueFormatList } from './value_format';
import { WaveformDataManager } from './data_manager';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer } from './renderer';
import { VariableItem, SignalGroup, RowItem } from './signal_item';

declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: any): void;
  setState(newState: any): void;
  getState(): any;
}

export type NetlistId = number;
export type SignalId  = number;
export type RowId     = number;
export type ValueChange = [number, string];

export enum CollapseState {
  None      = 0,
  Collapsed = 1,
  Expanded  = 2,
}

export enum DataType {
  None,
  Variable,
  Group,
}

export type WaveformData = {
  transitionData: any[];
  signalWidth: number;
  min: number;
  max: number;
};

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
}

let resizeDebounce: any = 0;

export interface ViewerState {
  uri: any;
  markerTime: number | null;
  altMarkerTime: number | null;
  selectedSignal: number | null;
  selectedSignalIndex: number | null;
  // Multi-select support
  selectedSignals: RowId[];
  selectionAnchor: RowId | null;
  displayedSignals: number[];
  displayedSignalsFlat: number[];
  visibleSignalsFlat: number[]
  zoomRatio: number;
  scrollLeft: number;
  touchpadScrolling: boolean;
  autoTouchpadScrolling: boolean;
  mouseupEventType: string | null;
  autoReload: boolean;
  // Batch removal suppression
  isBatchRemoving?: boolean;
  lastMultiSelection?: RowId[]; // snapshot of last non-trivial multi-selection
}

export const viewerState: ViewerState = {
  uri: null,
  markerTime: null,
  altMarkerTime: null,
  selectedSignal: null,
  selectedSignalIndex: -1,
  selectedSignals: [],
  selectionAnchor: null,
  displayedSignals: [],
  displayedSignalsFlat: [],
  visibleSignalsFlat: [],
  zoomRatio: 1,
  scrollLeft: 0,
  touchpadScrolling: false,
  autoTouchpadScrolling: false,
  mouseupEventType: null,
  autoReload: false,
  isBatchRemoving: false,
  lastMultiSelection: [],
};

export class EventHandler {
  private subscribers: Map<ActionType, ((...args: any[]) => void)[]> = new Map();

  subscribe(action: ActionType, callback: (...args: any[]) => void) {
    if (!this.subscribers.has(action)) {
      this.subscribers.set(action, []);
    }
    this.subscribers.get(action)?.push(callback);
  }

  dispatch(action: ActionType, ...args: any[]) {
    try {
      console.log('DEBUG WFSELECT dispatch', { action: ActionType[action], argsCount: args.length, args });
    } catch (_) {/* ignore logging errors */}
    this.subscribers.get(action)?.forEach((callback) => callback(...args));
  }
}

export function restoreState() {
  const state = vscode.getState();
  if (!state) {return;}
  vscode.postMessage({
    command: 'restoreState',
    state: state,
    uri: viewerState.uri,
  });
}

// Event handler helper functions
export function arrayMove(array: any[], fromIndex: number, toIndex: number) {
  const element = array[fromIndex];
  array.splice(fromIndex, 1);
  array.splice(toIndex, 0, element);
}

export function updateDisplayedSignalsFlat() {
  viewerState.displayedSignalsFlat = [];
  viewerState.visibleSignalsFlat = [];
  viewerState.displayedSignals.forEach((rowId) => {
    const signalItem = dataManager.rowItems[rowId];
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
    const signalItem = dataManager.rowItems[id];
    const parentGroupId = signalItem.findParentGroupId(rowId);
    if (parentGroupId !== null) {
      return parentGroupId;
    }
  }
  return null;
}

export function getParentGroupIdList(rowId: RowId | null | undefined): number[] {
  let result: number[] = [];
  if (rowId === null || rowId === undefined) {return result;}
  const parentGroupId = getParentGroupId(rowId);
  if (!parentGroupId) {return result;}
  const parentGroupRowId = dataManager.groupIdTable[parentGroupId];
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
  const groupRowId = dataManager.groupIdTable[parentGroupId];
  const groupItem = dataManager.rowItems[groupRowId];
  if (!(groupItem instanceof SignalGroup)) {
    return -1;
  }
  return groupItem.children.indexOf(rowId);
}

export function getChildrenByGroupId(groupId: number) {
  if (groupId === 0) {
    return viewerState.displayedSignals;
  }
  const groupRowId = dataManager.groupIdTable[groupId];
  const groupItem = dataManager.rowItems[groupRowId];
  if (!(groupItem instanceof SignalGroup)) {
    return [];
  }
  return groupItem.children;
}

export function revealSignal(rowId: RowId) {
  if (rowId === null) {return;}

  const parentList = getParentGroupIdList(rowId);

  parentList.forEach((groupId) => {
    const groupRowId = dataManager.groupIdTable[groupId];
    if (groupRowId === undefined) {return;}
    const groupItem: RowItem = dataManager.rowItems[groupRowId];
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

  if (labelBounds.top < windowBounds.top + 40) {
    newScrollTop = Math.max(0, labelsPanel.scrollTop + (labelBounds.top - (windowBounds.top + 40)));
  } else if (labelBounds.bottom > windowBounds.bottom) {
    newScrollTop = Math.min(labelsPanel.scrollHeight - labelsPanel.clientHeight, labelsPanel.scrollTop + (labelBounds.bottom - windowBounds.bottom) + WAVE_HEIGHT);
  }

  if (newScrollTop !== labelsPanel.scrollTop) {
    vaporview.syncVerticalScroll({deltaY: 0}, newScrollTop);
  }
}

export const WAVE_HEIGHT = parseInt(window.getComputedStyle(document.body).getPropertyValue('--waveform-height'));

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
  if (viewerState.selectedSignal !== null) {
    const data = dataManager.rowItems[viewerState.selectedSignal];
    if (data instanceof VariableItem) {
      selectedNetlistId = data.netlistId;
    }
  }
  return  {
    markerTime: viewerState.markerTime,
    altMarkerTime: viewerState.altMarkerTime,
    displayTimeUnit: viewport.displayTimeUnit,
    selectedSignal: selectedNetlistId,
    transitionCount: dataManager.getTransitionCount(),
    zoomRatio: vaporview.viewport.zoomRatio,
    scrollLeft: vaporview.viewport.pseudoScrollLeft,
    autoReload: viewerState.autoReload,
    displayedSignals: signalListForSaveFile(viewerState.displayedSignals),
  };
}

function signalListForSaveFile(rowIdList: RowId[]): any[] {
  const result: any[] = [];
  rowIdList.forEach((rowId) => {
    const data = dataManager.rowItems[rowId];
    if (data instanceof SignalGroup) {
      result.push({
        dataType:  "signal-group",
        groupName: data.label,
        children:  signalListForSaveFile(data.children)
      });
    }
    if (!(data instanceof VariableItem)) {return;}

    const netlistId = data.netlistId;
    result.push({
      dataType:         "netlist-variable",
      netlistId:        netlistId,
      name:             data.scopePath + "." + data.signalName,
      numberFormat:     data.valueFormat.id,
      colorIndex:       data.colorIndex,
      rowHeight:        data.rowHeight,
      renderType:       data.renderType.id,
      valueLinkCommand: data.valueLinkCommand,
    });
  });
  return result;
}

export function sendWebviewContext() {
  const context: any = createWebviewContext();
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
  overlay: HTMLElement | null = null;
  overlayText: HTMLElement | null = null;

  // event handler variables
  events: EventHandler;

  lastIsTouchpad: boolean = false;
  touchpadCheckTimer: any = 0;

  // Modifier key state tracking
  isCtrlPressed: boolean = false;
  isMetaPressed: boolean = false;

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
  const overlay       = document.getElementById('annotate-overlay');
  const overlayText   = document.getElementById('annotate-overlay-text');

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
  this.overlay      = overlay;
  this.overlayText  = overlayText;

    webview.style.gridTemplateColumns = `150px 50px auto`;

    // Ensure container is focusable so Delete/Arrow keys are captured
    if (!this.webview.getAttribute('tabindex')) {
      this.webview.setAttribute('tabindex', '0');
    }

    // #region Primitive Handlers
    window.addEventListener('message', (e) => {this.handleMessage(e);});
    
    // Test to see if ANY keydown events are received
    window.addEventListener('keydown', (e) => {
      console.log('DEBUG WFSELECT WINDOW keydown received', { key: e.key, target: e.target, activeElement: document.activeElement });
    }, true); // Use capture phase
    
    window.addEventListener('keydown', (e) => {this.keyDownHandler(e);});
    // Focus diagnostics (insertion)
    window.addEventListener('focusin', (e) => { try { console.log('DEBUG WFSELECT focusin', { targetId: (e.target as HTMLElement)?.id, tag: (e.target as HTMLElement)?.tagName }); } catch (_) { /* empty */ } });
    window.addEventListener('focusout', (e) => { try { console.log('DEBUG WFSELECT focusout', { targetId: (e.target as HTMLElement)?.id, tag: (e.target as HTMLElement)?.tagName }); } catch (_) { /* empty */ } });
    document.body.addEventListener('keydown', (e) => {
      console.log('DEBUG WFSELECT bodyHandler keydown', { key: e.key, selectedSignals: viewerState.selectedSignals?.length || 0 });
      if ((e.key === 'Delete' || e.key === 'Backspace')) {
        console.log('DEBUG WFSELECT bodyHandler delete key pressed');
        if (viewerState.selectedSignals && viewerState.selectedSignals.length > 0) {
          console.log('DEBUG WFSELECT fallbackBodyDelete multi', { selection: viewerState.selectedSignals });
          this.removeVariableInternal(null); // Let removeVariableInternal handle the logic
        } else if (viewerState.selectedSignal) {
          console.log('DEBUG WFSELECT fallbackBodyDelete single', { selectedSignal: viewerState.selectedSignal });
          this.removeVariableInternal(null); // Let removeVariableInternal handle the logic
        } else {
          console.log('DEBUG WFSELECT fallbackBodyDelete none selected');
          this.removeVariableInternal(null); // Let removeVariableInternal handle the logic
        }
      }
    });
    window.addEventListener('keyup',   (e) => {this.keyUpHandler(e);});
    window.addEventListener('mouseup', (e) => {this.handleMouseUp(e, false);});
    window.addEventListener('resize',  ()  => {this.handleResizeViewer();}, false);
    
    // Reset modifier key state when focus is lost to prevent stuck keys
    window.addEventListener('blur', () => {
      this.isCtrlPressed = false;
      this.isMetaPressed = false;
      console.log('DEBUG WFSELECT window blur - reset modifier keys');
    });
    
    this.scrollArea.addEventListener(  'wheel', (e) => {this.scrollHandler(e);});
    this.scrollArea.addEventListener(  'scroll', () => {this.handleViewportScroll();});
    this.labelsScroll.addEventListener('wheel', (e) => {this.syncVerticalScroll(e, labelsScroll.scrollTop);});
    this.valuesScroll.addEventListener('wheel', (e) => {this.syncVerticalScroll(e, valuesScroll.scrollTop);});
    this.webview.addEventListener('dragover', (e) => {labelsPanel.dragMoveExternal(e);});
    this.webview.addEventListener('drop', (e) => {this.handleDrop(e);});
  // Allow selecting rows by clicking waveform area as well
  this.contentArea.addEventListener('click', (e) => {this.clickWaveform(e);});

    this.handleMarkerSet    = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.reorderSignals     = this.reorderSignals.bind(this);

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.reorderSignals);
  }

  // Function to test whether or not the user is using a touchpad
  // Sometimes it returns false negatives when flicking the touchpad,
  // hence the timer to prevent multiple checks in a short period of time
  isTouchpad(e: WheelEvent) {

    if (performance.now() < this.touchpadCheckTimer) {
      return this.lastIsTouchpad;
    }

    const wheelEvent = e as any;
    if (wheelEvent.wheelDeltaY) {
      if (wheelEvent.wheelDeltaY === (e.deltaY * -3)) {
        this.lastIsTouchpad = true;
        return true;
      }
    //} else if (wheelEvent.wheelDeltaX && !e.shiftKey) {
    //  if (wheelEvent.wheelDeltaX === (e.deltaX * -3)) {
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
        // Capture-phase click focus fallback for labels/value areas
        window.addEventListener('click', (e) => {
          const el = e.target as HTMLElement | null;
          if (!el) {return;}
          if (el.closest('#waveform-labels') || el.closest('#value-display')) {
            try { this.webview.focus(); console.log('DEBUG WFSELECT focusFallbackCaptureClick'); } catch(_) { /* empty */ }
          }
        }, { capture: true });
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
    console.log('DEBUG WFSELECT keyDownHandler entry', { key: e.key });
    try {
      const activeEl = document.activeElement as HTMLElement | null;
      console.log('DEBUG WFSELECT keyDownHandler entry', { key: e.key, activeId: activeEl?.id, activeTag: activeEl?.tagName, selectionSize: viewerState.selectedSignals?.length });
    } catch (_) { /* ignore */ }
    
    // Track modifier key state
    if (e.key === 'Control') {
      this.isCtrlPressed = true;
    } else if (e.key === 'Meta') {
      this.isMetaPressed = true;
    }
    
    // Handle Ctrl/Cmd+A for signal selection even when input fields are focused
    // Use the same pattern as Alt+Up arrow - check key first, then modifier
    if (e.key === 'a') {
      console.log('DEBUG WFSELECT a key detected', { 
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        cmdKey: e.metaKey  // On Mac, Cmd is Meta
      });
      if (e.ctrlKey || e.metaKey) {
      console.log('DEBUG WFSELECT cmd+a detected, bypassing input focus checks');
      e.preventDefault(); // Prevent default select-all in input field
      
      if (viewerState.visibleSignalsFlat.length > 0) {
        // Select all visible signals
        viewerState.selectedSignals = [...viewerState.visibleSignalsFlat];
        
        // Set the selection anchor to the first signal
        viewerState.selectionAnchor = viewerState.visibleSignalsFlat[0];
        
        // Set the focused signal to the first signal (or keep current if already selected)
        const currentFocus = viewerState.selectedSignal;
        const focusSignal = (currentFocus !== null && viewerState.selectedSignals.includes(currentFocus)) 
          ? currentFocus 
          : viewerState.visibleSignalsFlat[0];
        
        console.log('DEBUG WFSELECT selectAll triggered', { 
          totalSelected: viewerState.selectedSignals.length,
          focusSignal: focusSignal,
          allSignals: viewerState.visibleSignalsFlat,
          ctrlPressed: this.isCtrlPressed,
          metaPressed: this.isMetaPressed
        });
        
        // Update the selection index for the focused signal
        viewerState.selectedSignalIndex = viewerState.visibleSignalsFlat.indexOf(focusSignal);
        
        // Dispatch the signal select event for the focused signal to update UI
        this.events.dispatch(ActionType.SignalSelect, focusSignal);
        
        // Store this as the last meaningful multi-selection
        viewerState.lastMultiSelection = [...viewerState.selectedSignals];
      }
      return; // Exit early after handling Cmd+A
      }
    }
    
    // For all other keys, check if input fields are focused
    if (controlBar.searchInFocus || labelsPanel.renameActive) {
      console.log('DEBUG WFSELECT keyDownHandler early return', { searchInFocus: controlBar.searchInFocus, renameActive: labelsPanel.renameActive });
      return;
    } 
    else {e.preventDefault();}

    console.log('DEBUG WFSELECT keyDownHandler processing key', { 
      key: e.key, 
      ctrlPressed: this.isCtrlPressed, 
      metaPressed: this.isMetaPressed,
      eventCtrl: e.ctrlKey,
      eventMeta: e.metaKey
    });

    // debug handler to print the data cache
    if (e.key === 'd' && e.ctrlKey) {
      console.log(this.viewport.updatePending);
      console.log(viewerState);
      console.log(dataManager.rowItems);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition

    if ((e.key === 'ArrowRight') && (viewerState.markerTime !== null)) {
      if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0);}
      else           {this.events.dispatch(ActionType.MarkerSet, viewerState.markerTime + 1, 0);}
    } else if ((e.key === 'ArrowLeft') && (viewerState.markerTime !== null)) {
      if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, 0, 0);}
      else           {this.events.dispatch(ActionType.MarkerSet, viewerState.markerTime - 1, 0);}

    // up and down arrow keys move the selected signal
    // alt + up and down arrow keys reorder the selected signal up and down
    } else if ((e.key === 'ArrowUp') && (viewerState.selectedSignalIndex !== null)) {
      const newIndex = Math.max(viewerState.selectedSignalIndex - 1, 0);
      if (e.altKey) {this.handleReorderArrowKeys(-1);} 
      else          {
        const newRow = viewerState.visibleSignalsFlat[newIndex];
        if (!viewerState.selectedSignals || viewerState.selectedSignals.length <= 1) {
          viewerState.selectedSignals = [newRow];
          viewerState.selectionAnchor = newRow;
        } else {
          // Preserve existing multi-selection: only change focus row
          console.log('DEBUG WFSELECT arrowUp preserve multi', { focus: newRow, multi: viewerState.selectedSignals });
        }
        console.log('DEBUG WFSELECT key ArrowUp', { newIndex, newRow, selectedSignals: viewerState.selectedSignals });
        this.events.dispatch(ActionType.SignalSelect, newRow);
      }
    } else if ((e.key === 'ArrowDown') && (viewerState.selectedSignalIndex !== null)) {
      const newIndex = Math.min(viewerState.selectedSignalIndex + 1, viewerState.visibleSignalsFlat.length - 1);
      if (e.altKey) {this.handleReorderArrowKeys(1);} 
      else          {
        const newRow = viewerState.visibleSignalsFlat[newIndex];
        if (!viewerState.selectedSignals || viewerState.selectedSignals.length <= 1) {
          viewerState.selectedSignals = [newRow];
          viewerState.selectionAnchor = newRow;
        } else {
          console.log('DEBUG WFSELECT arrowDown preserve multi', { focus: newRow, multi: viewerState.selectedSignals });
        }
        console.log('DEBUG WFSELECT key ArrowDown', { newIndex, newRow, selectedSignals: viewerState.selectedSignals });
        this.events.dispatch(ActionType.SignalSelect, newRow);
      }
    }

    // handle Home and End keys to move to the start and end of the waveform
    else if (e.key === 'Home') {this.events.dispatch(ActionType.MarkerSet, 0, 0);}
    else if (e.key === 'End')  {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0);}

    // "N" and Shoft + "N" go to the next transition
    else if (e.key === 'n') {controlBar.goToNextTransition(1, []);}
    else if (e.key === 'N') {controlBar.goToNextTransition(-1, []);}

    else if (e.key === 'Escape') {this.handleMouseUp(e, true);} 
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      console.log('DEBUG WFSELECT keyDelete pressed', {
        selectedSignals: viewerState.selectedSignals,
        selectedSignal: viewerState.selectedSignal,
        selectionAnchor: viewerState.selectionAnchor,
        visibleFlatLen: viewerState.visibleSignalsFlat.length
      });
      // Unified delete logic - let removeVariableInternal decide what to delete
      this.removeVariableInternal(null);
    } 

    else if (e.key === 'Control' || e.key === 'Meta') {viewport.setValueLinkCursor(true);}
  }

  handleReorderArrowKeys(direction: number) {
    const rowId = viewerState.selectedSignal;
    if (rowId === null) {return;}
    let parentGroupId = getParentGroupId(rowId);
    let parentList: RowId[] = [];
    if (parentGroupId === null) {return;}
    if (parentGroupId === 0) {
      parentList = viewerState.displayedSignals;
    } else {
      const parentRowId = dataManager.groupIdTable[parentGroupId];
      const parentItem = dataManager.rowItems[parentRowId];
      if (!(parentItem instanceof SignalGroup)) {return;}
      parentList = parentItem.children;
    }

    const localIndex = getIndexInGroup(rowId, parentGroupId);
    let newIndex = localIndex + direction;

    // First check to see if we're moving it outside the parent group
    if (newIndex < 0 || newIndex >= parentList.length) {
      const parentGroupRowId = dataManager.groupIdTable[parentGroupId];
      const grandparentGroupId = getParentGroupId(parentGroupRowId);
      if (grandparentGroupId === null) {return;}
      const parentIndex = getIndexInGroup(dataManager.groupIdTable[parentGroupId], grandparentGroupId);
      newIndex = parentIndex;
      if (direction > 0) {newIndex += direction;}
      parentGroupId = grandparentGroupId;
    } else {
      // if the adjacent row is a group, and the group is expanded, we place it in the top or bottom of the group
      const adjacentRowId = parentList[newIndex];
      const adjacentGroupId = dataManager.groupIdTable.indexOf(adjacentRowId);
      if (adjacentGroupId !== -1) {
        const groupItem = dataManager.rowItems[dataManager.groupIdTable[adjacentGroupId]];
        if (groupItem instanceof SignalGroup && groupItem.collapseState === CollapseState.Expanded) {
          parentGroupId = adjacentGroupId;
          if (direction > 0) {newIndex = 0;}
          else {
            const adjacentGroup = dataManager.rowItems[dataManager.groupIdTable[adjacentGroupId]];
            if (!(adjacentGroup instanceof SignalGroup)) {return;}
            newIndex = adjacentGroup.children.length;
          }
        }
      }
    }

    this.events.dispatch(ActionType.ReorderSignals, rowId, parentGroupId, newIndex);
  }

  updateVerticalScale(rowId: RowId | null, scale: number) {
    if (rowId === null) {return;}
    const netlistData = dataManager.rowItems[rowId];
    if (!(netlistData instanceof VariableItem)) {return;}
    netlistData.verticalScale = Math.max(1, netlistData.verticalScale * scale);
    this.events.dispatch(ActionType.RedrawVariable, rowId);
  }

  externalKeyDownHandler(e: any) {
    switch (e.keyCommand) {
      case 'nextEdge': {controlBar.goToNextTransition(1, []); break;}
      case 'previousEdge': {controlBar.goToNextTransition(-1, []); break;}
      case 'zoomToFit': {this.events.dispatch(ActionType.Zoom, Infinity, 0, 0); break;}
      case 'increaseVerticalScale': {this.updateVerticalScale(viewerState.selectedSignal, 2); break;}
      case 'decreaseVerticalScale': {this.updateVerticalScale(viewerState.selectedSignal, 0.5); break;}
      case 'delete': {this.removeVariableInternal(null); break;}
      case 'backspace': {this.removeVariableInternal(null); break;}
      case 'selectAll': {
        // Select all visible signals
        if (viewerState.visibleSignalsFlat.length > 0) {
          viewerState.selectedSignals = [...viewerState.visibleSignalsFlat];
          viewerState.selectionAnchor = viewerState.visibleSignalsFlat[0];
          const currentFocus = viewerState.selectedSignal;
          const focusSignal = (currentFocus !== null && viewerState.selectedSignals.includes(currentFocus)) 
            ? currentFocus 
            : viewerState.visibleSignalsFlat[0];
          viewerState.selectedSignalIndex = viewerState.visibleSignalsFlat.indexOf(focusSignal);
          this.events.dispatch(ActionType.SignalSelect, focusSignal);
          viewerState.lastMultiSelection = [...viewerState.selectedSignals];
        }
        break;
      }
    }
  }

  keyUpHandler(e: any) {
    // Reset modifier key state
    if (e.key === 'Control') {
      this.isCtrlPressed = false;
    } else if (e.key === 'Meta') {
      this.isMetaPressed = false;
    }
    
    if (e.key === 'Control' || e.key === 'Meta') {viewport.setValueLinkCursor(false);}
  }

  handleMouseUp(event: MouseEvent | KeyboardEvent, abort: boolean) {
    console.log('mouseup event type: ' + event);
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
    }
    viewerState.mouseupEventType = null;
  }

  private clickWaveform(event: MouseEvent) {
    // Only handle clicks on waveform rows
    const target = event.target as HTMLElement;
    const container = target.closest('.waveform-container') as HTMLElement | null;
    if (!container) {return;}
    const id = container.id; // 'waveform-<rowId>'
    if (!id || !id.startsWith('waveform-')) {return;}
    const rowId = parseInt(id.split('-')[1]);
    if (isNaN(rowId)) {return;}

    if (event.shiftKey) {
      const anchor = viewerState.selectionAnchor ?? viewerState.selectedSignal ?? rowId;
      const flat   = viewerState.visibleSignalsFlat;
      const aIdx   = Math.max(0, flat.indexOf(anchor));
      const bIdx   = Math.max(0, flat.indexOf(rowId));
      const [start, end] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
      viewerState.selectedSignals = flat.slice(start, end + 1);
      viewerState.selectionAnchor = anchor;
      console.log('DEBUG WFSELECT waveform shift-click', { anchor, rowId, aIdx, bIdx, start, end, selectedSignals: viewerState.selectedSignals });
    } else {
      viewerState.selectedSignals = [rowId];
      viewerState.selectionAnchor = rowId;
      console.log('DEBUG WFSELECT waveform click', { rowId, selectedSignals: viewerState.selectedSignals });
    }

    this.events.dispatch(ActionType.SignalSelect, rowId);
    // Force focus so subsequent Delete/Backspace is received
    try { this.webview.focus(); } catch (_) { /* ignore */ }
  }

  // #region Global Events
  reorderSignals(rowId: number, newGroupId: number, newIndex: number) {
    this.events.dispatch(ActionType.SignalSelect, rowId);
  }

  handleResizeViewer() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(this.events.dispatch.bind(this.events, ActionType.Resize), 100);
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.viewport.timeStop || time < 0) {return;}
    sendWebviewContext();
    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'markerSet',
      uri: viewerState.uri,
      time: time,
      units: this.viewport.timeUnit,
    });
  }

  handleSignalSelect(rowId: RowId | null) {
    if (rowId === null) {return;}
    const netlistData = dataManager.rowItems[rowId];
    sendWebviewContext();
    revealSignal(rowId);

    if (netlistData === undefined) {return;}
    const netlistId = netlistData.netlistId;
    if (!(netlistData instanceof VariableItem)) {return;}
    let instancePath = netlistData.scopePath + '.' + netlistData.signalName;
    if (netlistData.scopePath === "") {instancePath = netlistData.signalName;}

    // Preserve existing multi-selection if it already contains multiple rows.
    if (!viewerState.selectedSignals || viewerState.selectedSignals.length <= 1) {
      viewerState.selectedSignals = [rowId];
      viewerState.selectionAnchor = rowId;
      console.log('DEBUG WFSELECT handleSignalSelect.assignSingle', { rowId });
    } else {
      // Maintain focus row separate from multi array
      console.log('DEBUG WFSELECT handleSignalSelect.preserveMulti', { focusRow: rowId, multi: viewerState.selectedSignals });
    }

    // Persist snapshot of meaningful multi-select (>=2)
    if (viewerState.selectedSignals && viewerState.selectedSignals.length > 1) {
      viewerState.lastMultiSelection = [...viewerState.selectedSignals];
    }

    vscode.postMessage({
      command: 'emitEvent',
      eventType: 'signalSelect',
      uri: viewerState.uri,
      instancePath: instancePath,
      netlistId: netlistId,
    });
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
    viewerState.selectedSignal      = null;
    viewerState.selectedSignalIndex = null;
    viewerState.selectedSignals     = [];
    viewerState.selectionAnchor     = null;
    viewerState.markerTime          = null;
    viewerState.altMarkerTime       = null;
    viewerState.displayedSignals    = [];
    viewerState.displayedSignalsFlat = [];
    viewerState.visibleSignalsFlat  = [];
    viewerState.zoomRatio           = 1;
    dataManager.unload();
    labelsPanel.renderLabelsPanels();
    // we don't need to do anything to the viewport, because the ready message will reinitialize it
    vscode.postMessage({type: 'ready'});
  }

  // We need to let the extension know that we are removing a variable so that
  // it can update the views. Rather than handling it and telling the extension,
  // we just have the extension handle it as normal.
  removeVariableInternal(rowId: RowId | null) {
    console.log('DEBUG WFSELECT removeVariableInternal called', { 
      rowId, 
      selectedSignals: viewerState.selectedSignals, 
      selectedSignal: viewerState.selectedSignal 
    });
    
    // Handle multiple selection case
    if (viewerState.selectedSignals && viewerState.selectedSignals.length > 1) {
      console.log('DEBUG WFSELECT removeVariableInternal delegating to removeSelectedVariables');
      this.removeSelectedVariables();
      return;
    }
    
    // Handle single selection case
    if (rowId === null) {
      // If no specific rowId provided, use the selected signal
      if (viewerState.selectedSignal) {
        rowId = viewerState.selectedSignal;
      } else {
        // If no signal is selected, default to last visible signal (bottom signal)
        if (viewerState.visibleSignalsFlat.length > 0) {
          rowId = viewerState.visibleSignalsFlat[viewerState.visibleSignalsFlat.length - 1];
        } else {
          return;
        }
      }
    }
    
    const signalItem = dataManager.rowItems[rowId];
    if (!signalItem) {return;}
    const netlistId = signalItem.netlistId;
    if (netlistId === undefined) {return;}

    console.log('DEBUG WFSELECT removeVariableInternal removing single signal', { rowId, netlistId });
    vscode.postMessage({
      command: 'removeVariable',
      netlistId: netlistId
    });
  }

  // Remove all currently selected variable rows (ignores groups for now)
  removeSelectedVariables() {
    console.log('ACTION: removeSelectedVariables');
    console.log('DEBUG WFSELECT removeSelectedVariables start', { selectedSignals: viewerState.selectedSignals, selectedSignal: viewerState.selectedSignal });
    if (!viewerState.selectedSignals || viewerState.selectedSignals.length === 0) {
      // Fallback to single selection if present
      if (viewerState.selectedSignal) {
        console.log('DEBUG WFSELECT fallback to single selection', { selectedSignal: viewerState.selectedSignal });
        viewerState.selectedSignals = [viewerState.selectedSignal];
      } else if (viewerState.lastMultiSelection && viewerState.lastMultiSelection.length > 1) {
        console.log('DEBUG WFSELECT reviveLastMultiSelection', { last: viewerState.lastMultiSelection });
        viewerState.selectedSignals = [...viewerState.lastMultiSelection];
      } else { 
        console.log('DEBUG WFSELECT no signals to remove');
        return; 
      }
    }
    const originalSelection = [...viewerState.selectedSignals];
    // Expand any selected groups to their contained variable rowIds
    const expandedRowIds: RowId[] = [];
    const classification: any[] = [];
    originalSelection.forEach((rowId) => {
      const item = dataManager.rowItems[rowId];
      if (!item) {return;}
      if (item instanceof VariableItem) {
        expandedRowIds.push(rowId);
        classification.push({ rowId, kind: 'variable', netlistId: item.netlistId });
      } else if (item instanceof SignalGroup) {
        const list = item.getFlattenedRowIdList(false, -1).filter((rid) => {
          const rItem = dataManager.rowItems[rid];
          return rItem instanceof VariableItem;
        });
        expandedRowIds.push(...list);
        classification.push({ rowId, kind: 'group', expandedVariables: list.length });
      }
    });
    // De-duplicate
    const toRemoveRowIds = Array.from(new Set(expandedRowIds));
    // Map to netlistIds
    const netlistIds: number[] = [];
    toRemoveRowIds.forEach((rowId) => {
      const item = dataManager.rowItems[rowId];
      if (item instanceof VariableItem) { netlistIds.push(item.netlistId); }
    });
    console.log('DEBUG WFSELECT delete batch', { originalSelection, classification, expandedRowIds: toRemoveRowIds, netlistIds });

    if (netlistIds.length === 0) {return;}
    if (originalSelection.length === 1 && netlistIds.length === 1) {
      // Fall back to single remove for clarity
      vscode.postMessage({ command: 'removeVariable', netlistId: netlistIds[0] });
      viewerState.selectedSignals = [];
      viewerState.selectionAnchor = null;
      return;
    }

    console.log('DEBUG WFSELECT delete batch outbound payload', { count: netlistIds.length, netlistIds });

    // Suppress auto-adjacent reselection inside removeVariable() by clearing selectedSignal.
    viewerState.selectedSignal = null;
    viewerState.selectedSignalIndex = null;

    // Issue all removals (extension will emit one remove-signal per netlistId)
    const payload = netlistIds.slice(); // defensive copy
    vscode.postMessage({ command: 'removeVariablesBatch', netlistIds: payload });
    console.log('DEBUG WFSELECT delete batch message sent', { payload });

    // Clear multi-select state; UI will settle after extension messages processed
    viewerState.selectedSignals = [];
    viewerState.selectionAnchor = null;
  }

  removeVariable(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}

    const rowId = dataManager.netlistIdTable[netlistId];
    const index = viewerState.visibleSignalsFlat.indexOf(rowId);

    this.events.dispatch(ActionType.RemoveVariable, rowId, true);
    if (viewerState.selectedSignal === rowId) {
      const newindex = Math.max(0, Math.min(viewerState.visibleSignalsFlat.length - 1, index));
      const newRowId = viewerState.visibleSignalsFlat[newindex];
      this.events.dispatch(ActionType.SignalSelect, newRowId);
    }
  }

  removeVariableBatch(netlistIds: NetlistId[]) {
    if (!Array.isArray(netlistIds)) {return;}
    console.log('DEBUG WFSELECT batch remove start', { netlistIdsLength: netlistIds.length, displayedBefore: viewerState.displayedSignals.length, flatBefore: viewerState.displayedSignalsFlat.length });
    // Map to rowIds (only variables should be in batch)
    const rowIds: RowId[] = [];
    netlistIds.forEach((nid) => {
      const r = dataManager.netlistIdTable[nid];
      if (r !== undefined) { rowIds.push(r); }
    });

    // Remove in a stable order (descending by current visible index) so index math inside
    // dataManager.handleRemoveVariable remains valid as we mutate arrays.
    const indexed: {rowId: RowId; idx: number}[] = rowIds.map((rowId) => ({ rowId, idx: viewerState.visibleSignalsFlat.indexOf(rowId) }));
    indexed.sort((a, b) => b.idx - a.idx);

    // Activate suppression
    viewerState.isBatchRemoving = true;
    indexed.forEach(({ rowId }, position) => {
      console.log('DEBUG WFSELECT batch remove row (suppressed)', { position, rowId });
      dataManager.handleRemoveVariable(rowId, true);
    });
    viewerState.isBatchRemoving = false;

    // Post-removal single pass updates / renders
  updateDisplayedSignalsFlat();
  // Single atomic refresh
  labelsPanel.renderLabelsPanels();
  viewport.updateSignalOrder();
  viewport.updateBackgroundCanvas(true);

    // Clear selection state atomically
    viewerState.selectedSignal = null;
    viewerState.selectedSignalIndex = null;
    viewerState.selectedSignals = [];
    viewerState.selectionAnchor = null;

    sendWebviewContext();
    console.log('DEBUG WFSELECT batch remove complete', { removedCount: rowIds.length, displayedAfter: viewerState.displayedSignals.length, flatAfter: viewerState.displayedSignalsFlat.length });
  }

  removeSignalGroup(groupId: number, recursive: boolean) {
    if (groupId === 0) {return;}
    const rowId = dataManager.groupIdTable[groupId];
    if (rowId === undefined) {return;}

    this.events.dispatch(ActionType.RemoveVariable, rowId, recursive);
  }

  handleSetConfigSettings(settings: any) {
    if (settings.scrollingMode !== undefined) {
      controlBar.setScrollMode(settings.scrollingMode);
    }
    if (settings.rulerLines !== undefined) {
      this.viewport.setRulerLines(settings.rulerLines);
    }
  }

  handleSetSelectedSignal(netlistId: NetlistId | undefined) {
    if (netlistId === undefined) {return;}
    const rowId = dataManager.netlistIdTable[netlistId];
    if (rowId === undefined) {return;}
    if (dataManager.rowItems[rowId] === undefined) {return;}
    this.events.dispatch(ActionType.SignalSelect, rowId);
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
    const groupRowId = dataManager.groupIdTable[newGroupId];
    if (groupRowId) {
      groupPath = getParentGroupIdList(groupRowId).map((id) => {
        const item = dataManager.rowItems[dataManager.groupIdTable[id]];
        if (item instanceof SignalGroup) {
          return item.label;
        }
        return '';
      });
      const groupItem = dataManager.rowItems[groupRowId];
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
      case 'setAnnotateLoading': {
        if (this.overlay) {
          if (message.active) {
            if (this.overlayText && message.text) { this.overlayText.textContent = message.text; }
            this.overlay.style.display = 'flex';
          } else {
            this.overlay.style.display = 'none';
          }
        }
        break;
      }
      case 'initViewport':          {this.viewport.init(message.metadata, message.uri); break;}
      case 'unload':                {this.unload(); break;}
      case 'setConfigSettings':     {this.handleSetConfigSettings(message); break;}
      case 'getContext':            {sendWebviewContext(); break;}
      case 'getSelectionContext':   {sendWebviewContext(); break;}
      case 'add-variable':          {dataManager.addVariable(message.signalList, message.groupPath, undefined, message.index); break;}
      case 'remove-signal': {
        // Intercept single remove if multi-selection still active; upgrade to local batch
        try {
          if (viewerState.selectedSignals && viewerState.selectedSignals.length > 1) {
            const netIds: number[] = [];
            viewerState.selectedSignals.forEach((rowId) => {
              const item = dataManager.rowItems[rowId];
              if (item instanceof VariableItem) { netIds.push(item.netlistId); }
            });
            if (netIds.length > 1) {
              console.log('DEBUG WFSELECT intercept single remove -> batch', { incoming: message.netlistId, batchNetlistIds: netIds });
              this.removeVariableBatch(netIds);
              break;
            }
          }
        } catch (err) {
          console.log('DEBUG WFSELECT intercept error', err);
        }
        this.removeVariable(message.netlistId); break;
      }
      case 'remove-signal-batch':   {this.removeVariableBatch(message.netlistIds); break;}
      case 'deleteSelectedSignals': {
        console.log('DEBUG WFSELECT deleteSelectedSignals command received');
        this.removeVariableInternal(null); // Use unified delete logic
        break;
      }
      case 'remove-group':          {this.removeSignalGroup(message.groupId, message.recursive); break;}
      case 'update-waveform-chunk': {dataManager.updateWaveformChunk(message); break;}
      case 'update-waveform-chunk-compressed': {dataManager.updateWaveformChunkCompressed(message); break;}
      case 'newSignalGroup':        {dataManager.addSignalGroup(message.groupName, message.groupPath, message.parentGroupId); break;}
      case 'renameSignalGroup':     {dataManager.renameSignalGroup(message.groupId, message.groupName); break;}
      case 'handle-keypress':       {this.externalKeyDownHandler(message); break;}
      case 'setDisplayFormat':      {dataManager.setDisplayFormat(message); break;}
      case 'setWaveDromClock':      {dataManager.waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'setMarker':             {this.events.dispatch(ActionType.MarkerSet, message.time, message.markerType); break;}
      case 'setTimeUnits':          {this.viewport.updateUnits(message.units, true); break;}
      case 'setSelectedSignal':     {this.handleSetSelectedSignal(message.netlistId); break;}
      case 'copyWaveDrom':          {dataManager.copyWaveDrom(); break;}
      case 'copyValueAtMarker':     {labelsPanel.copyValueAtMarker(message.netlistId); break;}
      case 'updateColorTheme':      {this.events.dispatch(ActionType.UpdateColorTheme); break;}
      default:                      {outputLog('Unknown webview message type: ' + message.command); break;}
    }
  }
}

export const events      = new EventHandler();
export const dataManager = new WaveformDataManager(events);
export const controlBar  = new ControlBar(events);
export const viewport    = new Viewport(events);
export const labelsPanel = new LabelsPanels(events);
const vaporview          = new VaporviewWebview(events, viewport, controlBar);

try { console.log('DEBUG WFSELECT vaporviewVersion', { version: 'v7', timestamp: Date.now() }); } catch(_) { /* empty */ }

// Capture-phase Delete fallback to guarantee multi-delete fires
window.addEventListener('keydown', (e) => {
  try {
    console.log('DEBUG WFSELECT capturePhase keydown', { key: e.key, selectedSignals: viewerState.selectedSignals?.length || 0 });
    if ((e.key === 'Delete' || e.key === 'Backspace')) {
      if (viewerState.selectedSignals && viewerState.selectedSignals.length > 0) {
        console.log('DEBUG WFSELECT captureDeleteFallback multi', { selection: viewerState.selectedSignals });
        vaporview.removeVariableInternal(null); // Let removeVariableInternal handle the logic
      } else if (viewerState.selectedSignal) {
        console.log('DEBUG WFSELECT captureDeleteFallback single', { selectedSignal: viewerState.selectedSignal });
        vaporview.removeVariableInternal(null); // Let removeVariableInternal handle the logic
      } else {
        console.log('DEBUG WFSELECT captureDeleteFallback none selected');
        vaporview.removeVariableInternal(null); // Let removeVariableInternal handle the logic
      }
    }
  } catch(err) {
    console.log('DEBUG WFSELECT captureDeleteFallback error', err);
  }
}, { capture: true });

vscode.postMessage({ command: 'ready' });

//function getNonce(): string {
//  let text = '';
//  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//  for (let i = 0; i < 32; i++) {
//    text += possible.charAt(Math.floor(Math.random() * possible.length));
//  }
//  return text;
//}