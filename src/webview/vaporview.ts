import { error } from 'console';
import { Viewport } from './viewport';
import { LabelsPanels } from './labels';
import { ControlBar } from './control_bar';
import { formatBinary, formatHex, ValueFormat, valueFormatList } from './value_format';

declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: any): void;
  setState(newState: any): void;
  getState(): any;
}

export type NetlistId = number;
export type SignalId  = number;
export type ValueChange = [number, string];
export type NetlistData = {
  signalId: number;
  signalName: string;
  modulePath: string;
  signalWidth: number;
  valueFormat: ValueFormat;
  vscodeContext: string;
  type: string;
  textWidth: number;
};

export type WaveformData = {
  transitionData: any[];
  chunkStart: number[];
  signalWidth: number;
};

let waveDromClock = {
  netlistId: null,
  edge: '1',
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
}

let resizeDebounce: any       = 0;

export interface ViewerState {
  markerTime: number | null;
  altMarkerTime: number | null;
  selectedSignal: number | null;
  selectedSignalIndex: number | null;
  displayedSignals: number[];
  zoomRatio: number;
  scrollLeft: number;
  touchpadScrolling: boolean;
  mouseupEventType: string | null;
}

export let waveformData: WaveformData[] = [];
export let netlistData: NetlistData[]   = [];
export let waveformDataTemp: any        = [];

// This is a simple queue to handle the fetching of waveform data
// It's overkill for everything except large FST waveform dumps with lots of
// Value Change Blocks. Batch fetching is much faster than individual fetches,
// so this queue will ensure that fetches are grouped while waiting for any
// previous fetches to complete.
class WaveformDataQueue {
  requested: SignalId[] = [];
  queued:    SignalId[] = [];
  requestActive: boolean = false;

  request(signalIdList: SignalId[]) {
    this.queued = this.queued.concat(signalIdList);
    this.fetch();
  }

  receive(signalId: SignalId) {
    this.requested = this.requested.filter((id) => id !== signalId);
    if (this.requested.length === 0) {
      this.requestActive = false;
      this.fetch();
    }
  }

  private fetch() {
    if (this.requestActive) {return;}
    if (this.queued.length === 0) {return;}

    this.requestActive = true;
    this.requested     = this.queued;
    this.queued        = [];

    vscode.postMessage({
      command: 'fetchTransitionData',
      signalIdList: this.requested,
    });
  }
}

export const viewerState: ViewerState = {
  markerTime: null,
  altMarkerTime: null,
  selectedSignal: null,
  selectedSignalIndex: -1,
  displayedSignals: [],
  zoomRatio: 1,
  scrollLeft: 0,
  touchpadScrolling: false,
  mouseupEventType: null
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
    this.subscribers.get(action)?.forEach((callback) => callback(...args));
  }
}

export function valueIs4State(value: string) {
  if (value.match(/[xXzZ]/)) {return true;}
  else {return false;}
}

export function  valueIs9State(value: string): boolean {
  if (value.match(/[UuXxZzWwLlHh-]/)) {return true;}
  return false;
}

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Event handler helper functions
export function arrayMove(array: any[], fromIndex: number, toIndex: number) {
  const element = array[fromIndex];
  array.splice(fromIndex, 1);
  array.splice(toIndex, 0, element);
}

// ----------------------------------------------------------------------------
// Event handler helper functions
// ----------------------------------------------------------------------------

export function setSeletedSignalOnStatusBar(netlistId: NetlistId) {
  vscode.postMessage({
    command: 'setSelectedSignal',
    netlistId: netlistId
  });
}

export function setTimeOnStatusBar() {
  // .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  vscode.postMessage({
    command: 'setTime',
    markerTime:    viewerState.markerTime,
    altMarkerTime: viewerState.altMarkerTime
  });
}

export function sendDisplayedSignals() {
  vscode.postMessage({
    command: 'setDisplayedSignals',
    signals: viewerState.displayedSignals
  });
}

