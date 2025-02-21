import { vscode, NetlistData,  WaveformData, arrayMove, sendWebviewContext, NetlistId, SignalId, ValueChange, ActionType, EventHandler, viewerState, dataManager } from "./vaporview";
import { ValueFormat } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer } from './renderer';

const domParser = new DOMParser();

export class Viewport {

  scrollArea: HTMLElement;
  contentArea: HTMLElement;
  waveformArea: HTMLElement;
  scrollbar: HTMLElement;
  scrollbarContainer: HTMLElement;
  scrollbarCanvasElement: HTMLElement;
  scrollbarCanvas: CanvasRenderingContext2D;
  rulerCanvasElement: HTMLElement;
  rulerCanvas: CanvasRenderingContext2D;
  markerElement: HTMLElement;
  altMarkerElement: HTMLElement;

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

  timeScrollLeft: number      = 0;
  viewerWidthTime: number     = 0;
  timeScrollRight: number     = 0;

  touchpadScrollCount: number = 0;
  scrollbarMoved: boolean     = false;
  scrollbarStartX: number     = 0;

  // Zoom level variables
  timeScale: number           = 1;
  zoomRatio: number           = 1;
  pixelTime: number           = 1;
  maxZoomRatio: number        = 64;
  timeStop: number            = 0;
  pixelRatio: number          = 1;

  // Clusterize variables
  updatePending: boolean      = false;
  scrollEventPending: boolean = false;

  // Marker variables
  markerAnnotation: string           = '';
  valueAtMarker: any                  = {};

  constructor(
    private events: EventHandler,
  ) {
    const scrollArea         = document.getElementById('scrollArea');
    const contentArea        = document.getElementById('contentArea');
    const waveformArea       = document.getElementById('waveformArea');
    const scrollbar          = document.getElementById('scrollbar');
    const scrollbarContainer = document.getElementById('scrollbarContainer');
    const scrollbarCanvas    = document.getElementById('scrollbarAreaCanvas');
    const rulerCanvas        = document.getElementById('rulerCanvas');
    const markerElement      = document.getElementById('main-marker');
    const altMarkerElement   = document.getElementById('alt-marker');

    if (scrollArea === null || contentArea === null || scrollbar === null || 
      scrollbarContainer === null || scrollbarCanvas === null || 
      waveformArea === null || rulerCanvas === null || markerElement === null ||
      altMarkerElement === null) {
      throw new Error('Viewport elements not found');
    }

    const canvasContext = (scrollbarCanvas as HTMLCanvasElement).getContext('2d');
    const rulerCanvasCtx = (rulerCanvas as HTMLCanvasElement).getContext('2d');

    if (canvasContext === null || rulerCanvasCtx === null) {
      throw new Error('Canvas context not found');
    }

    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.waveformArea = waveformArea;
    this.scrollbar = scrollbar;
    this.markerElement = markerElement;
    this.altMarkerElement = altMarkerElement;
    this.scrollbarContainer = scrollbarContainer;
    this.scrollbarCanvasElement = scrollbarCanvas;
    this.scrollbarCanvas = canvasContext;
    this.rulerCanvasElement = rulerCanvas;
    this.rulerCanvas = rulerCanvasCtx;

    // I calculated this as 174, 176, 173 @ 10% opacity in the default theme, but there was no CSS color that matched
    this.markerAnnotation = document.documentElement.style.getPropertyValue('--vscode-editorOverviewRuler-selectionHighlightForeground');

    // click handler to handle clicking inside the waveform viewer
    // gets the absolute x position of the click relative to the scrollable content
    contentArea.addEventListener('mousedown',        (e) => {this.handleScrollAreaMouseDown(e);});
    scrollbar.addEventListener('mousedown',          (e) => {this.handleScrollbarDrag(e);});
    scrollbarContainer.addEventListener('mousedown', (e) => {this.handleScrollbarContainerClick(e);});

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
    this.pixelRatio    = window.devicePixelRatio || 1;
    document.title     = metadata.filename;
    this.zoomRatio     = metadata.defaultZoom;
    this.pixelTime     = 1 / this.zoomRatio;
    this.timeScale     = metadata.timeScale;
    this.timeStop      = metadata.timeEnd;
    this.maxZoomRatio  = this.zoomRatio * 64;
    this.valueAtMarker = {};
    this.updatePending = true;
    this.updateViewportWidth();
    this.updateRuler();
    this.updatePending = false;
    this.scrollbarCanvasElement.setAttribute("width",  `${this.viewerWidth}`);
    this.scrollbarCanvasElement.setAttribute("height", `${this.scrollbarContainer.clientHeight}`);
  }

