import { error } from 'console';
import { Viewport } from './viewport';

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


// Search handler variables
let searchState         = 0;
let searchInFocus       = false;

// Data formatting variables
let bitChunkWidth       = 4;

// drag handler variables
let labelsList: any            = [];
let idleItems: any             = [];
let draggableItem: any         = null;
let draggableItemIndex: any    = null;
let draggableItemNewIndex: any = null;
let pointerStartX: any         = null;
let pointerStartY: any         = null;
let resizeIndex: any           = null;

let resizeDebounce: any       = 0;
let highlightElement: any     = null;
let highlightDebounce: any    = null;
let highlightListenerSet = false;
let mouseupEventType: any     = null;
let touchpadScrolling    = false;

// Marker and signal selection variables
let markerTime: any          = null;
let altMarkerTime: any       = null;
let selectedSignal: any      = null;
let selectedSignalIndex: any = null;

// Data variables
let contentData         = [];
let displayedSignals: any[]    = [];
let waveformData: WaveformData[] = [];
let netlistData: NetlistData[] = [];
let waveformDataTemp: any    = [];

let waveDromClock = {
  netlistId: null,
  edge: '1',
};
const domParser           = new DOMParser();


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
function arrayMove(array: any[], fromIndex: number, toIndex: number) {
  const element = array[fromIndex];
  array.splice(fromIndex, 1);
  array.splice(toIndex, 0, element);
}

export function createLabel(netlistId: NetlistId, isSelected: boolean) {
  //let selectorClass = 'is-idle';
  //if (isSelected) {selectorClass = 'is-selected';}
  const vscodeContext = netlistData[netlistId].vscodeContext;
  const selectorClass = isSelected ? 'is-selected' : 'is-idle';
  const signalName    = htmlSafe(netlistData[netlistId].signalName);
  const modulePath    = htmlSafe(netlistData[netlistId].modulePath + '.');
  const fullPath      = htmlAttributeSafe(modulePath + signalName);
  return `<div class="waveform-label ${selectorClass}" id="label-${netlistId}" title="${fullPath}" ${vscodeContext}>
            <div class='codicon codicon-grabber'></div>
            <p style="opacity:50%">${modulePath}</p><p>${signalName}</p>
          </div>`;
}

export function createValueDisplayElement(netlistId: NetlistId, value: any, isSelected: boolean) {

  if (value === undefined) {value = [];}

  const vscodeContext = netlistData[netlistId].vscodeContext;
  const selectorClass = isSelected ? 'is-selected' : 'is-idle';
  const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
  const width         = netlistData[netlistId].signalWidth;
  const numberFormat  = netlistData[netlistId].numberFormat;
  const pElement      = value.map((v: string) => {
    const is4State     = valueIs9State(v);
    const color        = is4State ? 'style="color:var(--vscode-debugTokenExpression-error)"' : '';
    const displayValue = parseValue(v, width, is4State, numberFormat);
    return `<p ${color}>${displayValue}</p>`;
  }).join(joinString);

  return `<div class="waveform-label ${selectorClass}" id="value-${netlistId}" ${vscodeContext}>${pElement}</div>`;
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
    markerTime:    markerTime,
    altMarkerTime: altMarkerTime
  });
}

export function sendDisplayedSignals() {
  vscode.postMessage({
    command: 'setDisplayedSignals',
    signals: displayedSignals
  });
}

export function sendWebviewContext() {

  vscode.postMessage({
    command: 'contextUpdate',
    markerTime: markerTime,
    altMarkerTime: altMarkerTime,
    selectedSignal: selectedSignal,
    displayedSignals: displayedSignals,
    zoomRatio: vaporview.viewport.zoomRatio,
    scrollLeft: vaporview.viewport.pseudoScrollLeft,
  });
}

