import { vscode, NetlistData,  WaveformData, arrayMove, sendWebviewContext, NetlistId, SignalId, ValueChange, ActionType, EventHandler, viewerState, dataManager } from "./vaporview";
import { ValueFormat } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer } from './renderer';

type DataCache = {
  startIndex: number;
  endIndex: number;
  columns: any[];
  valueAtMarker: any;
  updatesPending: number;
  markerElement: string;
  altMarkerElement: string;
};

type columnCache = {
  waveformChunk: any;
  element: HTMLElement;
  rulerElement: HTMLElement;
  marker: HTMLElement | null;
  altMarker: HTMLElement | null;
  abortFlag: boolean;
  isSafeToRemove: boolean;
};

const domParser = new DOMParser();

export class Viewport {

  scrollArea: HTMLElement;
  contentArea: HTMLElement;
  scrollbar: HTMLElement;
  scrollbarContainer: HTMLElement;
  scrollbarCanvasElement: HTMLElement;
  scrollbarCanvas: CanvasRenderingContext2D;

  highlightElement: any     = null;
  highlightEndEvent: any    = null;
  highlightStartEvent: any  = null;
  highlightListenerSet      = false;
  highlightDebounce: any    = null;

  // UI preferences
  rulerNumberSpacing: number = 100;
  rulerTickSpacing: number   = 10;

  // Scroll handler variables
  pseudoScrollLeft: number    = 0;
  contentLeft: number         = 0;
  leftOffset: number          = 0;
  viewerWidth: number         = 0;
  halfViewerWidth: number     = 0;
  maxScrollLeft: number       = 0;
  maxScrollbarPosition: number = 0;
  scrollbarWidth: number      = 17;
  scrollbarPosition: number   = 0;
  scrollbarHidden: boolean    = true;

  touchpadScrollCount: number = 0;
  scrollbarMoved: boolean     = false;
  scrollbarStartX: number     = 0;

  // Zoom level variables
  timeScale: number           = 1;
  chunkCount: number          = 0;
  chunkTime: number           = 512;
  chunkWidth: number          = 512;
  zoomRatio: number           = 1;
  maxZoomRatio: number        = 64;
  chunksInColumn: number      = 1;
  columnTime: number          = this.chunkTime * this.chunksInColumn;
  timeStop: number            = 0;

  // Clusterize variables
  updatePending: boolean      = false;
  columnsInCluster: number    = 4;
  scrollEventPending: boolean = false;
  currentCluster              = [0, 0];
  columnWidth                 = this.chunksInColumn  * this.chunkWidth;

  // Marker variables
  markerChunkIndex: number | null    = null;
  altMarkerChunkIndex: number | null = null;
  markerAnnotation: string           = '';

  dataCache: DataCache = {
    startIndex:     0,
    endIndex:       0,
    columns:        [],
    valueAtMarker:  {},
    updatesPending: 0,
    markerElement:  '',
    altMarkerElement: '',
  };

  mutationObserver: MutationObserver;
  public batchSize = 8;

