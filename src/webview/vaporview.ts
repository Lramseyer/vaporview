import { error } from 'console';
import { Viewport } from './viewport';
import { LabelsPanels } from './labels';
import { ControlBar } from './control_bar';

declare function acquireVsCodeApi(): VsCodeApi;
export const vscode = acquireVsCodeApi();
interface VsCodeApi {
  postMessage(message: any): void;
  setState(newState: any): void;
  getState(): any;
}

export type NetlistId = number;
export type SignalId  = number;
export type NumberFormat = number;
export type ValueChange = [number, string];
export type NetlistData = {
  signalId: number;
  signalName: string;
  modulePath: string;
  signalWidth: number;
  numberFormat: number;
  vscodeContext: string;
};

export type WaveformData = {
  transitionData: any[];
  chunkStart: number[];
  textWidth: number;
  signalWidth: number;
};

let waveDromClock = {
  netlistId: null,
  edge: '1',
};
const domParser           = new DOMParser();

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


// Parse VCD values into either binary, hex, or decimal
// This function is so cursed...
export function parseValue(binaryString: string, width: number, is4State: boolean, numberFormat: NumberFormat) {

  let stringArray;

  // If number format is binary
  if (numberFormat === 2) {
    return binaryString.replace(/\B(?=(\d{4})+(?!\d))/g, "_");
  }

  // If number format is hexadecimal
  if (numberFormat === 16) {
    if (is4State) {
      stringArray = binaryString.replace(/\B(?=(.{4})+(?!.))/g, "_").split("_");
      return stringArray.map((chunk) => {
        if (chunk.match(/[zZ]/)) {return "Z";}
        if (chunk.match(/[xX]/)) {return "X";}
        return parseInt(chunk, 2).toString(numberFormat);
      }).join('').replace(/\B(?=(.{4})+(?!.))/g, "_");
    } else {
      stringArray = binaryString.replace(/\B(?=(\d{16})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        const digits = Math.ceil(chunk.length / 4);
        return parseInt(chunk, 2).toString(numberFormat).padStart(digits, '0');
      }).join('_');
    }
  }

  let xzMask = "";
  let numericalData = binaryString;

  // If number format is decimal
  if (numberFormat === 10) {
    if (is4State) {
      numericalData = binaryString.replace(/[XZ]/i, "0");
      xzMask = '|' +  binaryString.replace(/[01]/g, "0");
    }
    stringArray = numericalData.replace(/\B(?=(\d{32})+(?!\d))/g, "_").split("_");
    return stringArray.map((chunk) => {return parseInt(chunk, 2).toString(numberFormat);}).join('_') + xzMask;
  }

  return "";
}

