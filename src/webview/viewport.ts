import { vscode, WaveformData, arrayMove, sendWebviewContext, NetlistId, SignalId, ValueChange, ActionType, EventHandler, viewerState, dataManager, restoreState, RowId, updateDisplayedSignalsFlat } from "./vaporview";
import { ValueFormat } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer } from './renderer';
import { labelsPanel } from "./vaporview";
import { VariableItem } from "./signal_item";

const domParser = new DOMParser();

export class Viewport {

  scrollArea: HTMLElement;
  scrollAreaBounds: DOMRect;
  contentArea: HTMLElement;
  waveformArea: HTMLElement;
  scrollbar: HTMLElement;
  scrollbarContainer: HTMLElement;
  scrollbarCanvasElement: HTMLElement;
  scrollbarCanvas: CanvasRenderingContext2D;
  rulerElement: HTMLElement;
  rulerCanvasElement: HTMLElement;
  rulerCanvas: CanvasRenderingContext2D;
  backgroundCanvasElement: HTMLElement;
  backgroundCanvas: CanvasRenderingContext2D;
  markerElement: HTMLElement;
  altMarkerElement: HTMLElement;
  netlistLinkElement: HTMLElement | null = null;
  valueLinkObject: VariableItem | null = null;

  highlightElement: any     = null;
  highlightEndEvent: any    = null;
  highlightStartEvent: any  = null;
  highlightListenerSet      = false;
  highlightDebounce: any    = null;

  // Scroll handler variables
  pseudoScrollLeft: number    = 0;
  viewerWidth: number         = 0;
  viewerHeight: number        = 0;
  waveformsHeight: number     = 40;
  halfViewerWidth: number     = 0;
  maxScrollLeft: number       = 0;
  maxScrollbarPosition: number = 0;
  scrollbarWidth: number      = 17;
  scrollbarPosition: number   = 0;
  scrollbarHidden: boolean    = true;
  timeScrollLeft: number      = 0;
  viewerWidthTime: number     = 0;
  timeScrollRight: number     = 0;
  timeScale: number           = 1;
  adjustedLogTimeScale: number= 0;
  timeUnit: string            = 'ns';
  displayTimeUnit: string     = 'ns';
  timeStop: number            = 0;
  timeTableCount: number      = 0;

  scrollbarMoved: boolean     = false;
  scrollbarStartX: number     = 0;

  // Zoom level variables
  zoomRatio: number           = 1;
  defaultZoom: number         = 1;
  zoomOffset: number          = 0;
  pixelTime: number           = 1;
  maxZoomRatio: number        = 64;
  minZoomRatio: number        = 1 / 64;
  minDrawWidth: number        = 1;
  rulerNumberSpacing: number  = 100;
  rulerTickSpacing: number    = 10;
  rulerNumberIncrement: number = 100;
  minNumberSpacing: number   = 100;
  minTickSpacing: number     = 20;
  rulerLines: boolean        = true;
  rulerLineX: [number, number][] = [];
  annotateTime: number[]     = [];

  pixelRatio: number          = 1;
  updatePending: boolean      = false;
  scrollEventPending: boolean = false;

  // CSS Properties
  colorKey: string[]          = ['green', 'orange', 'blue', 'purple'];
  xzColor: string             = 'red';
  rulerTextColor: string      = 'grey';
  rulerGuideColor: string     = 'grey';
  edgeGuideColor: string      = 'orange';
  markerAnnotation: string    = '';
  backgroundColor: string     = 'black';
  fontFamily: string          = 'Menlo';
  fontSize: string            = '12px';
  fontStyle: string           = '12px Menlo';
  characterWidth: number      = 7.69;