  constructor(
    private events: EventHandler,
  ) {
    const scrollArea         = document.getElementById('scrollArea');
    const contentArea        = document.getElementById('contentArea');
    const scrollbar          = document.getElementById('scrollbar');
    const scrollbarContainer = document.getElementById('scrollbarContainer');
    const scrollbarCanvas    = document.getElementById('scrollbarAreaCanvas');

    if (scrollArea === null || contentArea === null || scrollbar === null || 
      scrollbarContainer === null || scrollbarCanvas === null) {
      throw new Error('Viewport elements not found');
    }

    const canvasContext = (scrollbarCanvas as HTMLCanvasElement).getContext('2d');

    if (canvasContext === null) {
      throw new Error('Canvas context not found');
    }

    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar = scrollbar;
    this.scrollbarContainer = scrollbarContainer;
    this.scrollbarCanvasElement = scrollbarCanvas;
    this.scrollbarCanvas = canvasContext;

    // I calculated this as 174, 176, 173 @ 10% opacity in the default theme, but there was no CSS color that matched
    this.markerAnnotation = document.documentElement.style.getPropertyValue('--vscode-editorOverviewRuler-selectionHighlightForeground');

    // click handler to handle clicking inside the waveform viewer
    // gets the absolute x position of the click relative to the scrollable content
    contentArea.addEventListener('mousedown',        (e) => {this.handleScrollAreaMouseDown(e);});
    scrollbar.addEventListener('mousedown',          (e) => {this.handleScrollbarDrag(e);});
    scrollbarContainer.addEventListener('mousedown', (e) => {this.handleScrollbarContainerClick(e);});

    this.mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node: any) => {
          if (node.classList.contains('shallow-chunk')) {
            node.classList.remove('shallow-chunk');
            node.classList.add('rendering-chunk');
            const chunkIndex = parseInt(node.id.split('-')[1]);
            const data     = this.dataCache.columns[chunkIndex];
            if (!data || data.abortFlag || !data.isSafeToRemove) {
              //console.log('chunk ' + chunkIndex + ' is not safe to touch');
              //console.log(data);
              return;
            }
            this.dataCache.columns[chunkIndex].isSafeToRemove = false;
            this.dataCache.updatesPending++;
            this.renderWaveformsAsync(node, chunkIndex);
          }
        });
      });
    });
    this.mutationObserver.observe(contentArea, {childList: true});

    this.handleScrollbarMove = this.handleScrollbarMove.bind(this);
    this.updateViewportWidth = this.updateViewportWidth.bind(this);
    this.handleZoom = this.handleZoom.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);
    this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.highlightZoom = this.highlightZoom.bind(this);
    this.drawHighlightZoom = this.drawHighlightZoom.bind(this);
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleAddVariable = this.handleAddVariable.bind(this);
    this.handleRedrawSignal = this.handleRedrawSignal.bind(this);


    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.Zoom, this.handleZoom);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawSignal);
    this.events.subscribe(ActionType.Resize, this.updateViewportWidth);
  }

  init(metadata: any) {
    document.title    = metadata.filename;
    this.chunkTime    = metadata.chunkTime;
    this.zoomRatio    = metadata.defaultZoom;
    this.timeScale    = metadata.timeScale;
    this.timeStop     = metadata.timeEnd;
    this.maxZoomRatio = this.zoomRatio * 64;
    this.chunkWidth   = this.chunkTime * this.zoomRatio;
    this.chunkCount   = Math.ceil(metadata.timeEnd / metadata.chunkTime);
    this.dataCache    = {
      startIndex:     0,
      endIndex:       0,
      columns:        [],
      valueAtMarker:  {},
      updatesPending: 0,
      markerElement:  '',
      altMarkerElement: '',
    };
    this.updatePending = true;
    this.updateViewportWidth();
    this.updateContentArea(this.leftOffset, this.getBlockNum());
    this.scrollbarCanvasElement.setAttribute("width",  `${this.viewerWidth}`);
    this.scrollbarCanvasElement.setAttribute("height", `${this.scrollbarContainer.clientHeight}`);
  }

  renderWaveformChunk(netlistId: NetlistId, chunkStartIndex: number) {
    const result: any   = {};
    const netlistData   = dataManager.netlistData[netlistId];
    const signalId      = netlistData.signalId;
    const data          = dataManager.valueChangeData[signalId];
    const element       = document.createElement('div');
    const vscodeContext = netlistData.vscodeContext;
    element.id          = 'idx' + chunkStartIndex + '-' + this.chunksInColumn + '--' + netlistId;
    element.classList.add('waveform-chunk');
    if (netlistId === viewerState.selectedSignal) {element.classList.add('is-selected');}
    element.setAttribute("data-vscode-context", vscodeContext);

    if (!data) {
      //return {html: `<div class="waveform-chunk" id="idx${chunkStartIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}></div>`};
      return {html: element};
    }

    const timeStart    = chunkStartIndex * this.chunkTime;
    const timeEnd      = timeStart + this.columnTime;
    const startIndex   = data.chunkStart[chunkStartIndex];
    const endIndex     = data.chunkStart[chunkStartIndex + this.chunksInColumn];
    const initialState = data.transitionData[startIndex - 1];

    let postState: ValueChange;
    if (chunkStartIndex >= data.chunkStart.length - this.chunksInColumn) {
      postState  = [timeEnd, data.transitionData[data.transitionData.length - 1][1]];
    } else {
      postState  = data.transitionData[endIndex];
    }
    const relativeInitialState: ValueChange = [initialState[0] - timeStart, initialState[1]];
    const relativePostState: ValueChange    = [postState[0]    - timeStart, postState[1]];
    const chunkTransitionData: ValueChange[] = data.transitionData.slice(startIndex, endIndex).map(([time, value]) => {
      return [time - timeStart, value] as ValueChange;
    });

    const valueChangeChunk = {
      valueChanges: chunkTransitionData,
      initialState: relativeInitialState,
      postState: relativePostState,
      encoding: netlistData.encoding,
      signalWidth: netlistData.signalWidth,
      min: data.min,
      max: data.max,
    };

    // I should probably move this functionally into the data manager
    if (netlistData.encoding !== "Real") {
      if (netlistData.renderType.id === 'steppedSigned' || netlistData.renderType.id === 'linearSigned') {
        valueChangeChunk.min = Math.max(-Math.pow(2, netlistData.signalWidth - 1), -128);
        valueChangeChunk.max = Math.min(Math.pow(2, netlistData.signalWidth - 1) - 1, 127);
      } else {
        valueChangeChunk.min = 0;
        valueChangeChunk.max = Math.min(Math.pow(2, netlistData.signalWidth) - 1, 255);
      }
    }

    const viewportSpecs = {
      zoomRatio: this.zoomRatio,
      columnTime: this.columnTime,
      columnWidth: this.columnWidth,
      viewerWidth: this.viewerWidth,
    };

    const html = netlistData.renderType.createSvgFromValueChangeChunk(valueChangeChunk, netlistData, viewportSpecs);

    //console.log(element);
    //console.log(html);
    if (html) {
      element.innerHTML = html;
      //element.replaceChildren(...html.childNodes);
    }

    result.html = element;
    return result;
  }

  // This function creates ruler elements for a chunk
  createRulerChunk(chunkStartIndex: number) {
    const timeMarkerInterval = this.rulerNumberSpacing / this.zoomRatio;
    const chunkStartTime     = chunkStartIndex * this.chunkTime;
    const chunkStartPixel    = chunkStartIndex * this.chunkWidth;
    const numberStartpixel   = -1 * (chunkStartPixel % this.rulerNumberSpacing);
    const tickStartpixel     = this.rulerTickSpacing - (chunkStartPixel % this.rulerTickSpacing) - this.rulerNumberSpacing;
    let numValue           = chunkStartTime + (numberStartpixel / this.zoomRatio);
    //let textElements       = '';
    const textElements: HTMLElement[]   = [];

    for (let i = numberStartpixel; i <= this.columnWidth + 64; i+= this.rulerNumberSpacing ) {
      //textElements += `<text x="${i}" y="20">${numValue * this.timeScale}</text>`;
      const textElement = document.createElement('text');
      textElement.setAttribute('x', i.toString());
      textElement.setAttribute('y', '20');
      textElement.textContent = (numValue * this.timeScale).toString();
      textElements.push(textElement);
      numValue += timeMarkerInterval;
    }

    const rulerChunk = document.createElement('div');
    rulerChunk.classList.add('ruler-chunk');

    const rulerSVG = document.createElement('svg');
    rulerSVG.setAttribute('height', '40');
    rulerSVG.setAttribute('width', this.columnWidth.toString());
    rulerSVG.classList.add('ruler-svg');

    const rulerTick = document.createElement('line');
    rulerTick.classList.add('ruler-tick');
    rulerTick.setAttribute('x1', tickStartpixel.toString());
    rulerTick.setAttribute('y1', '32.5');
    rulerTick.setAttribute('x2', this.columnWidth.toString());
    rulerTick.setAttribute('y2', '32.5');

    rulerSVG.appendChild(rulerTick);
    textElements.forEach((element) => rulerSVG.appendChild(element));
    rulerChunk.appendChild(rulerSVG);
    return rulerChunk;
  }

  createTimeMarker(time: number, markerType: number) {
    const fragment = document.createDocumentFragment();
    const x  = (time % this.columnTime) * this.zoomRatio;
    const id = markerType === 0 ? 'main-marker' : 'alt-marker';
    const marker = document.createElement('svg');
    marker.setAttribute('id', id);
    marker.classList.add('time-marker');
    marker.style.left = x + 'px';
    const line = document.createElement('line');
    line.setAttribute('x1', '0');
    line.setAttribute('y1', '0');
    line.setAttribute('x2', '0');
    line.setAttribute('y2', '100%');
    marker.appendChild(line);
    fragment.appendChild(marker);
    return fragment;
  }

  updateWaveformInCache(netlistIdList: NetlistId[]) {
    //console.log(netlistIdList);
    //console.log(netlistData);
    //console.log(this.dataCache);
    netlistIdList.forEach((netlistId) => {
      for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
        //console.log("updating chunk " + i);
        this.dataCache.columns[i].waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, i);
      }
      if (viewerState.markerTime !== null) {
        //console.log("updating marker");
        this.dataCache.valueAtMarker[netlistId] = dataManager.getValueAtTime(netlistId, viewerState.markerTime);
      }
    });
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      this.parseHtmlInChunk(i);
    }
  }

  // Event handler helper functions

  // Experimental asynchronous rendering path
  async renderWaveformsAsync(node: any, chunkIndex: number) {
    this.updatePending       = true;
    const chunkData: any       = [];
    const chunkElements: any[] = [];
    const orderedElements: any[] = [];

    try {

      const sliceSize = this.batchSize;
      // Render each waveform chunk asynchronously
      for (let i = 0; i < viewerState.displayedSignals.length; i+= sliceSize) {
        const slice = viewerState.displayedSignals.slice(i, i + sliceSize);
        if (this.dataCache.columns[chunkIndex].abortFlag) {break;}
        await new Promise<void>(resolve => requestAnimationFrame(() => {
          for (const netlistId of slice) {
            //let signalId = netlistData[netlistId].signalId;
            // Check the abort flag at the start of each iteration
            if (this.dataCache.columns[chunkIndex].abortFlag) {break;}
            // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
              chunkData[netlistId]     = this.renderWaveformChunk(netlistId, chunkIndex);
              chunkElements[netlistId] = chunkData[netlistId].html;
              //if (!this.dataCache.columns[chunkIndex]) {console.log(chunkIndex);}
            }
          resolve();
        }));
      }

      if (!this.dataCache.columns[chunkIndex].abortFlag) {
        this.dataCache.columns[chunkIndex].waveformChunk = chunkData;
      }

      // Update the DOM in the next animation frame
      if (!this.dataCache.columns[chunkIndex].abortFlag) {
        await new Promise<void>(resolve => requestAnimationFrame(() => {
          viewerState.displayedSignals.forEach((netlistId: NetlistId) => {orderedElements.push(chunkElements[netlistId]);});
          const domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + this.chunksInColumn);
          if (domRef && !this.dataCache.columns[chunkIndex].abortFlag) { // Always check if the element still exists
            domRef.replaceChildren(...orderedElements);
            node.classList.remove('rendering-chunk');
          }
          resolve();
        }));
      }

      if (this.dataCache.columns[chunkIndex]) {
        if (this.dataCache.columns[chunkIndex].abortFlag) {
          //console.log('aborting render for chunk ' + chunkIndex);
          //console.log('late deleting chunk  ' + chunkIndex);
          this.dataCache.columns[chunkIndex] = undefined;
        } else {
          this.dataCache.columns[chunkIndex].isSafeToRemove = true;
        }
      }
    } finally {

      this.dataCache.updatesPending -= 1;
      this.handleUpdatePending();
    }
  }

  handleUpdatePending() {
    if (this.dataCache.updatesPending === 0) {
      //console.log('all updates are done, running garbage collection');
      this.updatePending = false;
      this.garbageCollectChunks();
    }
  }

  flagDeleteChunk(chunkIndex: number) {

    if (!this.dataCache.columns[chunkIndex]) {return;}
    this.dataCache.columns[chunkIndex].abortFlag = true;

    if (this.dataCache.updatesPending === 0) {
      this.dataCache.columns[chunkIndex] = undefined;
    }
  }

  garbageCollectChunks() {
    for (let i = 0; i < this.dataCache.startIndex; i++) {
      if (!this.updatePending) {
        this.dataCache.columns[i] = undefined;
      } else {
        //console.log('aborting garbage collection');
        return;
      }
    }
    for (let i = this.dataCache.endIndex; i < this.dataCache.columns.length; i++) {
      if (!this.updatePending) {
        this.dataCache.columns[i] = undefined;
      } else {
        //console.log('aborting garbage collection');
        return;
      }
    }
    if (!this.updatePending) {
      sendWebviewContext();
    }
  }

  uncacheChunks(startIndex: number, endIndex: number) {

    for (let i = this.dataCache.startIndex; i < startIndex; i++) {
      this.flagDeleteChunk(i);
    }
    for (let i = this.dataCache.endIndex - 1; i >= endIndex; i-=1) {
      this.flagDeleteChunk(i);
    }
  }

  updateChunkInCache(chunkIndex: number) {

    const result = {
      rulerChunk:    this.createRulerChunk(chunkIndex),
      waveformChunk: {} as { [key: number]: any },
      marker:        [],
      altMarker:     [],
    };

    viewerState.displayedSignals.forEach((netlistId: NetlistId) => {
      result.waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, chunkIndex);
    });

    return result;
  }

  updateChunkInCacheShallow(chunkIndex: number) {

    if (this.dataCache.columns[chunkIndex]) {
      this.dataCache.columns[chunkIndex].abortFlag = false;
      //console.log('chunk ' + chunkIndex + ' is already in cache');
      return;
    }

    const result = {
      rulerChunk:    this.createRulerChunk(chunkIndex),
      marker:        [],
      altMarker:     [],
      abortFlag:     false,
      isSafeToRemove: false,
      element:       undefined,
    };

    this.dataCache.columns[chunkIndex] = result;
  }

  parseHtmlInChunk(chunkIndex: number) {

    let waveforms: any[] = [];

    const idTag = `${chunkIndex}-${this.chunksInColumn}`;
    const columnIndex = Math.floor(chunkIndex / this.chunksInColumn);
    const columnChunk = document.createElement('div');
    columnChunk.classList.add('column-chunk');
    columnChunk.setAttribute('id', 'column-' + idTag);
    columnChunk.style.width = this.columnWidth + 'px';

    const waveformColumn = document.createElement('div');
    waveformColumn.classList.add('waveform-column');
    waveformColumn.setAttribute('id', 'waveform-column-' + idTag);
    waveformColumn.setAttribute('style', 'font-family:monospaced');

    if (this.dataCache.columns[chunkIndex].waveformChunk !== undefined) {
      waveforms = viewerState.displayedSignals.map((signal) => {return this.dataCache.columns[chunkIndex].waveformChunk[signal].html;});
    } else {
      //shallowChunkClass = " shallow-chunk";
      columnChunk.classList.add('shallow-chunk');
    }

    waveformColumn.replaceChildren(...waveforms);
    columnChunk.appendChild(this.dataCache.columns[chunkIndex].rulerChunk);
    columnChunk.appendChild(waveformColumn);

    if (viewerState.markerTime !== null && this.markerChunkIndex !== null && columnIndex === Math.floor(this.markerChunkIndex / this.chunksInColumn))    {
      columnChunk.appendChild(this.createTimeMarker(viewerState.markerTime, 0));
    }
    if (viewerState.altMarkerTime !== null && this.altMarkerChunkIndex !== null && columnIndex === Math.floor(this.altMarkerChunkIndex / this.chunksInColumn)) {
      columnChunk.appendChild(this.createTimeMarker(viewerState.altMarkerTime, 1));
    }

    columnChunk.innerHTML += "";
    this.dataCache.columns[chunkIndex].element        = columnChunk;
    this.dataCache.columns[chunkIndex].isSafeToRemove = true;
  }

  shallowFetchColumns(startIndex: number, endIndex: number) {

    //console.log('shallow fetching chunks from ' + startIndex + ' to ' + endIndex + '');

    if (startIndex < this.dataCache.startIndex) {
      const upperBound = Math.min(this.dataCache.startIndex, endIndex);
      //console.log('building shallow chunks from ' + startIndex + ' to ' + upperBound + '');
      for (let i = upperBound - this.chunksInColumn; i >= startIndex; i-=this.chunksInColumn) {
        this.updateChunkInCacheShallow(i);
      }
    }
    if (endIndex > this.dataCache.endIndex) {
      const lowerBound = Math.max(this.dataCache.endIndex, startIndex);
      //console.log('building shallow chunks from ' + lowerBound + ' to ' + endIndex + '');
      for (let i = lowerBound; i < endIndex; i+=this.chunksInColumn) {
        this.updateChunkInCacheShallow(i);
      }
    }

    this.dataCache.startIndex = Math.min(startIndex, this.dataCache.startIndex);
    this.dataCache.endIndex   = Math.max(endIndex,   this.dataCache.endIndex);

    //console.log('aborting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
    //console.log('chunk cache start index: ' + this.dataCache.startIndex + ' end index: ' + this.dataCache.endIndex + '');
    //uncacheChunks(startIndex, endIndex);

    const returnData: any = [];

    for (let chunkIndex: number = startIndex; chunkIndex < endIndex; chunkIndex+=this.chunksInColumn) {
      //if (!this.dataCache.columns[chunkIndex]) {console.log('chunk ' + chunkIndex + ' is undefined');}
      if (!this.dataCache.columns[chunkIndex]) {continue;}
      if (!this.dataCache.columns[chunkIndex].element) {
        this.parseHtmlInChunk(chunkIndex);
      }
      returnData.push(this.dataCache.columns[chunkIndex].element);
    }

    return returnData;
  }

  // ----------------------------------------------------------------------------
  // Modified Clusterize code
  // ----------------------------------------------------------------------------
  handleScrollEvent(newScrollLeft: number) {
    const clampedScrollLeft = Math.max(Math.min(newScrollLeft, this.maxScrollLeft), 0);
    this.contentLeft            += this.pseudoScrollLeft - clampedScrollLeft;
    this.contentArea.style.left  = this.contentLeft + 'px';
    this.pseudoScrollLeft        = clampedScrollLeft;
    this.updateScrollBarPosition();
    if (this.scrollEventPending) {return;}

    this.scrollEventPending = true;
    const thisCluster  = this.getBlockNum();
    if (this.currentCluster[0] !== thisCluster[0] || this.currentCluster[1] !== thisCluster[1]) {
      this.updateContentArea(this.leftOffset, thisCluster);
      this.currentCluster = thisCluster;
    }
    this.scrollEventPending = false;
  }

  getChunksWidth() {
    //const debugViewportWidth = 1000;
    //const chunksInCluster  = Math.max(Math.ceil((debugViewportWidth + 1000) / this.chunkWidth), 2);
    const chunksInCluster  = Math.max(Math.ceil((this.viewerWidth + 1000) / this.chunkWidth), 2);
    this.chunksInColumn    = 4 ** (Math.max(0,(Math.floor(Math.log2(chunksInCluster) / 2) - 1)));
    this.columnWidth       = this.chunkWidth * this.chunksInColumn;
    this.columnsInCluster  = Math.max(Math.ceil((this.viewerWidth / this.columnWidth) * 2), 2);
    this.columnTime        = this.chunkTime * this.chunksInColumn;

    //console.log('chunks in cluster: ' + chunksInCluster + '; chunks in column: ' + this.chunksInColumn + '; column width: ' + this.columnWidth + '; blocks in cluster: ' + this.columnsInCluster + '');
  }

  getBlockNum() {
    const blockNum     = (this.pseudoScrollLeft + this.halfViewerWidth) / this.columnWidth;
    const minColumnNum = Math.max(Math.round(blockNum - (this.columnsInCluster / 2)), 0) * this.chunksInColumn;
    const maxColumnNum = Math.min(Math.round(blockNum + (this.columnsInCluster / 2)) * this.chunksInColumn, this.chunkCount);

    return [minColumnNum, maxColumnNum];
  }

  updateContentArea(oldLeftOffset: number, cluster: number[]) {
    const leftHidden = this.chunkWidth * cluster[0];
    if (this.updatePending || leftHidden !== oldLeftOffset) {
      const newColumns            = this.shallowFetchColumns(cluster[0], cluster[1]);
      this.contentLeft            = leftHidden - this.pseudoScrollLeft;
      this.contentArea.style.left = this.contentLeft + 'px';
      this.contentArea.replaceChildren(...newColumns);
      this.leftOffset             = leftHidden;
      this.handleClusterChanged(cluster[0], cluster[1]);
    }
    this.handleUpdatePending();
  }

  handleClusterChanged(startIndex: number, endIndex: number) {
    //console.log('deleting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
    //console.log('chunk cache start index: ' + this.dataCache.startIndex + ' end index: ' + this.dataCache.endIndex + '');
    this.uncacheChunks(startIndex, endIndex);
    this.dataCache.startIndex     = startIndex;
    this.dataCache.endIndex       = endIndex;
  }

  getTimeFromClick(event: MouseEvent) {
    const bounds    = this.contentArea.getBoundingClientRect();
    const pixelLeft = Math.round(event.pageX - bounds.left);
    return Math.round(pixelLeft / this.zoomRatio) + (this.chunkTime * this.dataCache.startIndex);
  }


  isInView(time: number) {
    const pixel      = time * this.zoomRatio;
    const scrollLeft = this.pseudoScrollLeft;

    if (pixel < scrollLeft || pixel > scrollLeft + this.viewerWidth) {return false;}
    else {return true;}
  }

  moveViewToTime(time: number) {
    const moveViewer = !(this.isInView(time));
    if (moveViewer) {
      this.handleScrollEvent((time * this.zoomRatio) - this.halfViewerWidth);
    }
    return moveViewer;
  }

  handleScrollAreaMouseDown(event: MouseEvent) {
    if (event.button === 1) {
      this.handleScrollAreaClick(event, 1);
    } else if (event.button === 0) {
      this.highlightStartEvent = event;
      viewerState.mouseupEventType    = 'markerSet';

      if (!this.highlightListenerSet) {
        this.scrollArea.addEventListener('mousemove', this.drawHighlightZoom, false);
        this.highlightListenerSet = true;
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
    const time     = this.getTimeFromClick(event);
    let snapToTime = time;

    // Get the signal id of the click
    let netlistId: any     = null;
    const waveChunkId = event.target?.closest('.waveform-chunk');
    if (waveChunkId) {netlistId = parseInt(waveChunkId.id.split('--').slice(1).join('--'));}
    if (netlistId !== undefined && netlistId !== null) {

      if (button === 0) {
        this.events.dispatch(ActionType.SignalSelect, netlistId);
      }

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = dataManager.getNearestTransition(netlistId, time);

      if (nearestTransition === null) {return;}

      const nearestTime       = nearestTransition[0];
      const pixelDistance     = Math.abs(nearestTime - time) * this.zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
    }

    this.events.dispatch(ActionType.MarkerSet, snapToTime, button);
  }

  updateScrollbarResize() {
    this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.timeStop * this.zoomRatio)), 17);
    this.maxScrollbarPosition  = Math.max(this.viewerWidth - this.scrollbarWidth, 0);
    this.updateScrollBarPosition();
    this.scrollbar.style.width = this.scrollbarWidth + 'px';
    this.updateScrollContainer();
  }
  
  updateScrollBarPosition() {
    this.scrollbarHidden         = this.maxScrollLeft === 0;
    this.scrollbarPosition       = Math.round((this.pseudoScrollLeft / this.maxScrollLeft) * this.maxScrollbarPosition);
    this.scrollbar.style.display = this.scrollbarHidden ? 'none' : 'block';
    this.scrollbar.style.left    = this.scrollbarPosition + 'px';
  }

  handleScrollbarContainerClick(e: MouseEvent) {
    e.preventDefault();
    if (this.scrollbarHidden) {return;}
    const scrollbarBounds = this.scrollbarContainer.getBoundingClientRect();
    const scrollbarX      = e.clientX - scrollbarBounds.left;
    const newPosition     = Math.min(Math.max(0, scrollbarX - (this.scrollbarWidth / 2)), this.maxScrollbarPosition);
    const newScrollLeft   = Math.round((newPosition / this.maxScrollbarPosition) * this.maxScrollLeft);
    this.handleScrollEvent(newScrollLeft);

    // roll this event into the scrollbar drag event
    this.handleScrollbarDrag(e);
  }

  handleScrollbarDrag(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarMoved = false;
    this.scrollbarStartX = event.clientX;
    this.scrollbar.classList.add('is-dragging');

    document.addEventListener('mousemove', this.handleScrollbarMove, false);
    viewerState.mouseupEventType = 'scroll';
  }

  highlightZoom() {
    const timeStart = this.getTimeFromClick(this.highlightStartEvent);
    const timeEnd   = this.getTimeFromClick(this.highlightEndEvent);
    const time      = Math.round((timeStart + timeEnd) / 2);
    const width     = Math.abs(this.highlightStartEvent.pageX - this.highlightEndEvent.pageX);
    const amount    = Math.ceil(Math.log2(width / this.viewerWidth));

    if (this.highlightElement) {
      this.highlightElement.remove();
      this.highlightElement = null;
    }

    this.events.dispatch(ActionType.Zoom, amount, time, this.halfViewerWidth);
  }

  drawHighlightZoom(event: MouseEvent) {

    this.highlightEndEvent = event;
    const width       = Math.abs(this.highlightEndEvent.pageX - this.highlightStartEvent.pageX);
    const left        = Math.min(this.highlightStartEvent.pageX, this.highlightEndEvent.pageX);
    const elementLeft = left - this.scrollArea.getBoundingClientRect().left;
    const style       = `left: ${elementLeft}px; width: ${width}px; height: ${this.contentArea.clientHeight};`;
  
    if (width > 5) {viewerState.mouseupEventType = 'highlightZoom';}
  
    if (!this.highlightElement) {
      this.highlightElement = domParser.parseFromString(`<div id="highlight-zoom" style="${style}"></div>`, 'text/html').body.firstChild;
      //this.highlightElement = document.createElement('div');
      //this.highlightElement.setAttribute('id', 'highlight-zoom');
      //this.highlightElement.style.width = width + 'px';
      //this.highlightElement.style.left  = elementLeft + 'px';

      this.scrollArea.appendChild(this.highlightElement);

    } else {
      this.highlightElement.style.width = width + 'px';
      this.highlightElement.style.left  = elementLeft + 'px';
    }
  
    if (!this.highlightDebounce) {
      this.highlightDebounce = setTimeout(() => {
        viewerState.mouseupEventType  = 'highlightZoom';
      }, 300);
    }
  }

  handleScrollbarMove(e: MouseEvent) {
    if (!this.scrollbarMoved) {
      this.scrollbarMoved = e.clientX !== this.scrollbarStartX;
      if (!this.scrollbarMoved) {return;}
    }
    const newPosition   = Math.min(Math.max(0, e.clientX - this.scrollbarStartX + this.scrollbarPosition), this.maxScrollbarPosition);
    this.scrollbarStartX = e.clientX;
    const newScrollLeft = Math.round((newPosition / this.maxScrollbarPosition) * this.maxScrollLeft);
    this.handleScrollEvent(newScrollLeft);
  }

  handleReorderSignals(oldIndex: number, newIndex: number) {
    this.updatePending = true;
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      const waveformColumn = document.getElementById('waveform-column-' + i + '-' + this.chunksInColumn);
      if (!waveformColumn) {continue;}
      const children       = Array.from(waveformColumn.children);
      arrayMove(children, oldIndex, newIndex);
      waveformColumn.replaceChildren(...children);
    }
    this.updateContentArea(this.leftOffset, this.getBlockNum());
  }

  handleRemoveVariable(netlistId: NetlistId) {

    this.updatePending    = true;
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      const waveformColumn = document.getElementById('waveform-column-' + i + '-' + this.chunksInColumn);
      if (!waveformColumn) {continue;}
      const children       = Array.from(waveformColumn.children).filter((element) => {
        return element.id !== `idx${i}-${this.chunksInColumn}--${netlistId}`;
      });
      waveformColumn.replaceChildren(...children);
    }
    this.updateContentArea(this.leftOffset, this.getBlockNum());
    //this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.timeStop) {return;}

    const oldMarkerTime = markerType === 0 ? viewerState.markerTime           : viewerState.altMarkerTime;
    let   chunkIndex    = markerType === 0 ? this.markerChunkIndex   : this.altMarkerChunkIndex;
    const id            = markerType === 0 ? 'main-marker'      : 'alt-marker';
    let viewerMoved     = false;

    // dispose of old marker
    if (oldMarkerTime !== null) {
      if (chunkIndex !== null && chunkIndex >= this.dataCache.startIndex && chunkIndex < this.dataCache.endIndex + this.chunksInColumn) {
        const timeMarker = document.getElementById(id);
        if (timeMarker) {timeMarker.remove();}
      }
    }

    if (time === null) {
      if (markerType === 0) {
        viewerState.markerTime = null;
        this.markerChunkIndex  = null;
      } else {
        viewerState.altMarkerTime = null;
        this.altMarkerChunkIndex  = null;
      }
      return;
    }

    // first find the chunk with the marker
    chunkIndex   = Math.floor(time / this.chunkTime);

    // create new marker
    if (chunkIndex >= this.dataCache.startIndex && chunkIndex < this.dataCache.endIndex + this.chunksInColumn) {
      const clusterIndex = Math.floor((chunkIndex - this.dataCache.startIndex) / this.chunksInColumn);
      const chunkElement = this.contentArea.getElementsByClassName('column-chunk')[clusterIndex];
      
      if (chunkElement) {
        const marker = this.createTimeMarker(time, markerType);
        chunkElement.appendChild(marker);
        chunkElement.innerHTML += '';
      }
      //console.log('adding marker at time ' + time + ' from chunk ' + chunkIndex + '');
    } else {
      //console.log('chunk index ' + chunkIndex + ' is not in cache');
    }

    if (markerType === 0) {
      viewerState.markerTime = time;
      this.markerChunkIndex  = chunkIndex;

      viewerMoved = this.moveViewToTime(time);

    } else {
      viewerState.altMarkerTime = time;
      this.altMarkerChunkIndex  = chunkIndex;
    }

    this.updateScrollContainer();
  }

  updateScrollContainer() {
    this.scrollbarCanvas.clearRect(0, 0, this.scrollbarCanvas.canvas.width, this.scrollbarCanvas.canvas.height);
    this.annotateScrollContainer(this.markerAnnotation , viewerState.markerTime);
    this.annotateScrollContainer(this.markerAnnotation , viewerState.altMarkerTime);
  }

  annotateScrollContainer(color, time) {

    if (time === null) {return;}
    const xOffset = (time / this.timeStop) * this.scrollbarCanvas.canvas.width;
    this.scrollbarCanvas.lineWidth   = 1.5;
    this.scrollbarCanvas.strokeStyle = color;
    this.scrollbarCanvas.beginPath();
    this.scrollbarCanvas.moveTo(xOffset, 0);
    this.scrollbarCanvas.lineTo(xOffset, this.scrollbarCanvas.canvas.height);
    this.scrollbarCanvas.stroke();
  }

  handleSignalSelect(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}
  
    let element;
    let index;
  
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      element = document.getElementById('idx' + i + '-' + this.chunksInColumn + '--' + viewerState.selectedSignal);
      if (element && viewerState.selectedSignal !== null) {
        element.classList.remove('is-selected');
        this.dataCache.columns[i].waveformChunk[viewerState.selectedSignal].html = element;
      }
  
      element = document.getElementById('idx' + i + '-' + this.chunksInColumn + '--' + netlistId);
      if (element) {
        element.classList.add('is-selected');
        this.dataCache.columns[i].waveformChunk[netlistId].html = element;
      }
    }
  }

  // Event handler helper functions
  handleZoom(amount: number, zoomOrigin: number, screenPosition: number) {
    // -1 zooms in, +1 zooms out
    // zoomRatio is in pixels per time unit
    if (this.updatePending) {return;}
    if (amount === 0) {return;}

    let newZoomRatio  = this.zoomRatio * Math.pow(2, (-1 * amount));
    //this.touchpadScrollCount = 0;
    
    if (newZoomRatio > this.maxZoomRatio) {
      newZoomRatio = this.maxZoomRatio;

      if (newZoomRatio === this.zoomRatio) {
        console.log('zoom ratio is too high: ' + newZoomRatio + '');
        return;
      }
    }

    //console.log('zooming to ' + newZoomRatio + ' from ' + this.zoomRatio + '');

    this.updatePending    = true;
    this.zoomRatio        = newZoomRatio;
    this.chunkWidth       = this.chunkTime * this.zoomRatio;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    this.pseudoScrollLeft = Math.max(Math.min((zoomOrigin * this.zoomRatio) - screenPosition, this.maxScrollLeft), 0);
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      this.dataCache.columns[i] = undefined;
    }
    this.getChunksWidth();

    const startIndex  = Math.ceil(this.dataCache.startIndex / this.chunksInColumn) * this.chunksInColumn;
    const endIndex    = Math.floor(this.dataCache.endIndex / this.chunksInColumn) * this.chunksInColumn;
    this.dataCache.startIndex = startIndex;
    this.dataCache.endIndex   = endIndex;

    for (let i = startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      this.dataCache.columns[i] = (this.updateChunkInCache(i));
    }

    this.updateContentArea(this.leftOffset, this.getBlockNum());
    this.updateScrollbarResize();
  }

  handleAddVariable(netlistIdList: NetlistId[], updateFlag: boolean) {
    this.updateWaveformInCache(netlistIdList);

    if (updateFlag) {
      this.updatePending  = true;
      //this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";
      this.updateContentArea(this.leftOffset, this.getBlockNum());
    }
  }

  handleRedrawSignal(netlistId: NetlistId) {
    //console.log('redrawing signal ' + netlistId + '');
    this.updatePending = true;
    this.updateWaveformInCache([netlistId]);
    this.updateContentArea(this.leftOffset, this.getBlockNum());
  }

  updateViewportWidth() {
    this.scrollbarCanvasElement.setAttribute("width",  `0`);
    this.viewerWidth     = this.scrollArea.getBoundingClientRect().width;
    this.halfViewerWidth = this.viewerWidth / 2;
    this.maxScrollLeft   = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    this.scrollbarCanvasElement.setAttribute("width",  `${this.viewerWidth}`);
    //this.maxScrollLeft   = Math.round(Math.max((this.chunkCount * chunkWidth) - this.viewerWidth, 0));
    this.updateScrollbarResize();
    this.getChunksWidth();
    this.handleScrollEvent(this.pseudoScrollLeft);
  }
}