export function setSignalContextAttribute(netlistId: NetlistId) {
  const width        = netlistData[netlistId].signalWidth;
  const numberFormat = netlistData[netlistId].numberFormat;
  const modulePath   = netlistData[netlistId].modulePath;
  const signalName   = netlistData[netlistId].signalName;
  const attribute    = `data-vscode-context=${JSON.stringify({
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
  controlBar: HTMLElement;
  labels: HTMLElement;
  transitionDisplay: HTMLElement;
  labelsScroll: HTMLElement;
  transitionScroll: HTMLElement;
  scrollArea: HTMLElement;
  contentArea: HTMLElement;
  scrollbar: HTMLElement;
  zoomInButton: HTMLElement;
  zoomOutButton: HTMLElement;
  prevNegedge: HTMLElement;
  prevPosedge: HTMLElement;
  nextNegedge: HTMLElement;
  nextPosedge: HTMLElement;
  prevEdge: HTMLElement;
  nextEdge: HTMLElement;
  timeEquals: HTMLElement;
  valueEquals: HTMLElement;
  previousButton: HTMLElement;
  nextButton: HTMLElement;
  touchScroll: HTMLElement;
  searchContainer: HTMLElement;
  searchBar: any;
  valueIconRef: HTMLElement;
  resize1: HTMLElement;
  resize2: HTMLElement;

  // Components
  viewport: Viewport;

  // Other
  mutationObserver: MutationObserver;

  // Globals
  parsedSearchValue: string | null = null;

  //
  highlightEndEvent: any = null;
  highlightStartEvent: any = null;
  resizeElement: any = null;
  scrollcountTimeout: any = null;

  constructor() {
    // Assuming you have a reference to the webview element
    const webview           = document.getElementById('vaporview-top');
    const controlBar        = document.getElementById('control-bar');
    const labels            = document.getElementById('waveform-labels');
    const transitionDisplay = document.getElementById('transition-display');
    const labelsScroll      = document.getElementById('waveform-labels-container');
    const transitionScroll  = document.getElementById('transition-display-container');
    const scrollArea        = document.getElementById('scrollArea');
    const contentArea       = document.getElementById('contentArea');
    const scrollbar         = document.getElementById('scrollbar');
    // buttons
    const zoomInButton  = document.getElementById('zoom-in-button');
    const zoomOutButton = document.getElementById('zoom-out-button');
    const prevNegedge   = document.getElementById('previous-negedge-button');
    const prevPosedge   = document.getElementById('previous-posedge-button');
    const nextNegedge   = document.getElementById('next-negedge-button');
    const nextPosedge   = document.getElementById('next-posedge-button');
    const prevEdge      = document.getElementById('previous-edge-button');
    const nextEdge      = document.getElementById('next-edge-button');
    const timeEquals    = document.getElementById('time-equals-button');
    const valueEquals   = document.getElementById('value-equals-button');
    const previousButton = document.getElementById('previous-button');
    const nextButton    = document.getElementById('next-button');
    const touchScroll   = document.getElementById('touchpad-scroll-button');
    // Search bar
    const searchContainer = document.getElementById('search-container');
    const searchBar     = document.getElementById('search-bar');
    const valueIconRef  = document.getElementById('value-icon-reference');
    // resize elements
    const resize1       = document.getElementById("resize-1");
    const resize2       = document.getElementById("resize-2");

    if (webview === null || controlBar === null || 
      labels === null || transitionDisplay === null || labelsScroll === null ||
      transitionScroll === null || scrollArea === null || contentArea === null ||
      scrollbar === null || zoomInButton === null || zoomOutButton === null ||
      prevNegedge === null || prevPosedge === null || nextNegedge === null || 
      nextPosedge === null || prevEdge === null || nextEdge === null || 
      timeEquals === null || valueEquals === null || previousButton === null ||
      nextButton === null || touchScroll === null || searchContainer === null ||
      searchBar === null || valueIconRef === null || resize1 === null || resize2 === null) {
      throw new Error("Could not find all required elements");
    }

    this.webview = webview;
    this.controlBar = controlBar;
    this.labels = labels;
    this.transitionDisplay = transitionDisplay;
    this.labelsScroll = labelsScroll;
    this.transitionScroll = transitionScroll;
    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar = scrollbar;
    this.zoomInButton = zoomInButton;
    this.zoomOutButton = zoomOutButton;
    this.prevNegedge = prevNegedge;
    this.prevPosedge = prevPosedge;
    this.nextNegedge = nextNegedge;
    this.nextPosedge = nextPosedge;
    this.prevEdge = prevEdge;
    this.nextEdge = nextEdge;
    this.timeEquals = timeEquals;
    this.valueEquals = valueEquals;
    this.previousButton = previousButton;
    this.nextButton = nextButton;
    this.touchScroll = touchScroll;
    this.searchContainer = searchContainer;
    this.searchBar = searchBar;
    this.valueIconRef = valueIconRef;
    this.resize1 = resize1;
    this.resize2 = resize2;

    webview.style.gridTemplateColumns = `150px 50px auto`;

    this.viewport = new Viewport(scrollArea, contentArea, scrollbar, displayedSignals, waveformData, netlistData, markerTime, altMarkerTime, selectedSignal);
 
    // #region Primitive Handlers
    window.addEventListener('message', (e) => {this.handleMessage(e);});
    labelsScroll.addEventListener(    'scroll', (e) => {this.syncVerticalScroll(labelsScroll.scrollTop);});
    transitionScroll.addEventListener('scroll', (e) => {this.syncVerticalScroll(transitionScroll.scrollTop);});
    scrollArea.addEventListener(      'scroll', (e) => {this.syncVerticalScroll(scrollArea.scrollTop);});
    // scroll handler to handle zooming and scrolling
    scrollArea.addEventListener('wheel', (e) => {this.scrollHandler(e);});
    window.addEventListener('keydown', (e) => {this.keyDownHandler(e);});
    // click handler to handle clicking inside the waveform viewer
    // gets the absolute x position of the click relative to the scrollable content
    contentArea.addEventListener('mousedown', (e) => {this.handleScrollAreaMouseDown(e);});
    scrollbar.addEventListener('mousedown',   (e) => {this.handleScrollbarDrag(e);});
    // resize handler to handle column resizing
    resize1.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize1, 1);});
    resize2.addEventListener("mousedown",   (e) => {this.handleResizeMousedown(e, resize2, 2);});
    window.addEventListener('resize',       ()  => {this.handleResizeViewer();}, false);
    // Control bar button event handlers
    zoomInButton.addEventListener( 'click', (e) => {this.viewport.handleZoom(-1, (this.viewport.pseudoScrollLeft + this.viewport.halfViewerWidth) / this.viewport.zoomRatio, this.viewport.halfViewerWidth);});
    zoomOutButton.addEventListener('click', (e) => {this.viewport.handleZoom( 1, (this.viewport.pseudoScrollLeft + this.viewport.halfViewerWidth) / this.viewport.zoomRatio, this.viewport.halfViewerWidth);});
    prevNegedge.addEventListener(  'click', (e) => {this.goToNextTransition(-1, '0');});
    prevPosedge.addEventListener(  'click', (e) => {this.goToNextTransition(-1, '1');});
    nextNegedge.addEventListener(  'click', (e) => {this.goToNextTransition( 1, '0');});
    nextPosedge.addEventListener(  'click', (e) => {this.goToNextTransition( 1, '1');});
    prevEdge.addEventListener(     'click', (e) => {this.goToNextTransition(-1);});
    nextEdge.addEventListener(     'click', (e) => {this.goToNextTransition( 1);});
    // Search bar event handlers
    searchBar.addEventListener(    'focus', (e) => {this.handleSearchBarInFocus(true);});
    searchBar.addEventListener(     'blur', (e) => {this.handleSearchBarInFocus(false);});
    searchBar.addEventListener(  'keydown', (e) => {this.handleSearchBarKeyDown(e);});
    searchBar.addEventListener(    'keyup', (e) => {this.handleSearchBarEntry(e);});
    timeEquals.addEventListener(   'click', (e) => {this.handleSearchButtonSelect(0);});
    valueEquals.addEventListener(  'click', (e) => {this.handleSearchButtonSelect(1);});
    previousButton.addEventListener('click', (e) => {this.handleSearchGoTo(-1);});
    nextButton.addEventListener(    'click', (e) => {this.handleSearchGoTo(1);});
    this.setButtonState(previousButton, 0);
    touchScroll.addEventListener(   'click', (e) => {this.handleTouchScroll();});
    // click and drag handlers to rearrange the order of waveform signals
    labels.addEventListener('mousedown', (e) => {this.dragStart(e);});
    window.addEventListener('mouseup', (e) => {this.handleMouseUp(e);});
    // Event handlers to handle clicking on a waveform label to select a signal
    labels.addEventListener(           'click', (e) => this.clicklabel(e, labels));
    transitionDisplay.addEventListener('click', (e) => this.clicklabel(e, transitionDisplay));

    this.mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node: any) => {
          if (node.classList.contains('shallow-chunk')) {
            node.classList.remove('shallow-chunk');
            node.classList.add('rendering-chunk');
            const chunkIndex = parseInt(node.id.split('-')[1]);
            const data     = this.viewport.dataCache.columns[chunkIndex];
            if (!data || data.abortFlag || !data.isSafeToRemove) {
              //console.log('chunk ' + chunkIndex + ' is not safe to touch');
              //console.log(data);
              return;
            }
            this.viewport.dataCache.columns[chunkIndex].isSafeToRemove = false;
            this.viewport.dataCache.updatesPending++;
            this.viewport.renderWaveformsAsync(node, chunkIndex);
          }
        });
      });
    });
    this.mutationObserver.observe(contentArea, {childList: true});

    this.dragMove = this.dragMove.bind(this);
    this.resize = this.resize.bind(this);
    this.drawHighlightZoom = this.drawHighlightZoom.bind(this);
    this.resetTouchpadScrollCount = this.resetTouchpadScrollCount.bind(this);
  }

  scrollHandler(e: any) {
    e.preventDefault();

    //console.log(event);

    if (!touchpadScrolling) {e.preventDefault();}
    const deltaY = e.deltaY;
    const deltaX = e.deltaX;
    if (e.shiftKey && !touchpadScrolling) {
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
      if      (!touchpadScrolling && (deltaY > 0)) {this.viewport.handleZoom( 1, time, pixelLeft);}
      else if (!touchpadScrolling && (deltaY < 0)) {this.viewport.handleZoom(-1, time, pixelLeft);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else if (touchpadScrolling) {
        this.viewport.touchpadScrollCount += deltaY;
        clearTimeout(this.scrollcountTimeout);
        this.scrollcountTimeout = setTimeout(this.resetTouchpadScrollCount, 1000);
        this.viewport.handleZoom(Math.round(this.viewport.touchpadScrollCount / 25), time, pixelLeft);
      }

    } else {
      if (touchpadScrolling) {
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
    if (searchInFocus) {return;} 
    else {e.preventDefault();}

    // debug handler to print the data cache
    if (e.key === 'd' && e.ctrlKey) {
      console.log(this.viewport.updatePending);
      console.log(this.viewport.dataCache);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition

    if ((e.key === 'ArrowRight') && (markerTime !== null)) {
      if (e.ctrlKey || e.altKey) {this.goToNextTransition(1);}
      else if (e.metaKey) {this.handleMarkerSet(this.viewport.timeStop, 0);}
      else                    {this.handleMarkerSet(markerTime + 1, 0);}
    } else if ((e.key === 'ArrowLeft') && (markerTime !== null)) {
      if (e.ctrlKey || e.altKey)  {this.goToNextTransition(-1);}
      else if (e.metaKey) {this.handleMarkerSet(0, 0);}
      else                    {this.handleMarkerSet(markerTime - 1, 0);}

    // up and down arrow keys move the selected signal
    // alt + up and down arrow keys reorder the selected signal up and down
    } else if ((e.key === 'ArrowUp') && (selectedSignalIndex !== null)) {
      const newIndex = Math.max(selectedSignalIndex - 1, 0);
      if (e.altKey)  {this.reorderSignals(selectedSignalIndex, newIndex);}
      else               {this.handleSignalSelect(displayedSignals[newIndex]);}
    } else if ((e.key === 'ArrowDown') && (selectedSignalIndex !== null)) {
      const newIndex = Math.min(selectedSignalIndex + 1, displayedSignals.length - 1);
      if (e.altKey)  {this.reorderSignals(selectedSignalIndex, newIndex);}
      else               {this.handleSignalSelect(displayedSignals[newIndex]);}
    }

    // handle Home and End keys to move to the start and end of the waveform
    else if (e.key === 'Home') {this.handleMarkerSet(0, 0);}
    else if (e.key === 'End')  {this.handleMarkerSet(this.viewport.timeStop, 0);}

    // "N" and Shoft + "N" go to the next transition
    else if (e.key === 'n') {this.goToNextTransition(1);}
    else if (e.key === 'N') {this.goToNextTransition(-1);}
  }

  handleSearchBarKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.handleSearchGoTo(1);
      return;
    }
  }

  handleScrollAreaMouseDown(event: MouseEvent) {
    if (event.button === 1) {
      this.handleScrollAreaClick(event, 1);
    } else if (event.button === 0) {
      this.highlightStartEvent = event;
      mouseupEventType    = 'markerSet';

      if (!highlightListenerSet) {
        this.scrollArea.addEventListener('mousemove', this.drawHighlightZoom, false);
        highlightListenerSet = true;
      }

    }
  }

  handleScrollAreaClick(event: any, eventButton: number) {

    let button = eventButton;

    if (eventButton === 1) {event.preventDefault();}
    if (eventButton === 2) {return;}
    if (eventButton === 0 && event.altKey) {button = 1;}

    const snapToDistance = 3.5;

    // Get the time position of the click
    const time     = this.viewport.getTimeFromClick(event);
    let snapToTime = time;

    // Get the signal id of the click
    let netlistId: any     = null;
    const waveChunkId = event.target?.closest('.waveform-chunk');
    if (waveChunkId) {netlistId = parseInt(waveChunkId.id.split('--').slice(1).join('--'));}
    if (netlistId !== undefined && netlistId !== null) {

      if (button === 0) {
        this.handleSignalSelect(netlistId);
      }

      const signalId = netlistData[netlistId].signalId;

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = this.viewport.getNearestTransition(signalId, time);

      if (nearestTransition === null) {return;}

      const nearestTime       = nearestTransition[0];
      const pixelDistance     = Math.abs(nearestTime - time) * this.viewport.zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
    }

    this.handleMarkerSet(snapToTime, button);
  }

  handleMouseUp(event: MouseEvent) {
    //console.log('mouseup event type: ' + mouseupEventType);
    if (mouseupEventType === 'rearrange') {
      this.dragEnd(event);
    } else if (mouseupEventType === 'resize') {
      this.resizeElement.classList.remove('is-resizing');
      document.removeEventListener("mousemove", this.resize, false);
      this.handleResizeViewer();
    } else if (mouseupEventType === 'scroll') {
      this.scrollbar.classList.remove('is-dragging');
      document.removeEventListener('mousemove', this.viewport.handleScrollbarMove, false);
      this.viewport.scrollbarMoved = false;
    } else if (mouseupEventType === 'highlightZoom') {
      this.scrollArea.removeEventListener('mousemove', this.drawHighlightZoom, false);
      highlightListenerSet = false;
      this.highlightZoom();
    } else if (mouseupEventType === 'markerSet') {
      this.scrollArea.removeEventListener('mousemove', this.drawHighlightZoom, false);
      clearTimeout(highlightDebounce);
      this.handleScrollAreaClick(this.highlightStartEvent, 0);
      highlightListenerSet = false;
      if (highlightElement) {
        highlightElement.remove();
        highlightElement = null;
      }
    }
    mouseupEventType = null;
  }

  handleTouchScroll() {
    touchpadScrolling = !touchpadScrolling;
    this.setButtonState(this.touchScroll, touchpadScrolling ? 2 : 1);
  }

  // #region Global Events
  reorderSignals(oldIndex: number, newIndex: number) {
  
    if (draggableItem) {
      draggableItem.style   = null;
      draggableItem.classList.remove('is-draggable');
      draggableItem.classList.add('is-idle');
    } else {
      labelsList = Array.from(this.labels.querySelectorAll('.waveform-label'));
    }
  
    this.viewport.updatePending = true;
    arrayMove(displayedSignals, oldIndex, newIndex);
    arrayMove(labelsList,       oldIndex, newIndex);
    this.handleSignalSelect(displayedSignals[newIndex]);
    this.renderLabelsPanels();
    for (let i = this.viewport.dataCache.startIndex; i < this.viewport.dataCache.endIndex; i+=this.viewport.chunksInColumn) {
      const waveformColumn = document.getElementById('waveform-column-' + i + '-' + this.viewport.chunksInColumn);
      if (!waveformColumn) {continue;}
      const children       = Array.from(waveformColumn.children);
      arrayMove(children, oldIndex, newIndex);
      waveformColumn.replaceChildren(...children);
    }
    this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
  }

  removeSignal(netlistId: NetlistId) {
    const index = displayedSignals.findIndex((id: NetlistId) => id === netlistId);
    //console.log('deleting signal' + message.signalId + 'at index' + index);
    if (index === -1) {
      //console.log('could not find signal ' + message.netlistId + ' to delete');
      return;
    } else {
      displayedSignals.splice(index, 1);
      this.viewport.updatePending    = true;
      this.renderLabelsPanels();
      for (let i = this.viewport.dataCache.startIndex; i < this.viewport.dataCache.endIndex; i+=this.viewport.chunksInColumn) {
        const waveformColumn = document.getElementById('waveform-column-' + i + '-' + this.viewport.chunksInColumn);
        if (!waveformColumn) {continue;}
        const children       = Array.from(waveformColumn.children);
        children.splice(index, 1);
        waveformColumn.replaceChildren(...children);
      }
      this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
      this.contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";

      if (selectedSignal === netlistId) {
        this.handleSignalSelect(null);
      }
    }
  }

  handleResizeViewer() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(this.viewport.updateViewportWidth, 100);
  }

  handleMarkerSet(time: number, markerType: number) {

    if (time > this.viewport.timeStop) {return;}

    const oldMarkerTime = markerType === 0 ? markerTime         : altMarkerTime;
    let   chunkIndex    = markerType === 0 ? this.viewport.markerChunkIndex   : this.viewport.altMarkerChunkIndex;
    const id            = markerType === 0 ? 'main-marker'      : 'alt-marker';
    let viewerMoved     = false;

    // dispose of old marker
    if (oldMarkerTime !== null) {
      if (chunkIndex !== null && chunkIndex >= this.viewport.dataCache.startIndex && chunkIndex < this.viewport.dataCache.endIndex + this.viewport.chunksInColumn) {
        const timeMarker = document.getElementById(id);
        if (timeMarker) {
          timeMarker.remove();
          //console.log('removing marker at time ' + oldMarkerTime + ' from chunk ' + chunkIndex + '');
        } else {
          //console.log('Could not find id: ' + id + ' chunk index ' + chunkIndex + ' is not in cache');
        }
      } else {
        //console.log('chunk index ' + chunkIndex + ' is not in cache');
      }
    }

    if (time === null) {
      if (markerType === 0) {
        markerTime         = null;
        this.viewport.markerChunkIndex   = null;
      } else {
        altMarkerTime         = null;
        this.viewport.altMarkerChunkIndex   = null;
      }
      return;
    }

    // first find the chunk with the marker
    chunkIndex   = Math.floor(time / this.viewport.chunkTime);

    // create new marker
    if (chunkIndex >= this.viewport.dataCache.startIndex && chunkIndex < this.viewport.dataCache.endIndex + this.viewport.chunksInColumn) {
      const clusterIndex = Math.floor((chunkIndex - this.viewport.dataCache.startIndex) / this.viewport.chunksInColumn);
      const chunkElement   = this.contentArea.getElementsByClassName('column-chunk')[clusterIndex];
      const marker         = domParser.parseFromString(this.viewport.createTimeMarker(time, markerType), 'text/html').body.firstChild;

      if (marker) {chunkElement.appendChild(marker);}

      //console.log('adding marker at time ' + time + ' from chunk ' + chunkIndex + '');
    } else {
      //console.log('chunk index ' + chunkIndex + ' is not in cache');
    }

    if (markerType === 0) {
      markerTime            = time;
      this.viewport.markerChunkIndex      = chunkIndex;

      viewerMoved = this.viewport.moveViewToTime(time);

      // Get values for all displayed signals at the marker time
      displayedSignals.forEach((netlistId) => {
        const signalId = netlistData[netlistId].signalId;
        this.viewport.dataCache.valueAtMarker[signalId] = this.viewport.getValueAtTime(signalId, time);
      });

      this.renderLabelsPanels();
    } else {
      altMarkerTime         = time;
      this.viewport.altMarkerChunkIndex   = chunkIndex;
    }

    //setTimeOnStatusBar();
    sendWebviewContext();
  }

  handleSignalSelect(netlistId: NetlistId | null) {

    if (netlistId === null) {return;}
  
    let element;
    let index;
  
    for (let i = this.viewport.dataCache.startIndex; i < this.viewport.dataCache.endIndex; i+=this.viewport.chunksInColumn) {
      element = document.getElementById('idx' + i + '-' + this.viewport.chunksInColumn + '--' + selectedSignal);
      if (element) {
        element.classList.remove('is-selected');
        this.viewport.dataCache.columns[i].waveformChunk[selectedSignal].html = element.outerHTML;
      }
  
      element = document.getElementById('idx' + i + '-' + this.viewport.chunksInColumn + '--' + netlistId);
      if (element) {
        element.classList.add('is-selected');
        this.viewport.dataCache.columns[i].waveformChunk[netlistId].html = element.outerHTML;
      }
    }
  
    selectedSignal      = netlistId;
    selectedSignalIndex = displayedSignals.findIndex((signal) => {return signal === netlistId;});
    if (selectedSignalIndex === -1) {selectedSignalIndex = null;}
  
    //setSeletedSignalOnStatusBar(netlistId);
    sendWebviewContext();
    this.renderLabelsPanels();
  
    if (netlistId === null) {return;}
  
    const numberFormat = netlistData[netlistId].numberFormat;
  
    this.updateButtonsForSelectedWaveform(netlistData[netlistId].signalWidth);
  
    if (numberFormat === 2)  {this.valueIconRef.setAttribute('href', '#search-binary');}
    if (numberFormat === 10) {this.valueIconRef.setAttribute('href', '#search-decimal');}
    if (numberFormat === 16) {this.valueIconRef.setAttribute('href', '#search-hex');}
  }




  copyWaveDrom() {

    // Maximum number of transitions to display
    // Maybe I should make this a user setting in the future...
    const MAX_TRANSITIONS = 32;
  
    // Marker and alt marker need to be set
    if (markerTime === null || altMarkerTime === null) {
      //vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
      return;
    }
  
    const timeWindow   = [markerTime, altMarkerTime].sort((a, b) => a - b);
    const chunkWindow  = [Math.floor(timeWindow[0] / this.viewport.chunkTime), Math.ceil(timeWindow[1] / this.viewport.chunkTime)];
    let allTransitions: any = [];
  
    // Populate the waveDrom names with the selected signals
    const waveDromData: any = {};
    displayedSignals.forEach((netlistId) => {
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
          displayedSignals.forEach((n) => {
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
        displayedSignals.forEach((n) => {
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
    displayedSignals.forEach((netlistId) => {
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

  goToNextTransition(direction: number, edge: string | undefined = undefined) {
    if (selectedSignal === null) {
      //handleMarkerSet(markerTime + direction, 0);
      return;
    }
  
    const signalId = netlistData[selectedSignal].signalId;
    const data     = waveformData[signalId];
    const time     = markerTime;
    let timeIndex;
    let indexIncrement;
  
    if (edge === undefined) {
      timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time;});
      indexIncrement = 1;
    } else {
      timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time && v === edge;});
      indexIncrement = 2;
    }
  
    if (timeIndex === -1) {
      //console.log('search found a -1 index');
      return;
    }
  
    if ((direction === 1) && (time === data.transitionData[timeIndex][0])) {timeIndex += indexIncrement;}
    else if (direction === -1) {timeIndex -= indexIncrement;}
  
    timeIndex = Math.max(timeIndex, 0);
    timeIndex = Math.min(timeIndex, data.transitionData.length - 1);
  
    this.handleMarkerSet(data.transitionData[timeIndex][0], 0);
  }

  renderLabelsPanels() {
    labelsList  = [];
    const transitions: string[] = [];
    displayedSignals.forEach((netlistId, index) => {
      const signalId     = netlistData[netlistId].signalId;
      const numberFormat = netlistData[netlistId].numberFormat;
      const signalWidth  = netlistData[netlistId].signalWidth;
      const data           = waveformData[signalId];
      const isSelected   = (index === selectedSignalIndex);
      labelsList.push(createLabel(netlistId, isSelected));
      transitions.push(createValueDisplayElement(netlistId, this.viewport.dataCache.valueAtMarker[signalId], isSelected));
      if (data) {
        data.textWidth   = this.viewport.getValueTextWidth(signalWidth, numberFormat);
      }
    });
    this.labels.innerHTML            = labelsList.join('');
    this.transitionDisplay.innerHTML = transitions.join('');
  }

  setButtonState(buttonId: any, state: number) {
    if (state === 0) {
      buttonId.classList.remove('selected-button');
      buttonId.classList.add('disabled-button');
    } else if (state === 1) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.remove('selected-button');
    } else if (state === 2) {
      buttonId.classList.remove('disabled-button');
      buttonId.classList.add('selected-button');
    }
  }

  setBinaryEdgeButtons(selectable: number) {
    this.setButtonState(this.prevNegedge, selectable);
    this.setButtonState(this.prevPosedge, selectable);
    this.setButtonState(this.nextNegedge, selectable);
    this.setButtonState(this.nextPosedge, selectable);
  }

  setBusEdgeButtons(selectable: number) {
    this.setButtonState(this.prevEdge, selectable);
    this.setButtonState(this.nextEdge, selectable);
  }

  updateButtonsForSelectedWaveform(width: number) {
    if (width === null) {
      this.setBinaryEdgeButtons(0);
      this.setBusEdgeButtons(0);
    } else if (width === 1) {
      this.setBinaryEdgeButtons(1);
      this.setBusEdgeButtons(1);
    } else {
      this.setBinaryEdgeButtons(0);
      this.setBusEdgeButtons(1);
    }
  }

  handleSearchButtonSelect(button: number) {
    this.handleSearchBarInFocus(true);
    searchState = button;
    if (searchState === 0) {
      this.setButtonState(this.timeEquals, 2);
      this.setButtonState(this.valueEquals, 1);
    } else if (searchState === 1) {
      this.setButtonState(this.timeEquals, 1);
      this.setButtonState(this.valueEquals, 2);
    }
    this.handleSearchBarEntry({key: 'none'});
  }

  checkValidTimeString(inputText: string) {
    if (inputText.match(/^[0-9]+$/)) {
      this.parsedSearchValue = inputText.replace(/,/g, '');
      return true;
    }
    else {return false;}
  }

  checkValidBinaryString(inputText: string) {
    if (inputText.match(/^b?[01xzXZdD_]+$/)) {
      this.parsedSearchValue = inputText.replace(/_/g, '').replace(/[dD]/g, '.');
      return true;
    } 
    else {return false;}
  }

  checkValidHexString(inputText: string) {
    if (inputText.match(/^(0x)?[0-9a-fA-FxzXZ_]+$/)) {
      this.parsedSearchValue = inputText.replace(/_/g, '').replace(/^0x/i, '');
      this.parsedSearchValue = this.parsedSearchValue.split('').map((c) => {
        if (c.match(/[xXzZ]/)) {return '....';}
        return parseInt(c, 16).toString(2).padStart(4, '0');
      }).join('');
      return true;
    }
    else {return false;}
  }

  checkValidDecimalString(inputText: string) {
    if (inputText.match(/^[0-9xzXZ_,]+$/)) {
      this.parsedSearchValue = inputText.replace(/,/g, '');
      this.parsedSearchValue = this.parsedSearchValue.split('_').map((n) => {
        if (n === '') {return '';}
        if (n.match(/[xXzZ]/)) {return '.{32}';}
        return parseInt(n, 10).toString(2).padStart(32, '0');
      }).join('');
      return true;
    }
    else {return false;}
  }
  
  handleSearchBarEntry(event: any) {
    const inputText  = this.searchBar.value;
    let inputValid   = true;
    let numberFormat = 16;
    if (selectedSignal) {
      numberFormat = netlistData[selectedSignal].numberFormat;
    }
  
    // check to see that the input is valid
    if (searchState === 0) {         inputValid = this.checkValidTimeString(inputText);
    } else if (searchState === 1) {
      if      (numberFormat === 2)  {inputValid = this.checkValidBinaryString(inputText);}
      else if (numberFormat === 16) {inputValid = this.checkValidHexString(inputText);} 
      else if (numberFormat === 10) {inputValid = this.checkValidDecimalString(inputText);}
    }
  
    // Update UI accordingly
    if (inputValid || inputText === '') {
      this.searchContainer.classList.remove('is-invalid');
    } else {
      this.searchContainer.classList.add('is-invalid');
    }
  
    if (inputValid && inputText !== '') {
      this.setButtonState(this.previousButton, searchState);
      this.setButtonState(this.nextButton, 1);
    } else {
      this.setButtonState(this.previousButton, 0);
      this.setButtonState(this.nextButton, 0);
    }
  }
  
  handleSearchGoTo(direction: number) {
    if (selectedSignal === null) {return;}
    if (this.parsedSearchValue === null) {return;}
  
    const signalId = netlistData[selectedSignal].signalId;
  
    if (searchState === 0 && direction === 1) {
      this.handleMarkerSet(parseInt(this.parsedSearchValue), 0);
    } else {
      const signalWidth      = waveformData[signalId].signalWidth;
      let trimmedSearchValue = this.parsedSearchValue;
      if (this.parsedSearchValue.length > signalWidth) {trimmedSearchValue = this.parsedSearchValue.slice(-1 * signalWidth);}
      const searchRegex = new RegExp(trimmedSearchValue, 'ig');
      const data      = waveformData[signalId];
      const timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= markerTime;});
      let indexOffset = 0;
  
      if (direction === -1) {indexOffset = -1;}
      else if (markerTime === data.transitionData[timeIndex][0]) {indexOffset = 1;}
  
      for (let i = timeIndex + indexOffset; i >= 0; i+=direction) {
        if (data.transitionData[i][1].match(searchRegex)) {
          this.handleMarkerSet(data.transitionData[i][0], 0);
          break;
        }
      }
    }
  }

  handleSearchBarInFocus(isFocused: boolean) {
    searchInFocus = isFocused;
    if (isFocused) {
      if (document.activeElement !== this.searchBar) {
        this.searchBar.focus();
      }
      if (this.searchContainer.classList.contains('is-focused')) {return;}
      this.searchContainer.classList.add('is-focused');
    } else {
      this.searchContainer.classList.remove('is-focused');
    }
  }
  
  clicklabel (event: any, containerElement: HTMLElement) {
    const labelsList   = Array.from(containerElement.querySelectorAll('.waveform-label'));
    const clickedLabel = event.target.closest('.waveform-label');
    const itemIndex    = labelsList.indexOf(clickedLabel);
    this.handleSignalSelect(displayedSignals[itemIndex]);
  }

  updateIdleItemsStateAndPosition() {
  const draggableItemRect = draggableItem.getBoundingClientRect();
  const draggableItemY    = draggableItemRect.top + draggableItemRect.height / 2;

  let closestItemAbove: any      = null;
  let closestItemBelow: any      = null;
  let closestDistanceAbove  = Infinity;
  let closestDistanceBelow  = Infinity;

  idleItems.forEach((item: any) => {
    item.style.border = 'none';
    const itemRect = item.getBoundingClientRect();
    const itemY = itemRect.top + itemRect.height / 2;
    if (draggableItemY >= itemY) {
      const distance = draggableItemY - itemY;
      if (distance < closestDistanceAbove) {
        closestDistanceAbove = distance;
        closestItemAbove     = item;
      }
    } else if (draggableItemY < itemY) {
      const distance = itemY - draggableItemY;
      if (distance < closestDistanceBelow) {
        closestDistanceBelow = distance;
        closestItemBelow     = item;
      }
    }
  });

  const closestItemAboveIndex = Math.max(labelsList.indexOf(closestItemAbove), 0);
  let closestItemBelowIndex = labelsList.indexOf(closestItemBelow);
  if (closestItemBelowIndex === -1) {closestItemBelowIndex = labelsList.length - 1;}

  if (closestItemBelow !== null) {
    closestItemBelow.style.borderTop    = '2px dotted var(--vscode-editorCursor-foreground)';
    closestItemBelow.style.borderBottom = '2px dotted transparent';
  } else if (closestItemAbove !== null) {
    closestItemAbove.style.borderTop    = '2px dotted transparent';
    closestItemAbove.style.borderBottom = '2px dotted var(--vscode-editorCursor-foreground)';
  }

  if (draggableItemIndex < closestItemAboveIndex) {
    draggableItemNewIndex = closestItemAboveIndex;
  } else if (draggableItemIndex > closestItemBelowIndex) {
    draggableItemNewIndex = closestItemBelowIndex;
  } else {
    draggableItemNewIndex = draggableItemIndex;
  }
  }

  dragStart(event: any) {
    event.preventDefault();
    labelsList = Array.from(this.labels.querySelectorAll('.waveform-label'));

    if (event.target.classList.contains('codicon-grabber')) {
      draggableItem = event.target.closest('.waveform-label');
    }

    if (!draggableItem) {return;}

    pointerStartX = event.clientX;
    pointerStartY = event.clientY;

    draggableItem.classList.remove('is-idle');
    draggableItem.classList.remove('is-selected');
    draggableItem.classList.add('is-draggable');

    document.addEventListener('mousemove', this.dragMove);

    mouseupEventType      = 'rearrange';
    draggableItemIndex    = labelsList.indexOf(draggableItem);
    draggableItemNewIndex = draggableItemIndex;
    idleItems             = labelsList.filter((item: any) => {return item.classList.contains('is-idle');});
  }

  dragMove(event: MouseEvent) {
    if (!draggableItem) {return;}

    const pointerOffsetX = event.clientX - pointerStartX;
    const pointerOffsetY = event.clientY - pointerStartY;

    draggableItem.style.transform = `translate(${pointerOffsetX}px, ${pointerOffsetY}px)`;

    this.updateIdleItemsStateAndPosition();
  }

  dragEnd(event: MouseEvent) {
    event.preventDefault();
    if (!draggableItem) {return;}

    idleItems.forEach((item: any) => {item.style = null;});
    document.removeEventListener('mousemove', this.dragMove);

    this.reorderSignals(draggableItemIndex, draggableItemNewIndex);

    labelsList            = [];
    idleItems             = [];
    draggableItemIndex    = null;
    draggableItemNewIndex = null;
    pointerStartX         = null;
    pointerStartY         = null;
    draggableItem         = null;
  }

  syncVerticalScroll(scrollLevel: number) {
    if (this.viewport.updatePending) {return;}
    this.viewport.updatePending              = true;
    this.labelsScroll.scrollTop     = scrollLevel;
    this.transitionScroll.scrollTop = scrollLevel;
    this.scrollArea.scrollTop       = scrollLevel;
    this.viewport.updatePending              = false;
  }

  // resize handler to handle resizing
  resize(e: MouseEvent) {
    const gridTemplateColumns = this.webview.style.gridTemplateColumns;
    const column1 = parseInt(gridTemplateColumns.split(' ')[0]);
    const column2 = parseInt(gridTemplateColumns.split(' ')[1]);

    if (resizeIndex === 1) {
      this.webview.style.gridTemplateColumns = `${e.x}px ${column2}px auto`;
      this.resize1.style.left = `${e.x}px`;
      this.resize2.style.left = `${e.x + column2}px`;
    } else if (resizeIndex === 2) {
      const newWidth    = Math.max(10, e.x - column1);
      const newPosition = Math.max(10 + column1, e.x);
      this.webview.style.gridTemplateColumns = `${column1}px ${newWidth}px auto`;
      this.resize2.style.left = `${newPosition}px`;
    }
  }

  handleResizeMousedown(event: MouseEvent, element: HTMLElement, index: number) {
    resizeIndex   = index;
    this.resizeElement = element;
    event.preventDefault();
    this.resizeElement.classList.add('is-resizing');
    document.addEventListener("mousemove", this.resize, false);
    mouseupEventType = 'resize';
  }

  resetTouchpadScrollCount() {
    this.viewport.touchpadScrollCount = 0;
  }

  handleScrollbarDrag(event: MouseEvent) {
    event.preventDefault();
    this.viewport.scrollbarMoved = false;
    this.viewport.scrollbarStartX = event.clientX;
    this.scrollbar.classList.add('is-dragging');

    document.addEventListener('mousemove', this.viewport.handleScrollbarMove, false);
    mouseupEventType = 'scroll';
  }

  highlightZoom() {
    const timeStart = this.viewport.getTimeFromClick(this.highlightStartEvent);
    const timeEnd   = this.viewport.getTimeFromClick(this.highlightEndEvent);
    const time      = Math.round((timeStart + timeEnd) / 2);
    const width     = Math.abs(this.highlightStartEvent.pageX - this.highlightEndEvent.pageX);
    const amount    = Math.ceil(Math.log2(width / this.viewport.viewerWidth));

    if (highlightElement) {
      highlightElement.remove();
      highlightElement = null;
    }

    this.viewport.handleZoom(amount, time, this.viewport.halfViewerWidth);
  }

  drawHighlightZoom(event: MouseEvent) {

    this.highlightEndEvent = event;
    const width       = Math.abs(this.highlightEndEvent.pageX - this.highlightStartEvent.pageX);
    const left        = Math.min(this.highlightStartEvent.pageX, this.highlightEndEvent.pageX);
    const elementLeft = left - this.scrollArea.getBoundingClientRect().left;
    const style       = `left: ${elementLeft}px; width: ${width}px; height: ${this.contentArea.style.height};`;
  
    if (width > 5) {mouseupEventType = 'highlightZoom';}
  
    if (!highlightElement) {
      highlightElement = domParser.parseFromString(`<div id="highlight-zoom" style="${style}"></div>`, 'text/html').body.firstChild;
      this.scrollArea.appendChild(highlightElement);
    } else {
      highlightElement.style.width = width + 'px';
      highlightElement.style.left  = elementLeft + 'px';
    }
  
    if (!highlightDebounce) {
      highlightDebounce = setTimeout(() => {
        mouseupEventType  = 'highlightZoom';
      }, 300);
    }
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
    selectedSignal      = null;
    selectedSignalIndex = null;
    markerTime          = null;
    altMarkerTime       = null;
    // Search handler variables
    searchInFocus       = false;
    // Data formatting variables
    bitChunkWidth       = 4;
    labelsList          = [];
    // Data variables
    contentData         = [];
    displayedSignals    = [];
    waveformData        = [];
    netlistData         = [];
    waveformDataTemp    = {};

    this.viewport = new Viewport(this.scrollArea, this.contentArea, this.scrollbar, displayedSignals, waveformData, netlistData, markerTime, altMarkerTime, selectedSignal);
    waveDromClock = {netlistId: null, edge: ""};

    this.contentArea.style.height = '0px';
    this.viewport.updateContentArea(0, [0, 0]);
    this.viewport.handleZoom(1, 0, 0);
    this.renderLabelsPanels();
    vscode.postMessage({type: 'ready'});
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
      displayedSignals.push(netlistId);

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
    this.renderLabelsPanels();

    if (updateFlag) {
      this.viewport.updatePending  = true;
      this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
      this.contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";
      this.handleSignalSelect(selectedSignal);
    }

    vscode.postMessage({
      command: 'fetchTransitionData',
      signalIdList: signalIdList,
    });
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
      textWidth:      this.viewport.getValueTextWidth(signalWidth, numberFormat),
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

    this.viewport.updateWaveformInCache([netlistId]);
    this.renderLabelsPanels();

    this.viewport.updatePending  = true;
    this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());
    this.contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";
    this.handleSignalSelect(netlistId);
  }

  setNumberFormat(numberFormat: number, netlistId: NetlistId) {
    if (netlistData[netlistId] === undefined) {return;}
  
    netlistData[netlistId].numberFormat  = numberFormat;
    netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);

    this.viewport.updatePending = true;
    this.viewport.updateWaveformInCache([netlistId]);
    this.renderLabelsPanels();
    this.viewport.updateContentArea(this.viewport.leftOffset, this.viewport.getBlockNum());

    if (netlistId === selectedSignal) {
      if (numberFormat === 2)  {this.valueIconRef.setAttribute('href', '#search-binary');}
      if (numberFormat === 10) {this.valueIconRef.setAttribute('href', '#search-decimal');}
      if (numberFormat === 16) {this.valueIconRef.setAttribute('href', '#search-hex');}
    }
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
      case 'setMarker':             {this.handleMarkerSet(message.time, 0); break; }
      case 'setSelectedSignal':     {this.handleSignalSelect(message.netlistId); break; }
      case 'getContext':            {sendWebviewContext(); break;}
      case 'copyWaveDrom':          {this.copyWaveDrom(); break;}
    }
  }
}

const vaporview = new VaporviewWebview();
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