export function sendWebviewContext() {

  vscode.postMessage({
    command: 'contextUpdate',
    markerTime: viewerState.markerTime,
    altMarkerTime: viewerState.altMarkerTime,
    selectedSignal: viewerState.selectedSignal,
    displayedSignals: viewerState.displayedSignals,
    zoomRatio: vaporview.viewport.zoomRatio,
    scrollLeft: vaporview.viewport.pseudoScrollLeft,
  });
}

export function setSignalContextAttribute(netlistId: NetlistId) {
  const width        = netlistData[netlistId].signalWidth;
  const modulePath   = netlistData[netlistId].modulePath;
  const signalName   = netlistData[netlistId].signalName;
  //const attribute    = `data-vscode-context=${JSON.stringify({
    const attribute    = `${JSON.stringify({
    webviewSection: "signal",
    modulePath: modulePath,
    signalName: signalName,
    width: width,
    preventDefaultContextMenuItems: true,
    netlistId: netlistId,
  }).replace(/\s/g, '%x20')}`;
  return attribute;
}


class VaporviewWebview {

  // HTML Elements
  webview: HTMLElement;
  labelsScroll: HTMLElement;
  transitionScroll: HTMLElement;
  scrollArea: HTMLElement;
  contentArea: HTMLElement;
  scrollbar: HTMLElement;

  // Components
  viewport: Viewport;
  controlBar: ControlBar;

  // event handler variables
  events: EventHandler;
  scrollcountTimeout: any = null;

  constructor(
    events: EventHandler, 
    viewport: Viewport, 
    controlBar: ControlBar
  ) {

    this.events = events;
    this.viewport = viewport;
    this.controlBar = controlBar;
    // Assuming you have a reference to the webview element
    const webview           = document.getElementById('vaporview-top');
    const labelsScroll      = document.getElementById('waveform-labels-container');
    const transitionScroll  = document.getElementById('transition-display-container');
    const scrollArea        = document.getElementById('scrollArea');
    const contentArea       = document.getElementById('contentArea');
    const scrollbar         = document.getElementById('scrollbar');

    if (webview === null || labelsScroll === null || transitionScroll === null ||
      scrollArea === null || contentArea === null || scrollbar === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview = webview;
    this.labelsScroll = labelsScroll;
    this.transitionScroll = transitionScroll;
    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar = scrollbar;

    webview.style.gridTemplateColumns = `150px 50px auto`;
 
    // #region Primitive Handlers
    window.addEventListener('message', (e) => {this.handleMessage(e);});
    window.addEventListener('keydown', (e) => {this.keyDownHandler(e);});
    window.addEventListener('mouseup', (e) => {this.handleMouseUp(e);});
    window.addEventListener('resize',  ()  => {this.handleResizeViewer();}, false);
    this.scrollArea.addEventListener('wheel', (e) => {this.scrollHandler(e);});
    //this.scrollArea.addEventListener(      'scroll', (e) => {this.syncVerticalScroll(scrollArea.scrollTop);});
    this.labelsScroll.addEventListener(    'wheel', (e) => {this.syncVerticalScroll(e, labelsScroll.scrollTop);});
    this.transitionScroll.addEventListener('wheel', (e) => {this.syncVerticalScroll(e, transitionScroll.scrollTop);});

    this.resetTouchpadScrollCount = this.resetTouchpadScrollCount.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.reorderSignals = this.reorderSignals.bind(this);

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.reorderSignals);
    this.events.subscribe(ActionType.Zoom, (direction: number, time: number, pixelLeft: number) => {
      this.resetTouchpadScrollCount();
    });
  }