export function getValueTextWidth(width: number, numberFormat: NumberFormat) {
  const characterWidth = 7.69;
  let   numeralCount   = 0;
  let   underscoreCount = 0;

  if (numberFormat === 2)  {
    numeralCount    = width;
    underscoreCount = Math.floor((width - 1) / 4);
  } 
  if (numberFormat === 16) {
    numeralCount    = Math.ceil(width / 4);
    underscoreCount = Math.floor((width - 1) / 16);
  }
  if (numberFormat === 10) {
    numeralCount    = Math.ceil(Math.log10(width % 32)) + (10 * Math.floor((width) / 32));
    underscoreCount = Math.floor((width - 1) / 32);
  }
  return (numeralCount + underscoreCount) * characterWidth;
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
  const numberFormat = netlistData[netlistId].numberFormat;
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
    numberFormat: numberFormat
  }).replace(/\s/g, '%x20')}`;
  return attribute;
}

class VaporviewWebview {

  // HTML Elements
  webview: HTMLElement;
  //controlBar: HTMLElement;
  labels: HTMLElement;
  transitionDisplay: HTMLElement;
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
    //const controlBar        = document.getElementById('control-bar');
    const labels            = document.getElementById('waveform-labels');
    const transitionDisplay = document.getElementById('transition-display');
    const labelsScroll      = document.getElementById('waveform-labels-container');
    const transitionScroll  = document.getElementById('transition-display-container');
    const scrollArea        = document.getElementById('scrollArea');
    const contentArea       = document.getElementById('contentArea');
    const scrollbar         = document.getElementById('scrollbar');

    if (webview === null || controlBar === null || 
      labels === null || transitionDisplay === null || labelsScroll === null ||
      transitionScroll === null || scrollArea === null || contentArea === null ||
      scrollbar === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview = webview;
    //this.controlBar = controlBar;
    this.labels = labels;
    this.transitionDisplay = transitionDisplay;
    this.labelsScroll = labelsScroll;
    this.transitionScroll = transitionScroll;
    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar = scrollbar;

    webview.style.gridTemplateColumns = `150px 50px auto`;
 
    // #region Primitive Handlers
    window.addEventListener('message', (e) => {this.handleMessage(e);});
    labelsScroll.addEventListener(    'scroll', (e) => {this.syncVerticalScroll(labelsScroll.scrollTop);});
    transitionScroll.addEventListener('scroll', (e) => {this.syncVerticalScroll(transitionScroll.scrollTop);});
    scrollArea.addEventListener(      'scroll', (e) => {this.syncVerticalScroll(scrollArea.scrollTop);});
    scrollArea.addEventListener('wheel', (e) => {this.scrollHandler(e);});
    window.addEventListener('keydown', (e) => {this.keyDownHandler(e);});
    window.addEventListener('resize',       ()  => {this.handleResizeViewer();}, false);
    window.addEventListener('mouseup', (e) => {this.handleMouseUp(e);});

    this.resetTouchpadScrollCount = this.resetTouchpadScrollCount.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.reorderSignals = this.reorderSignals.bind(this);

    this.events.subscribe(ActionType.Zoom, (direction: number, time: number, pixelLeft: number) => {
      this.resetTouchpadScrollCount();
    });
    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.reorderSignals);
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
      console.log(this.viewport.dataCache);
      console.log(viewerState);
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

  removeSignal(netlistId: NetlistId) {
    const index = viewerState.displayedSignals.findIndex((id: NetlistId) => id === netlistId);
    //console.log('deleting signal' + message.signalId + 'at index' + index);
    if (index === -1) {
      return;
    } else {
      this.events.dispatch(ActionType.RemoveVariable, netlistId);
      if (viewerState.selectedSignal === netlistId) {
        this.events.dispatch(ActionType.SignalSelect, null);
      }
    }
  }

  addVariable(signalList: any) {
    // Handle rendering a signal, e.g., render the signal based on message content
    //console.log(message);

    const signalIdList: any   = [];
    const netlistIdList: any = [];
    let updateFlag      = false;
    let selectedSignal  = null;

    signalList.forEach((signal: any) => {

      const netlistId      = signal.netlistId;
      const signalId       = signal.signalId;
      const numberFormat   = signal.numberFormat;
      const signalWidth    = signal.signalWidth;
      viewerState.displayedSignals.push(netlistId);

      netlistData[netlistId] = {
        signalId:     signalId,
        signalWidth:  signalWidth,
        signalName:   signal.signalName,
        modulePath:   signal.modulePath,
        numberFormat: numberFormat,
        vscodeContext: "",
      };
      netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);
      netlistIdList.push(netlistId);

      if (waveformData[signalId]) {
        selectedSignal  = netlistId;
        updateFlag = true;
      } else if (waveformDataTemp[signalId]) {
        console.log('signal data is being fetched');
      } else {
        signalIdList.push(signalId);
        waveformDataTemp[signalId] = {
          netlistId: netlistId,
          totalChunks: 0
        };
      }
    });

    this.viewport.updateWaveformInCache(netlistIdList);
    labelsPanel.renderLabelsPanels();

    if (updateFlag) {
      this.viewport.updatePending  = true;
      this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
      this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";
      this.events.dispatch(ActionType.SignalSelect, selectedSignal);
    }

    //if (signalIdList.length > 0) {
    //  vscode.postMessage({
    //    command: 'fetchTransitionData',
    //    signalIdList: signalIdList,
    //  });
    //}
    dataQueue.request(signalIdList);
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
            let numberFormat = netlistData[n].numberFormat;
            if (!numberFormat) {numberFormat = 16;}
            if (signal.initialState === null) {signal.json.wave += '.';}
            else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(signal.initialState);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(signal.initialState, signal.signalWidth, is4State, numberFormat));
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
          let numberFormat = netlistData[n].numberFormat;
            if (!numberFormat) {numberFormat = 16;}
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
                signal.json.data.push(parseValue(transition[1], signal.signalWidth, is4State, numberFormat));
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


  syncVerticalScroll(scrollLevel: number) {
    if (this.viewport.updatePending) {return;}
    this.viewport.updatePending     = true;
    this.labelsScroll.scrollTop     = scrollLevel;
    this.transitionScroll.scrollTop = scrollLevel;
    this.scrollArea.scrollTop       = scrollLevel;
    this.viewport.updatePending     = false;
  }

  resetTouchpadScrollCount() {
    this.viewport.touchpadScrollCount = 0;
  }

  createRuler(metadata: any) {
    //console.log("creating ruler");
    document.title                  = metadata.filename;
    this.viewport.chunkTime         = metadata.chunkTime;
    this.viewport.zoomRatio         = metadata.defaultZoom;
    this.viewport.timeScale         = metadata.timeScale;
    this.viewport.maxZoomRatio      = this.viewport.zoomRatio * 64;
    this.viewport.chunkWidth        = this.viewport.chunkTime * this.viewport.zoomRatio;
    this.viewport.chunkCount        = Math.ceil(metadata.timeEnd / metadata.chunkTime);
    this.viewport.timeStop          = metadata.timeEnd;
    this.viewport.dataCache.columns = new Array(this.viewport.chunkCount);

    this.viewport.updatePending = true;
    this.viewport.updateViewportWidth();
    this.viewport.getChunksWidth();
    this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
  }

  unload() {
    // Marker and signal selection variables
    viewerState.selectedSignal      = null;
    viewerState.selectedSignalIndex = null;
    viewerState.markerTime          = null;
    viewerState.altMarkerTime       = null;
    // Search handler variables
    // Data formatting variables

    // Data variables
    //contentData         = [];
    viewerState.displayedSignals    = [];
    waveformData        = [];
    netlistData         = [];
    waveformDataTemp    = {};

    this.viewport = new Viewport(this.events);
    waveDromClock = {netlistId: null, edge: ""};

    this.contentArea.style.height = '0px';
    this.viewport.updateContentArea(0, [0, 0]);
    this.events.dispatch(ActionType.Zoom, 1, 0, 0);
    labelsPanel.renderLabelsPanels();
    vscode.postMessage({type: 'ready'});
  }

  setNumberFormat(numberFormat: number, netlistId: NetlistId) {
    if (netlistData[netlistId] === undefined) {return;}
  
    netlistData[netlistId].numberFormat  = numberFormat;
    netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);

    this.events.dispatch(ActionType.RedrawVariable, netlistId);
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
    const transitionData = JSON.parse(waveformDataTemp[signalId].chunkData.join(""));

    const netlistId = waveformDataTemp[signalId].netlistId;
    if (netlistId ===  undefined) {console.log('netlistId not found for signalId ' + signalId); return;}
    const signalWidth = netlistData[netlistId].signalWidth;
    const numberFormat = netlistData[netlistId].numberFormat;
    const nullValue = "X".repeat(signalWidth);

    if (transitionData[0][0] !== 0) {
      transitionData.unshift([0, nullValue]);
    }
    if (transitionData[transitionData.length - 1][0] !== this.viewport.timeStop) {
      transitionData.push([this.viewport.timeStop, nullValue]);
    }
    waveformData[signalId] = {
      transitionData: transitionData,
      signalWidth:    signalWidth,
      textWidth:      getValueTextWidth(signalWidth, numberFormat),
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

    this.events.dispatch(ActionType.RedrawVariable, netlistId);
    this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";
  }

  handleMessage(e: any) {
    const message = e.data;

    switch (message.command) {
      case 'create-ruler':          {this.createRuler(message.waveformDataSet); break;}
      case 'unload':                {this.unload(); break;}
      case 'add-variable':          {this.addVariable(message.signalList); break;}
      case 'update-waveform-chunk': {this.udpateWaveformChunk(message); break;}
      case 'remove-signal':         {this.removeSignal(message.netlistId); break;}
      case 'setNumberFormat':       {this.setNumberFormat(message.numberFormat, message.netlistId); break;}
      case 'setWaveDromClock':      {waveDromClock = {netlistId: message.netlistId, edge:  message.edge,}; break;}
      case 'getSelectionContext':   {sendWebviewContext(); break;}
      case 'setMarker':             {this.events.dispatch(ActionType.MarkerSet, message.time, 0); break; }
      case 'setSelectedSignal':     {this.events.dispatch(ActionType.SignalSelect, message.netlistId); break; }
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

console.log('Hello Webview!');
vscode.postMessage({ command: 'ready' });

//function getNonce(): string {
//  let text = '';
//  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
//  for (let i = 0; i < 32; i++) {
//    text += possible.charAt(Math.floor(Math.random() * possible.length));
//  }
//  return text;
//}