  handleAddVariable(netlistIdList: NetlistId[], updateFlag: boolean) {
    netlistIdList.forEach((netlistId) => {
      if (!dataManager.netlistData[netlistId]) {return;}
      const netlistData = dataManager.netlistData[netlistId];
      // create a canvas element and add it to the scroll area
      const canvas = document.createElement('canvas');
      canvas.setAttribute('id', 'waveform-canvas-' + netlistId);
      canvas.classList.add('waveform-canvas');
      canvas.setAttribute('width', `${this.viewerWidth}`);
      canvas.setAttribute('height', '20');
      const waveformContainer = document.createElement('div');
      waveformContainer.setAttribute('id', 'waveform-' + netlistId);
      waveformContainer.classList.add('waveform-container');
      waveformContainer.appendChild(canvas);
      waveformContainer.setAttribute("data-vscode-context", netlistData.vscodeContext);
      this.waveformArea.appendChild(waveformContainer);
      netlistData.canvas = canvas;
    });
  }

  getTimeFromClick(event: MouseEvent) {
    const bounds    = this.scrollArea.getBoundingClientRect();
    const pixelLeft = Math.round(event.pageX - bounds.left);
    //return Math.round(pixelLeft * this.pixelTime) + (this.chunkTime * this.dataCache.startIndex);
    return Math.round((pixelLeft + this.pseudoScrollLeft) * this.pixelTime);
  }

  getViewportLeft(time: number, clamp: number) {
    const x = (time * this.zoomRatio) - this.pseudoScrollLeft;
    return Math.max(Math.min(x, this.viewerWidth + clamp), -clamp);
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
    const containerId = event.target?.closest('.waveform-container');
    if (containerId) {netlistId = parseInt(containerId.id.split('-').slice(1));}
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

  updateRuler() {
    let tickX = 10 - (this.pseudoScrollLeft % this.rulerTickSpacing) - 10.5;
    let numberX = -1 * (this.pseudoScrollLeft % this.rulerNumberSpacing);
    let numberIncrement = this.rulerNumberSpacing * this.pixelTime;
    let number = (this.pseudoScrollLeft + numberX) * this.pixelTime;
    const ctx = this.rulerCanvas;
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'grey';
    ctx.font = '12px Menlo';
    ctx.fillStyle = 'grey';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.clearRect(0, 0, this.viewerWidth, 40);

    ctx.beginPath();
    // Draw the Ticks
    while (tickX <= this.viewerWidth) {
      ctx.moveTo(tickX, 27.5);
      ctx.lineTo(tickX, 32.5);
      tickX += this.rulerTickSpacing;
    }
    ctx.stroke();

    // Draw the Numbers
    while (numberX <= this.viewerWidth) {
      ctx.fillText((number * this.timeScale).toString(), numberX, 20);
      numberX += this.rulerNumberSpacing;
      number += numberIncrement;
    }
  }

  updateMarker() {
    if (this.markerElement && viewerState.markerTime !== null) {
      this.markerElement.style.left = this.getViewportLeft(viewerState.markerTime, 10) + 'px';
    }
    if (this.altMarkerElement && viewerState.altMarkerTime !== null) {
      this.altMarkerElement.style.left = this.getViewportLeft(viewerState.altMarkerTime, 10) + 'px';
    }
  }

  renderAllWaveforms() {
    dataManager.netlistData.forEach((netlistItem) => {
      this.renderWaveform(netlistItem);
    });
  }

  renderWaveform(netlistData: NetlistData) {

    const signalId = netlistData.signalId;
    const data     = dataManager.valueChangeData[signalId];

    if (!data) {return;}

    // find the closest timestampt to timeScrollLeft
    const startIndex   = Math.max(dataManager.binarySearch(data.transitionData, this.timeScrollLeft - (2 * this.pixelTime)), 1);
    const endIndex     = Math.min(dataManager.binarySearch(data.transitionData, this.timeScrollRight) + 1, data.transitionData.length - 1);
    const initialState = data.transitionData[startIndex - 1];
    const postState    = data.transitionData[endIndex];

    const valueChangeChunk = {
      valueChanges: data.transitionData.slice(startIndex, endIndex),
      initialState: initialState,
      postState: postState,
      encoding: netlistData.encoding,
      signalWidth: netlistData.signalWidth,
      min: data.min,
      max: data.max,
    };
    //console.log(valueChangeChunk);
  
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

    netlistData.renderType.draw(valueChangeChunk, netlistData, this);
  }

  handleReorderSignals(oldIndex: number, newIndex: number) {
    const children       = Array.from(this.waveformArea.children);
    arrayMove(children, oldIndex, newIndex);
    this.waveformArea.replaceChildren(...children);
  }

  handleRemoveVariable(netlistId: NetlistId) {

    const children = Array.from(this.waveformArea.children).filter((element) => {
      return element.id !== `waveform-${netlistId}`;
    });
    this.waveformArea.replaceChildren(...children);
    const netlistElement = dataManager.netlistData[netlistId];
    if (!netlistElement) {return;}
    if (netlistElement.canvas) {netlistElement.canvas.remove();}
  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.timeStop) {return;}

    let element = markerType === 0 ? this.markerElement : this.altMarkerElement;

    if (time === null) {
      element.style.display = 'none';
      return;
    }

    if (markerType === 0) {
      viewerState.markerTime = time;
      this.moveViewToTime(time);
    } else {
      viewerState.altMarkerTime = time;
    }

    this.updateMarker();
    this.updateScrollContainer();
    element.style.display = 'block';
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
    console.log('selected signal: ' + netlistId + '');

    let element = document.getElementById('waveform-' + viewerState.selectedSignal);
    if (element && viewerState.selectedSignal !== null) {element.classList.remove('is-selected');}
    element = document.getElementById('waveform-' + netlistId);
    if (element) {element.classList.add('is-selected');}
    //console.log(element);
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
    this.pixelTime        = 1 / this.zoomRatio;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    this.pseudoScrollLeft = Math.max(Math.min((zoomOrigin * this.zoomRatio) - screenPosition, this.maxScrollLeft), 0);
    this.timeScrollLeft   = this.pseudoScrollLeft * this.pixelTime;
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.timeScrollRight  = this.timeScrollLeft + this.viewerWidthTime;

    this.updateRuler();
    this.renderAllWaveforms();
    this.updateMarker();
    this.updateScrollbarResize();
    this.updatePending = false;
  }