  constructor(
    private events: EventHandler,
  ) {
    const scrollArea         = document.getElementById('scrollArea');
    const contentArea        = document.getElementById('contentArea');
    const waveformArea       = document.getElementById('waveformArea');
    const scrollbar          = document.getElementById('scrollbar');
    const scrollbarContainer = document.getElementById('scrollbarContainer');
    const scrollbarCanvas    = document.getElementById('scrollbarAreaCanvas');
    const rulerElement       = document.getElementById('ruler');
    const rulerCanvas        = document.getElementById('rulerCanvas');
    const markerElement      = document.getElementById('main-marker');
    const altMarkerElement   = document.getElementById('alt-marker');
    const backgroundCanvas   = document.getElementById('viewport-background');

    if (scrollArea === null || contentArea === null || scrollbar === null || 
      scrollbarContainer === null || scrollbarCanvas === null || 
      waveformArea === null || rulerElement === null || rulerCanvas === null ||
      markerElement === null || altMarkerElement === null || backgroundCanvas === null) {
      throw new Error('Viewport elements not found');
    }

    const canvasContext = (scrollbarCanvas as HTMLCanvasElement).getContext('2d');
    const rulerCanvasCtx = (rulerCanvas as HTMLCanvasElement).getContext('2d');
    const backgroundCanvasCtx = (backgroundCanvas as HTMLCanvasElement).getContext('2d');

    if (canvasContext === null || rulerCanvasCtx === null || backgroundCanvasCtx === null) {
      throw new Error('Canvas context not found');
    }

    this.scrollArea             = scrollArea;
    this.contentArea            = contentArea;
    this.waveformArea           = waveformArea;
    this.scrollbar              = scrollbar;
    this.markerElement          = markerElement;
    this.altMarkerElement       = altMarkerElement;
    this.scrollbarContainer     = scrollbarContainer;
    this.scrollbarCanvasElement = scrollbarCanvas;
    this.scrollbarCanvas        = canvasContext;
    this.rulerElement           = rulerElement;
    this.rulerCanvasElement     = rulerCanvas;
    this.rulerCanvas            = rulerCanvasCtx;
    this.backgroundCanvasElement = backgroundCanvas;
    this.backgroundCanvas       = backgroundCanvasCtx;


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
    //this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.handleReorderSignalsHierarchy = this.handleReorderSignalsHierarchy.bind(this);
    this.highlightZoom = this.highlightZoom.bind(this);
    this.drawHighlightZoom = this.drawHighlightZoom.bind(this);
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleAddVariable = this.handleAddVariable.bind(this);
    this.handleRedrawSignal = this.handleRedrawSignal.bind(this);
    this.handleColorChange = this.handleColorChange.bind(this);

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.Zoom, this.handleZoom);
    //this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignalsHierarchy);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawSignal);
    this.events.subscribe(ActionType.Resize, this.updateViewportWidth);
    this.events.subscribe(ActionType.updateColorTheme, this.handleColorChange);
  }

  init(metadata: any, uri: string) {
    document.title     = metadata.filename;
    document.body.setAttribute("data-vscode-context", JSON.stringify({
      preventDefaultContextMenuItems: true,
      webviewSelection: true,
      uri: uri,
    }));
    viewerState.uri     = uri;
    this.pixelRatio     = window.devicePixelRatio || 1;
    this.defaultZoom    = metadata.defaultZoom;
    this.zoomRatio      = metadata.defaultZoom;
    this.pixelTime      = 1 / this.zoomRatio;
    this.timeScale      = metadata.timeScale;
    this.timeUnit       = metadata.timeUnit;
    this.adjustedLogTimeScale = 0;
    this.displayTimeUnit   = metadata.timeUnit;
    this.timeStop          = metadata.timeEnd;
    this.timeTableCount    = metadata.timeTableCount;
    this.maxZoomRatio      = this.zoomRatio * 64;
    this.waveformArea.innerHTML = '';
    this.updateUnits(this.timeUnit, false);
    this.setRulerVscodeContext();
    this.addNetlistLink();
    this.getThemeColors();
    this.updateViewportWidth();
    this.updateScrollbarResize();
    this.handleZoom(1, 0, 0);
    restoreState();
    //this.updateRuler();
    //this.updatePending = false;
  }

  async getThemeColors() {
    let style = window.getComputedStyle(document.body)
    // Token colors
    this.colorKey[0] = style.getPropertyValue('--vscode-debugTokenExpression-number');
    this.colorKey[1] = style.getPropertyValue('--vscode-debugTokenExpression-string');
    this.colorKey[2] = style.getPropertyValue('--vscode-debugView-valueChangedHighlight');
    this.colorKey[3] = style.getPropertyValue('--vscode-debugTokenExpression-name');

    // Non-2-State Signal Color
    this.xzColor = style.getPropertyValue('--vscode-debugTokenExpression-error');

    // Ruler Color
    this.rulerTextColor = style.getPropertyValue('--vscode-editorLineNumber-foreground');
    this.rulerGuideColor = style.getPropertyValue('--vscode-editorIndentGuide-background');
    this.edgeGuideColor = style.getPropertyValue('--vscode-terminal-findMatchBackground');


    // I calculated this as 174, 176, 173 @ 10% opacity in the default theme, but there was no CSS color that matched
    this.markerAnnotation = document.documentElement.style.getPropertyValue('--vscode-editorOverviewRuler-selectionHighlightForeground');

    // Background Color
    this.backgroundColor = style.getPropertyValue('--vscode-editor-background');

    // Font
    this.fontSize = style.getPropertyValue('--vscode-editor-font-size');
    this.fontFamily = style.getPropertyValue('--vscode-editor-font-family');
    this.fontStyle = this.fontSize + ' ' + this.fontFamily;

    // Look through all of the fonts in the fontFamily to see which font was used
    const fontList = this.fontFamily.split(',').map((font) => font.trim());
    let usedFont = '';
    for (let i = 0; i < fontList.length; i++) {
      let font = fontList[i];
      if (document.fonts.check('12px ' + font)) {
        usedFont = fontList[i];
        break;
      }
    }

    // Somebody help me with this, because I don't have all of these fonts
    switch (usedFont) {
      case 'Monaco':          this.characterWidth = 7.20; break;
      case 'Menlo':           this.characterWidth = 7.22; break;
      case 'Consolas':        this.characterWidth = 7.69; break;
      case 'Droid Sans Mono': this.characterWidth = 7.69; break;
      case 'Inconsolata':     this.characterWidth = 7.69; break;
      case 'Courier New':     this.characterWidth = 7.69; break;
      default:                this.characterWidth = 7.69; break;
    }
  }

  async handleColorChange() {
    this.getThemeColors();
    this.redrawViewport();
  }

  setRulerLines(state: boolean) {
    if (this.rulerLines === state) {return;}
    this.rulerLines = state;
    this.setRulerVscodeContext();
    this.updateBackgroundCanvas();
  }

  setRulerVscodeContext() {
    const unitsList = ['fs', 'ps', 'ns', 'µs', 'ms', 's'];
    const maxTime   = (10 ** this.logScaleFromUnits(this.timeUnit)) * this.timeScale * this.timeStop;
    const context   = {
      webviewSection: 'ruler',
      preventDefaultContextMenuItems: true,
      rulerLines: this.rulerLines 
    };

    unitsList.forEach((unit) => {
      context[unit] = maxTime >= (10 ** this.logScaleFromUnits(unit));
    });

    this.rulerElement.setAttribute("data-vscode-context", `${JSON.stringify(context).replace(/\s/g, '%x20')}`);
  }

  public resizeCanvas(canvasElement: HTMLElement, ctx: CanvasRenderingContext2D, width: number, height: number) {
    canvasElement.setAttribute("width",  `${width * this.pixelRatio}`);
    canvasElement.setAttribute("height", `${height * this.pixelRatio}`);
    canvasElement.style.width  = `${width}px`;
    canvasElement.style.height = `${height}px`;
    ctx.scale(this.pixelRatio, this.pixelRatio);
  }

  handleAddVariable(rowIdList: RowId[], updateFlag: boolean) {
    rowIdList.forEach((rowId) => {
      if (!dataManager.rowItems[rowId]) {return;}
      this.removeNetlistLink();
      const netlistData = dataManager.rowItems[rowId];
      netlistData.createViewportElement(rowId);
      if (netlistData.viewportElement === null) {return;}
      this.waveformArea.appendChild(netlistData.viewportElement);
      if (updateFlag) {netlistData.renderWaveform();}
    });
    this.waveformsHeight = this.contentArea.getBoundingClientRect().height;
    this.updateBackgroundCanvas();
  }

  addNetlistLink() {
    this.waveformArea.innerHTML = `
    <div class="waveform-container" id="netlist-link">
      <p>Add signals from the </p><p id="netlist-link-text"><u>Netlist View</u></p>
    </div>`;
    this.netlistLinkElement = document.getElementById('netlist-link');
    const linkText = document.getElementById('netlist-link-text');
    if (linkText) {
      linkText.addEventListener('click', () => {
        vscode.postMessage({ command: 'executeCommand', commandName: "waveformViewerNetlistView.focus" });
      });
    }
  }

  removeNetlistLink() {
    if (this.netlistLinkElement) {
      this.netlistLinkElement.remove();
      this.netlistLinkElement = null;
    }
  }

  getTimeFromClick(event: MouseEvent) {
    //const bounds    = this.scrollArea.getBoundingClientRect();
    const pixelLeft = Math.round(event.pageX - this.scrollAreaBounds.left);
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

  setValueLinkCursor(keyDown: boolean) {
    if (this.valueLinkObject === null) {return;}
    if (!this.valueLinkObject.canvas)  {return;}
    if (this.valueLinkObject.valueLinkIndex >= 0 && keyDown) {
      this.valueLinkObject.canvas.classList.add('waveform-link');
    } else {
      this.valueLinkObject.canvas.classList.remove('waveform-link');
    }
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
    let rowId: any    = null;
    const containerId = event.target?.closest('.waveform-container');
    if (containerId) {rowId = parseInt(containerId.id.split('-').slice(1));}
    const signalItem = dataManager.rowItems[rowId];
    if (!signalItem) {return;}
    let netlistId = signalItem.netlistId;
    if (netlistId !== undefined && netlistId !== null && netlistId >= 0) {

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = signalItem.getNearestTransition(time);

      if (nearestTransition === null) {return;}

      const nearestTime   = nearestTransition[0];
      const pixelDistance = Math.abs(nearestTime - time) * this.zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}

      if (button === 0 && (event.ctrlKey || event.metaKey)) {
        signalItem.handleValueLink(time, snapToTime);
        return;
      }

      if (button === 0) {
        this.events.dispatch(ActionType.SignalSelect, rowId);
      }
    } else if (isNaN(netlistId || NaN)) {return;}

    this.events.dispatch(ActionType.MarkerSet, snapToTime, button);
  }

  updateScrollbarResize() {
    this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.timeStop * this.zoomRatio)), 17);
    this.maxScrollbarPosition  = Math.max(this.viewerWidth - this.scrollbarWidth, 0);
    this.updateScrollBarPosition();
    this.scrollbar.style.width  = this.scrollbarWidth + 'px';
    this.scrollbar.style.height = 10 + 'px';
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
    //const scrollbarBounds = this.scrollbarContainer.getBoundingClientRect();
    //const scrollbarX      = e.clientX - scrollbarBounds.left;
    const scrollbarX      = e.clientX - this.scrollAreaBounds.left;
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

    document.addEventListener('mousemove', this.handleScrollbarMove);
    viewerState.mouseupEventType = 'scroll';
  }

  highlightZoom(abort: boolean) {
    const timeStart = this.getTimeFromClick(this.highlightStartEvent);
    const timeEnd   = this.getTimeFromClick(this.highlightEndEvent);
    const time      = Math.round((timeStart + timeEnd) / 2);
    const width     = Math.abs(this.highlightStartEvent.pageX - this.highlightEndEvent.pageX);
    const amount    = Math.log2(width / this.viewerWidth);

    if (this.highlightElement) {
      this.highlightElement.remove();
      this.highlightElement = null;
    }

    if (!abort) {
      this.events.dispatch(ActionType.Zoom, amount, time, this.halfViewerWidth);
    }
  }

  drawHighlightZoom(event: MouseEvent) {

    this.highlightEndEvent = event;
    const width       = Math.abs(this.highlightEndEvent.pageX - this.highlightStartEvent.pageX);
    const left        = Math.min(this.highlightStartEvent.pageX, this.highlightEndEvent.pageX);
    //const elementLeft = left - this.scrollArea.getBoundingClientRect().left;
    const elementLeft = left - this.scrollAreaBounds.left;
    const style       = `left: ${elementLeft}px; width: ${width}px; height: ${this.contentArea.clientHeight};`;
  
    if (width > 5) {viewerState.mouseupEventType = 'highlightZoom';}
  
    if (!this.highlightElement) {
      this.highlightElement = domParser.parseFromString(`<div id="highlight-zoom" style="${style}"></div>`, 'text/html').body.firstChild;
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

  updateMarker() {
    if (this.markerElement && viewerState.markerTime !== null) {
      this.markerElement.style.left = this.getViewportLeft(viewerState.markerTime, 15) + 'px';
    }
    if (this.altMarkerElement && viewerState.altMarkerTime !== null) {
      this.altMarkerElement.style.left = this.getViewportLeft(viewerState.altMarkerTime, 15) + 'px';
    }
  }

  renderAllWaveforms(skipRendered: boolean) {
    //const netlistData = dataManager.netlistData;
    const viewerHeightMinusRuler = this.viewerHeight - 40;
    const scrollTop   = this.scrollArea.scrollTop;
    const startIndex  = Math.floor(scrollTop / 28);
    const endIndex    = Math.ceil((scrollTop + viewerHeightMinusRuler) / 28);

    viewerState.visibleSignalsFlat.forEach((rowId, i) => {
      const netlistData = dataManager.rowItems[rowId];

      if (!skipRendered && netlistData.wasRendered) {return;}

      if (i < startIndex || i >= endIndex) {
        netlistData.wasRendered = false;
        return;
      }

      netlistData.renderWaveform();
    });
  }

  async annotateWaveform(rowId: RowId, valueList: string[]) {

    const netlistData = dataManager.rowItems[rowId];
    if (!netlistData) {return;}
    this.annotateTime = netlistData.getAllEdges(valueList);
    this.updateBackgroundCanvas();
  }

  //handleReorderSignals(oldIndex: number, newIndex: number) {
  //  const children       = Array.from(this.waveformArea.children);
  //  arrayMove(children, oldIndex, newIndex);
  //  this.waveformArea.replaceChildren(...children);
  //  const rowId = viewerState.displayedSignals[newIndex];
  //  const netlistElement = dataManager.rowItems[rowId];
  //  if (!netlistElement) {return;}
  //  if (!netlistElement.wasRendered) {netlistElement.renderWaveform();}
  //}

  handleReorderSignalsHierarchy(rowId: number, newGroupId: number, newIndex: number) {

    updateDisplayedSignalsFlat();
    const newChildren: HTMLElement[] = [];
    viewerState.displayedSignalsFlat.forEach((rowId, i) => {
      const element = dataManager.rowItems[rowId].viewportElement;
      if (!element) {return;}
      newChildren.push(element);
    });
    this.waveformArea.replaceChildren(...newChildren);
    this.renderAllWaveforms(false);
  }

  handleRemoveVariable(rowId: RowId) {

    const children = Array.from(this.waveformArea.children).filter((element) => {
      return element.id !== `waveform-${rowId}`;
    });
    this.waveformArea.replaceChildren(...children);
    this.renderAllWaveforms(false);
    const netlistElement = dataManager.rowItems[rowId];
    if (!netlistElement) {return;}
    netlistElement.dispose();
    this.waveformsHeight = this.contentArea.getBoundingClientRect().height;
    this.updateBackgroundCanvas();

    if (children.length === 0) {
      this.addNetlistLink();
    }

  }

  handleMarkerSet(time: number, markerType: number) {
    if (time > this.timeStop || time < 0) {return;}

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
    const xOffset = (time / this.timeStop) * this.viewerWidth;
    this.scrollbarCanvas.lineWidth   = 2;
    this.scrollbarCanvas.strokeStyle = color;
    this.scrollbarCanvas.beginPath();
    this.scrollbarCanvas.moveTo(xOffset, 0);
    this.scrollbarCanvas.lineTo(xOffset, this.viewerWidth);
    this.scrollbarCanvas.stroke();
  }

  handleSignalSelect(rowId: RowId | null) {

    if (rowId === null) {return;}

    let element = document.getElementById('waveform-' + viewerState.selectedSignal);
    if (element && viewerState.selectedSignal !== null) {element.classList.remove('is-selected');}
    element = document.getElementById('waveform-' + rowId);
    if (element) {element.classList.add('is-selected');}
  }

  logScaleFromUnits(unit: string | undefined) {
    switch (unit) {
      case 'fs': return -15;
      case 'ps': return -12;
      case 'ns': return -9;
      case 'us': return -6;
      case 'µs': return -6;
      case 'ms': return -3;
      case 's':  return -0;
      case 'ks': return 3;
      default: return 0;
    }
  }

  updateUnits(units: string, updateContext: boolean) {
    this.displayTimeUnit = units;
    this.adjustedLogTimeScale = this.logScaleFromUnits(this.timeUnit) - this.logScaleFromUnits(units);
    this.updateRuler();
    if (updateContext) {
      sendWebviewContext();
    }
  }

  updateRuler() {
    let tickX = this.rulerTickSpacing - (this.pseudoScrollLeft % this.rulerTickSpacing) - (this.rulerTickSpacing + 0.5);
    let tickXalt = tickX - (this.rulerTickSpacing / 2);
    let numberX = -1 * (this.pseudoScrollLeft % this.rulerNumberSpacing);
    let numberDirty = (this.pseudoScrollLeft + numberX) * this.pixelTime;
    let number = Math.round(numberDirty / this.rulerNumberIncrement) * this.rulerNumberIncrement;
    let setIndex = Math.round(number / this.rulerNumberIncrement);
    const alpha = Math.min((this.zoomOffset - Math.floor(this.zoomOffset)) * 4, 1);
    const twoPi = Math.PI * 2;

    const ctx = this.rulerCanvas;
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.rulerTextColor;
    ctx.font = this.fontStyle;
    ctx.fillStyle = this.rulerTextColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.clearRect(0, 0, this.viewerWidth, 40);

    // Draw the Ticks
    ctx.beginPath();
    while (tickX <= this.viewerWidth) {
      ctx.arc(tickX, 30, 1, 0, twoPi);
      tickX += this.rulerTickSpacing;
    }
    ctx.fill();

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    while (tickXalt <= this.viewerWidth) {
      ctx.arc(tickXalt, 30, 1, 0, twoPi);
      tickXalt += this.rulerTickSpacing;
    }
    ctx.fill();

    // Draw the Numbers
    let scale;
    let valueString;
    if (this.adjustedLogTimeScale >= 0) {
      scale = 10 ** this.adjustedLogTimeScale;
    } else {
      scale = 10 ** -this.adjustedLogTimeScale;
    }

    this.rulerLineX = [];
    ctx.fillStyle = this.rulerTextColor;
    while (numberX <= this.viewerWidth + 50) {
      if (this.adjustedLogTimeScale > 0) {
        valueString = (number * this.timeScale * scale).toString();
      } else {
        valueString = (number * this.timeScale / scale).toString();
      }

      valueString += " " + this.displayTimeUnit;
      if (setIndex % 2 === 1) {
        ctx.globalAlpha = alpha;
        this.rulerLineX.push([numberX, alpha]);
      } else {
        ctx.globalAlpha = 1;
        this.rulerLineX.push([numberX, 1]);
      }

      ctx.fillText(valueString, numberX, 16);
      numberX += this.rulerNumberSpacing;
      number += this.rulerNumberIncrement;
      setIndex += 1;
    }
    
    ctx.globalAlpha = 1;
  }

  updateBackgroundCanvas() {
    const ctx = this.backgroundCanvas;
    ctx.strokeStyle = this.rulerGuideColor;
    ctx.lineWidth   = 1;
    ctx.clearRect(0, 0, this.viewerWidth, this.viewerHeight);

    // Ruler Lines
    if (this.rulerLines) {
      this.rulerLineX.forEach(([x, alpha]) => {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.waveformsHeight);
        ctx.stroke();
      });
    }

    // Annotation lines
    const startIndex = dataManager.binarySearchTime(this.annotateTime, this.timeScrollLeft);
    const endIndex   = dataManager.binarySearchTime(this.annotateTime, this.timeScrollRight);
    let lineList: any= [];
    let boxList: any = [];
    let noDrawFlag   = false;
    let lastDrawTime = 0;
    let lastNoDrawTime = 0;
    let initialTime = 0;

    for (let i = startIndex; i < endIndex; i++) {
      const time = this.annotateTime[i];
      if (time - initialTime < this.minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
      } else {
        if (noDrawFlag) {
          boxList.push([lastDrawTime, lastNoDrawTime]);
          noDrawFlag = false;
        }
        lineList.push(time);
        lastDrawTime = time;
      }
      initialTime = time;
    }
    if (noDrawFlag) {
      boxList.push([lastDrawTime, lastNoDrawTime]);
    }

    ctx.strokeStyle  = this.edgeGuideColor;
    ctx.fillStyle    = this.edgeGuideColor;
    ctx.globalAlpha  = 1;
    ctx.beginPath();
    lineList.forEach((time) => {
      const x = this.getViewportLeft(time, 0);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.waveformsHeight);
    });
    ctx.stroke();

    ctx.beginPath();
    boxList.forEach(([start, end]) => {
      const xStart = this.getViewportLeft(start, 0);
      const xEnd   = this.getViewportLeft(end, 0);
      ctx.moveTo(xStart, 0);
      ctx.lineTo(xStart, this.waveformsHeight);
      ctx.lineTo(xEnd, this.waveformsHeight);
      ctx.lineTo(xEnd, 0);
    });
    ctx.fill();
    ctx.stroke();
  }

  handleZoom(amount: number, zoomOrigin: number, screenPosition: number) {
    // -1 zooms in, +1 zooms out
    // zoomRatio is in pixels per time unit
    if (this.updatePending) {return;}
    if (amount === 0) {return;}

    let newZoomRatio  = this.zoomRatio * Math.pow(2, (-1 * amount));

    if (newZoomRatio > this.maxZoomRatio && amount < 0) {
      newZoomRatio = this.maxZoomRatio;
    } else if (newZoomRatio < this.minZoomRatio && amount > 0) {
      newZoomRatio = this.minZoomRatio;
    }

    if (newZoomRatio === this.zoomRatio) {return;}

    this.updatePending    = true;
    this.zoomRatio        = newZoomRatio;
    this.pixelTime        = 1 / this.zoomRatio;
    this.minDrawWidth     = this.pixelTime / this.pixelRatio;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth, 0));
    this.pseudoScrollLeft = Math.max(Math.min((zoomOrigin * this.zoomRatio) - screenPosition, this.maxScrollLeft), 0);
    this.timeScrollLeft   = this.pseudoScrollLeft * this.pixelTime;
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.timeScrollRight  = this.timeScrollLeft + this.viewerWidthTime;
    this.zoomOffset       = Math.log2(this.zoomRatio / this.defaultZoom);
    const baseZoom        = (2 ** Math.floor(this.zoomOffset)) * this.defaultZoom;
    const spacingRatio    = 2 ** (this.zoomOffset - Math.floor(this.zoomOffset));
    this.rulerTickSpacing = this.minTickSpacing * spacingRatio;
    this.rulerNumberSpacing = this.minNumberSpacing * spacingRatio;
    this.rulerNumberIncrement = this.minNumberSpacing / baseZoom;

    //console.log('zoom ratio: ' + this.zoomRatio + ' zoom offset: ' + zoomOffset + ' base zoom: ' + baseZoom);

    this.updateScrollbarResize();
    this.redrawViewport();
  }

  redrawViewport() {
    this.updatePending = true;
    this.updateMarker();
    this.updateRuler();
    this.updateBackgroundCanvas();
    this.renderAllWaveforms(true);
    this.updatePending = false;
  }

  handleRedrawSignal(rowId: RowId) {
    if (viewerState.markerTime !== null) {
      const signalItem = dataManager.rowItems[rowId];
      if (!signalItem) {return;}
      labelsPanel.valueAtMarker[rowId] = signalItem.getValueAtTime(viewerState.markerTime);
    }
    dataManager.rowItems[rowId].renderWaveform();
  }

  updateViewportWidth() {

    this.pixelRatio       = window.devicePixelRatio || 1;
    this.scrollbarCanvasElement.setAttribute("width",  `0`);
    this.scrollbarCanvasElement.style.width  = `0px`;
    this.scrollAreaBounds = this.scrollArea.getBoundingClientRect();;
    this.viewerWidth      = this.scrollAreaBounds.width - 10;
    this.viewerHeight     = this.scrollAreaBounds.height;
    this.halfViewerWidth  = this.viewerWidth / 2;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth, 0));
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.timeScrollRight  = this.timeScrollLeft + this.viewerWidthTime;
    this.minZoomRatio     = (this.viewerWidth) / this.timeStop;

    // Update Ruler Canvas, Background Canvas, and Scrollbar Canvas Dimensions
    this.resizeCanvas(this.scrollbarCanvasElement, this.scrollbarCanvas, this.viewerWidth, 10);
    this.resizeCanvas(this.rulerCanvasElement, this.rulerCanvas, this.viewerWidth, 40);
    this.resizeCanvas(this.backgroundCanvasElement, this.backgroundCanvas, this.viewerWidth, this.viewerHeight);

    // Update Waveform Canvas Dimensions
    dataManager.rowItems.forEach((netlistItem) => {
      netlistItem.resize();
    });

    if (this.minZoomRatio > this.zoomRatio) {
      this.handleZoom(1, 0, 0);
    } else {
      this.updateScrollbarResize();
      this.handleScrollEvent(this.pseudoScrollLeft);
    }
  }

  handleScrollEvent(newScrollLeft: number) {
    const clampedScrollLeft = Math.max(Math.min(newScrollLeft, this.maxScrollLeft), 0);
    this.pseudoScrollLeft   = clampedScrollLeft;
    this.timeScrollLeft     = this.pseudoScrollLeft * this.pixelTime;
    this.timeScrollRight    = this.timeScrollLeft + this.viewerWidthTime;
    this.updateScrollBarPosition();

    if (this.scrollEventPending) {return;}
    this.scrollEventPending = true;
    this.redrawViewport();
    this.scrollEventPending = false;
  }
}