  scrollHandler(e: any) {
    e.preventDefault();

    //console.log(event);

    if (!viewerState.touchpadScrolling) {e.preventDefault();}
    const deltaY = e.deltaY;
    const deltaX = e.deltaX;
    if (e.shiftKey && !viewerState.touchpadScrolling) {
      e.stopPropagation();
      this.scrollArea.scrollTop      += deltaY || deltaX;
      this.labelsScroll.scrollTop     = this.scrollArea.scrollTop;
      this.transitionScroll.scrollTop = this.scrollArea.scrollTop;
    } else if (e.ctrlKey) {
      if      (this.viewport.updatePending) {return;}
      const bounds      = this.scrollArea.getBoundingClientRect();
      const pixelLeft   = Math.round(e.pageX - bounds.left);
      const time        = Math.round((pixelLeft - this.viewport.contentLeft) / this.viewport.zoomRatio) + (this.viewport.chunkTime * this.viewport.dataCache.startIndex);

      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (!viewerState.touchpadScrolling && (deltaY > 0)) {this.events.dispatch(ActionType.Zoom, 1, time, pixelLeft);}
      else if (!viewerState.touchpadScrolling && (deltaY < 0)) {this.events.dispatch(ActionType.Zoom,-1, time, pixelLeft);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else if (viewerState.touchpadScrolling) {
        this.viewport.touchpadScrollCount += deltaY;
        clearTimeout(this.scrollcountTimeout);
        this.scrollcountTimeout = setTimeout(this.resetTouchpadScrollCount, 1000);
        this.events.dispatch(ActionType.Zoom, Math.round(this.viewport.touchpadScrollCount / 25), time, pixelLeft);
      }

    } else {
      if (viewerState.touchpadScrolling) {
        this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + e.deltaX);
        this.scrollArea.scrollTop       += e.deltaY;
        this.labelsScroll.scrollTop      = this.scrollArea.scrollTop;
        this.transitionScroll.scrollTop  = this.scrollArea.scrollTop;
      } else {
        this.viewport.handleScrollEvent(this.viewport.pseudoScrollLeft + deltaY);
      }
    }
  }

  keyDownHandler(e: any) {
    if (controlBar.searchInFocus) {return;} 
    else {e.preventDefault();}

    // debug handler to print the data cache
    if (e.key === 'd' && e.ctrlKey) {
      console.log(this.viewport.updatePending);
      console.log(viewerState);
      console.log(this.viewport.dataCache);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition

    if ((e.key === 'ArrowRight') && (viewerState.markerTime !== null)) {
      if (e.ctrlKey || e.altKey) {controlBar.goToNextTransition(1);}
      else if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0);}
      else                    {this.events.dispatch(ActionType.MarkerSet, viewerState.markerTime + 1, 0);}
    } else if ((e.key === 'ArrowLeft') && (viewerState.markerTime !== null)) {
      if (e.ctrlKey || e.altKey)  {controlBar.goToNextTransition(-1);}
      else if (e.metaKey) {this.events.dispatch(ActionType.MarkerSet, 0, 0);}
      else                    {this.events.dispatch(ActionType.MarkerSet, viewerState.markerTime - 1, 0);}

    // up and down arrow keys move the selected signal
    // alt + up and down arrow keys reorder the selected signal up and down
    } else if ((e.key === 'ArrowUp') && (viewerState.selectedSignalIndex !== null)) {
      const newIndex = Math.max(viewerState.selectedSignalIndex - 1, 0);
      if (e.altKey)  {this.events.dispatch(ActionType.ReorderSignals, viewerState.selectedSignalIndex, newIndex);}
      else               {this.events.dispatch(ActionType.SignalSelect, viewerState.displayedSignals[newIndex]);}
    } else if ((e.key === 'ArrowDown') && (viewerState.selectedSignalIndex !== null)) {
      const newIndex = Math.min(viewerState.selectedSignalIndex + 1, viewerState.displayedSignals.length - 1);
      if (e.altKey)  {this.events.dispatch(ActionType.ReorderSignals, viewerState.selectedSignalIndex, newIndex);}
      else               {this.events.dispatch(ActionType.SignalSelect, viewerState.displayedSignals[newIndex]);}
    }