  handleRedrawSignal(netlistId: NetlistId) {
    //console.log('redrawing signal ' + netlistId + '');
    if (viewerState.markerTime !== null) {
      this.valueAtMarker[netlistId] = dataManager.getValueAtTime(netlistId, viewerState.markerTime);
    }
    this.renderWaveform(dataManager.netlistData[netlistId]);
  }

  updateViewportWidth() {
    this.pixelRatio   = window.devicePixelRatio || 1;
    this.scrollbarCanvasElement.setAttribute("width",  `0`);
    this.viewerWidth     = this.scrollArea.getBoundingClientRect().width;
    this.halfViewerWidth = this.viewerWidth / 2;
    this.maxScrollLeft   = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.scrollbarCanvasElement.setAttribute("width",  `${this.viewerWidth}`);
    //this.maxScrollLeft   = Math.round(Math.max((this.chunkCount * chunkWidth) - this.viewerWidth, 0));

    // Update Ruler Canvas Dimensions
    this.rulerCanvasElement.setAttribute("width",  `${this.viewerWidth * this.pixelRatio}`);
    this.rulerCanvasElement.setAttribute("height", `${40 * this.pixelRatio}`);
    this.rulerCanvasElement.style.width  = `${this.viewerWidth}px`;
    this.rulerCanvasElement.style.height = '40px';
    this.rulerCanvas.scale(this.pixelRatio, this.pixelRatio);

    // Update Waveform Canvas Dimensions
    dataManager.netlistData.forEach((netlistItem) => {
      if (!netlistItem.canvas) {return;}
      netlistItem.canvas.setAttribute('width', `${this.viewerWidth}`);
    });

    this.updateScrollbarResize();
    this.handleScrollEvent(this.pseudoScrollLeft);
  }

  handleScrollEvent(newScrollLeft: number) {
    const clampedScrollLeft = Math.max(Math.min(newScrollLeft, this.maxScrollLeft), 0);
    this.pseudoScrollLeft   = clampedScrollLeft;
    this.timeScrollLeft     = this.pseudoScrollLeft * this.pixelTime;
    this.timeScrollRight    = this.timeScrollLeft + this.viewerWidthTime;
    this.updateScrollBarPosition();

    if (this.scrollEventPending) {return;}
    this.scrollEventPending = true;

    this.updateMarker();
    this.updateRuler();
    this.renderAllWaveforms();

    this.updatePending = false;
    this.scrollEventPending = false;
  }
}