    // handle Home and End keys to move to the start and end of the waveform
    else if (e.key === 'Home') {this.events.dispatch(ActionType.MarkerSet, 0, 0);}
    else if (e.key === 'End')  {this.events.dispatch(ActionType.MarkerSet, this.viewport.timeStop, 0);}

    // "N" and Shoft + "N" go to the next transition
    else if (e.key === 'n') {controlBar.goToNextTransition(1);}
    else if (e.key === 'N') {controlBar.goToNextTransition(-1);}

    else if (e.key === 'Escape') {this.events.dispatch(ActionType.SignalSelect, null);}
    else if (e.key === 'Delete') {this.removeVariableInternal(viewerState.selectedSignal);}
  }

  handleMouseUp(event: MouseEvent) {
    //console.log('mouseup event type: ' + mouseupEventType);
    if (viewerState.mouseupEventType === 'rearrange') {
      labelsPanel.dragEnd(event);
    } else if (viewerState.mouseupEventType === 'resize') {
      labelsPanel.resizeElement.classList.remove('is-resizing');
      document.removeEventListener("mousemove", labelsPanel.resize, false);
      this.handleResizeViewer();
    } else if (viewerState.mouseupEventType === 'scroll') {
      this.scrollbar.classList.remove('is-dragging');
      document.removeEventListener('mousemove', this.viewport.handleScrollbarMove, false);
      this.viewport.scrollbarMoved = false;
    } else if (viewerState.mouseupEventType === 'highlightZoom') {
      this.scrollArea.removeEventListener('mousemove', viewport.drawHighlightZoom, false);
      viewport.highlightListenerSet = false;
      viewport.highlightZoom();
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

  // #region Global Events
  reorderSignals(oldIndex: number, newIndex: number) {
    //arrayMove(viewerState.displayedSignals, oldIndex, newIndex);
    this.events.dispatch(ActionType.SignalSelect, viewerState.displayedSignals[newIndex]);
  }

  handleResizeViewer() {
    clearTimeout(resizeDebounce);
    //resizeDebounce = setTimeout(this.viewport.updateViewportWidth, 100);
    resizeDebounce = setTimeout(this.events.dispatch.bind(this.events, ActionType.Resize), 100);
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.viewport.timeStop) {return;}
    sendWebviewContext();
  }

  handleSignalSelect(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}
    sendWebviewContext();
  }

// #region Helper Functions

  copyWaveDrom() {

    // Maximum number of transitions to display
    // Maybe I should make this a user setting in the future...
    const MAX_TRANSITIONS = 32;
  
    // Marker and alt marker need to be set
    if (viewerState.markerTime === null ||viewerState. altMarkerTime === null) {
      //vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
      return;
    }
  
    const timeWindow   = [viewerState.markerTime, viewerState.altMarkerTime].sort((a, b) => a - b);
    const chunkWindow  = [Math.floor(timeWindow[0] / this.viewport.chunkTime), Math.ceil(timeWindow[1] / this.viewport.chunkTime)];
    let allTransitions: any = [];
  
    // Populate the waveDrom names with the selected signals
    const waveDromData: any = {};
    viewerState.displayedSignals.forEach((netlistId) => {
      const netlistItem: any     = netlistData[netlistId];
      const signalName      = netlistItem.modulePath + "." + netlistItem.signalName;
      const signalId        = netlistItem.signalId;
      const transitionData  = waveformData[signalId].transitionData;
      const chunkStart      = waveformData[signalId].chunkStart;
      const signalDataChunk = transitionData.slice(Math.max(0, chunkStart[chunkWindow[0]] - 1), chunkStart[chunkWindow[1]]);
      let   initialState = "x";
      const json: any       = {name: signalName, wave: ""};
      const signalDataTrimmed: any[] = [];
      if (netlistItem.signalWidth > 1) {json.data = [];}
  
      signalDataChunk.forEach((transition: any) => {
        if (transition[0] <= timeWindow[0]) {initialState = transition[1];}
        if (transition[0] >= timeWindow[0] && transition[0] <= timeWindow[1]) {signalDataTrimmed.push(transition);}
      });
  
      waveDromData[netlistId] = {json: json, signalData: signalDataTrimmed, signalWidth: netlistItem.signalWidth, initialState: initialState};
      const taggedTransitions: any = signalDataTrimmed.map(t => [t[0], t[1], netlistId]);
      allTransitions = allTransitions.concat(taggedTransitions);
    });
  
    let currentTime = timeWindow[0];
    let transitionCount = 0;
  
    if (waveDromClock.netlistId === null) {
  
      allTransitions = allTransitions.sort((a: ValueChange, b: ValueChange) => a[0] - b[0]);
  
      for (let index = 0; index < allTransitions.length; index++) {
        const time      = allTransitions[index][0];
        const state     = allTransitions[index][1];
        const netlistId = allTransitions[index][2];
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        if (time !== currentTime) {
          currentTime = time;
          transitionCount++;
          viewerState.displayedSignals.forEach((n) => {
            const signal = waveDromData[n];
            const parseValue = netlistData[n].valueFormat.formatString;
            if (signal.initialState === null) {signal.json.wave += '.';}
            else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(signal.initialState);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(signal.initialState, signal.signalWidth, !is4State));
              } else {
                signal.json.wave += signal.initialState;
              }
            }
            signal.initialState = null;
          });
        }
        waveDromData[netlistId].initialState = state;
      }
    } else {
      const clockEdges = waveDromData[waveDromClock.netlistId].signalData.filter((t: ValueChange) => t[1] === waveDromClock.edge);
      const edge       = waveDromClock.edge === '1' ? "p" : "n";
      let nextEdge = Infinity;
      for (let index = 0; index < clockEdges.length; index++) {
        const currentTime = clockEdges[index][0];
        if (index === clockEdges.length - 1) {nextEdge = timeWindow[1];}
        else {nextEdge    = clockEdges[index + 1][0];}
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        viewerState.displayedSignals.forEach((n) => {
          const signal = waveDromData[n];
          const signalData = signal.signalData;
          const parseValue = netlistData[n].valueFormat.formatString;
          if (n === waveDromClock.netlistId) {signal.json.wave += edge;}
          else {
            let transition = signalData.find((t: ValueChange) => t[0] >= currentTime && t[0] < nextEdge);
            if (!transition && index === 0) {transition = [currentTime, signal.initialState];}
            if (!transition && index > 0) {
              signal.json.wave += '.';
            } else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(transition[1]);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(transition[1], signal.signalWidth, !is4State));
              } else {
                signal.json.wave += transition[1];
              }
            }
            signal.initialState = undefined;
          }
        });
        transitionCount++;
      }
    }
  
    //console.log(waveDromData);
  
    // write the waveDrom JSON to the clipboard
    let result = '{"signal": [\n';
    viewerState.displayedSignals.forEach((netlistId) => {
      const signalData = waveDromData[netlistId].json;
      result += '  ' + JSON.stringify(signalData) + ',\n';
    });
    result += ']}';
  
    vscode.postMessage({
      command: 'copyWaveDrom',
      waveDromJson: result,
      maxTransitionsFlag: transitionCount >= MAX_TRANSITIONS,
      maxTransitions: MAX_TRANSITIONS
    });
  }

  syncVerticalScroll(e: any, scrollLevel: number) {
    const deltaY = e.deltaY;
    if (this.viewport.updatePending) {return;}
    this.viewport.updatePending     = true;
    this.labelsScroll.scrollTop     = scrollLevel + deltaY;
    this.transitionScroll.scrollTop = scrollLevel + deltaY;
    this.scrollArea.scrollTop       = scrollLevel + deltaY;
    this.viewport.updatePending     = false;
  }

  resetTouchpadScrollCount() {
    this.viewport.touchpadScrollCount = 0;
  }

  createRuler(metadata: any) {
    //console.log("creating ruler");
    document.title = metadata.filename;
    this.viewport.init(metadata);
  }

  unload() {
    // Marker and signal selection variables
    viewerState.selectedSignal      = null;
    viewerState.selectedSignalIndex = null;
    viewerState.markerTime          = null;
    viewerState.altMarkerTime       = null;
    viewerState.displayedSignals    = [];
    waveformData        = [];
    netlistData         = [];
    waveformDataTemp    = {};
    waveDromClock       = {netlistId: null, edge: ""};

    this.contentArea.style.height = '40px';
    this.viewport.updateContentArea(0, [0, 0]);
    this.events.dispatch(ActionType.Zoom, 1, 0, 0);
    labelsPanel.renderLabelsPanels();
    this.viewport.init({chunkTime: 128, defaultZoom: 1, timeScale: 1, timeEnd: 0});
    vscode.postMessage({type: 'ready'});
  }

  setNumberFormat(numberFormat: string, netlistId: NetlistId) {
    if (netlistData[netlistId] === undefined) {return;}

    let valueFormat = valueFormatList.find((format) => format.id === numberFormat);

    if (valueFormat === undefined) {valueFormat = formatBinary;}

    netlistData[netlistId].valueFormat = valueFormat;

    //switch (numberFormat) {
    //  case 2:  netlistData[netlistId].valueFormat = formatBinary; break;
    //  case 10: netlistData[netlistId].valueFormat = formatDecimal; break;
    //  case 16: netlistData[netlistId].valueFormat = formatHex; break;
    //  default: netlistData[netlistId].valueFormat = formatBinary; break;
    //}

    netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);

    this.events.dispatch(ActionType.RedrawVariable, netlistId);
  }

  removeVariableInternal(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}
    vscode.postMessage({
      command: 'removeVariable',
      netlistId: netlistId
    });
  }

  removeVariable(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}
    const index = viewerState.displayedSignals.findIndex((id: NetlistId) => id === netlistId);
    //console.log('deleting signal' + message.signalId + 'at index' + index);
    if (index === -1) {
      return;
    } else {
      const newindex = Math.min(viewerState.displayedSignals.length - 2, index);
      this.events.dispatch(ActionType.RemoveVariable, netlistId);
      if (viewerState.selectedSignal === netlistId) {
        const newNetlistId = viewerState.displayedSignals[newindex];
        this.events.dispatch(ActionType.SignalSelect, newNetlistId);
      }
    }
  }

  addVariable(signalList: any) {
    // Handle rendering a signal, e.g., render the signal based on message content
    //console.log(message);

    const signalIdList: any   = [];
    const netlistIdList: any = [];
    let updateFlag      = false;
    let selectedSignal  = viewerState.selectedSignal;

    signalList.forEach((signal: any) => {

      const netlistId      = signal.netlistId;
      const signalId       = signal.signalId;

      netlistData[netlistId] = {
        signalId:     signalId,
        signalWidth:  signal.signalWidth,
        signalName:   signal.signalName,
        modulePath:   signal.modulePath,
        vscodeContext: "",
        type:         signal.type,
        valueFormat:  signal.signalWidth === 1 ? formatBinary : formatHex,
        textWidth:    0,
      };
      netlistData[netlistId].textWidth = netlistData[netlistId].valueFormat.getTextWidth(netlistData[netlistId].signalWidth);
      netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);
      netlistIdList.push(netlistId);

      if (waveformData[signalId] !== undefined) {
        selectedSignal = netlistId;
        updateFlag     = true;
      } else if (waveformDataTemp[signalId] !== undefined) {
        waveformDataTemp[signalId].netlistIdList.push(netlistId);
      } else if (waveformDataTemp[signalId] === undefined) {
        signalIdList.push(signalId);
        waveformDataTemp[signalId] = {
          netlistIdList: [netlistId],
          totalChunks: 0
        };
      }
    });

    viewerState.displayedSignals = viewerState.displayedSignals.concat(netlistIdList);
    this.events.dispatch(ActionType.AddVariable, netlistIdList, updateFlag);
    this.events.dispatch(ActionType.SignalSelect, selectedSignal);

    dataQueue.request(signalIdList);
  }

  udpateWaveformChunk(message: any) {

    const signalId = message.signalId;
    if (waveformDataTemp[signalId].totalChunks === 0) {
      waveformDataTemp[signalId].totalChunks = message.totalChunks;
      waveformDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
      waveformDataTemp[signalId].chunkData   = new Array(message.totalChunks).fill("");
    }

    waveformDataTemp[signalId].chunkData[message.chunkNum]   = message.transitionDataChunk;
    waveformDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = waveformDataTemp[signalId].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    //console.log('all chunks loaded');

    dataQueue.receive(signalId);

    const netlistIdList = waveformDataTemp[signalId].netlistIdList;
    const netlistId     = netlistIdList[0];
    if (netlistId ===  undefined) {console.log('netlistId not found for signalId ' + signalId); return;}
    const signalWidth  = netlistData[netlistId].signalWidth;
    const nullValue = "X".repeat(signalWidth);
    const transitionData = JSON.parse(waveformDataTemp[signalId].chunkData.join(""));
    if (transitionData[0][0] !== 0) {
      transitionData.unshift([0, nullValue]);
    }
    if (transitionData[transitionData.length - 1][0] !== this.viewport.timeStop) {
      transitionData.push([this.viewport.timeStop, nullValue]);
    }
    waveformData[signalId] = {
      transitionData: transitionData,
      signalWidth:    signalWidth,
      chunkStart:     [],
    };

    // Create ChunkStart array
    waveformData[signalId].chunkStart = new Array(this.viewport.chunkCount).fill(transitionData.length);
    let chunkIndex = 0;
    for (let i = 0; i < transitionData.length; i++) {
      while (transitionData[i][0] >= this.viewport.chunkTime * chunkIndex) {
        waveformData[signalId].chunkStart[chunkIndex] = i;
        chunkIndex++;
      }
    }
    waveformData[signalId].chunkStart[0] = 1;
    waveformDataTemp[signalId] = undefined;

    this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";

    netlistIdList.forEach((netlistId: NetlistId) => {
      this.events.dispatch(ActionType.RedrawVariable, netlistId);
    });
  }

  handleMessage(e: any) {
    const message = e.data;

    switch (message.command) {
      case 'create-ruler':          {this.createRuler(message.waveformDataSet); break;}
      case 'unload':                {this.unload(); break;}
      case 'add-variable':          {this.addVariable(message.signalList); break;}
      case 'update-waveform-chunk': {this.udpateWaveformChunk(message); break;}
      case 'remove-signal':         {this.removeVariable(message.netlistId); break;}
      case 'setNumberFormat':       {this.setNumberFormat(message.numberFormat, message.netlistId); break;}
      case 'setWaveDromClock':      {waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'getSelectionContext':   {sendWebviewContext(); break;}
      case 'setMarker':             {this.events.dispatch(ActionType.MarkerSet, message.time, 0); break;}
      case 'setSelectedSignal':     {this.events.dispatch(ActionType.SignalSelect, message.netlistId); break;}
      case 'getContext':            {sendWebviewContext(); break;}
      case 'copyWaveDrom':          {this.copyWaveDrom(); break;}
    }
  }
}

const dataQueue   = new WaveformDataQueue();
const events      = new EventHandler();
export const controlBar  = new ControlBar(events);
export const viewport    = new Viewport(events);
export const labelsPanel  = new LabelsPanels(events);
const vaporview   = new VaporviewWebview(events, viewport, controlBar);

vscode.postMessage({ command: 'ready' });

//function getNonce(): string {
//  let text = '';
//  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//  for (let i = 0; i < 32; i++) {
//    text += possible.charAt(Math.floor(Math.random() * possible.length));
//  }
//  return text;
//}