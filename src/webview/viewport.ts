import { NetlistId, SignalId, type RowId, EnumData, EnumEntry, StateChangeType, type DocumentId, type DefaultWebviewContext, type RulerContext, type WaveformDumpMetadata } from '../common/types';
import { logScaleFromUnits } from '../common/functions';
import { ActionType, type EventHandler } from './event_handler';
import { viewerState, dataManager, handleClickSelection, controlBar, dragController } from "./vaporview";
import { ValueFormat } from './value_format';
import { WaveformRenderer } from './renderer';
import { labelsPanel, rowHandler, vscodeWrapper, styles, config } from "./vaporview";
import { CustomVariable, NetlistVariable, SignalItem, VariableItem } from "./signal_item";

// Describes the axis-specific bits of a scrollbar so the horizontal and
// vertical scrollbars can share a single set of drag/click handlers.
interface ScrollAxis {
  slider: HTMLElement;
  clientCoord: (e: { clientX: number; clientY: number }) => number;
  boundsOffset: () => number;  // origin of the scrollbar track in client coords
  position: () => number;      // current slider position (px)
  maxPosition: () => number;   // max slider travel (px)
  maxScroll: () => number;     // max content scroll
  size: () => number;          // slider length (px)
  hidden: () => boolean;
  scrollTo: (value: number) => void; // apply a content-scroll value on this axis
}

export class Viewport {

  labelsScroll: HTMLElement;
  valuesScroll: HTMLElement;
  scrollArea: HTMLElement;
  scrollAreaBounds: DOMRect;
  contentArea: HTMLElement;
  horizontalScrollbar: HTMLElement;
  ScrollbarContainerH: HTMLElement;
  verticalScrollbar: HTMLElement;
  ScrollbarContainerV: HTMLElement;
  scrollbarCanvasElement: HTMLElement;
  scrollbarCanvas: CanvasRenderingContext2D;
  rulerElement: HTMLElement;
  rulerCanvasElement: HTMLElement;
  rulerCanvas: CanvasRenderingContext2D;
  selectionCanvasElement: HTMLElement;
  selectionCanvas: CanvasRenderingContext2D;
  backgroundCanvasElement: HTMLElement;
  backgroundCanvas: CanvasRenderingContext2D;
  overlayCanvasElement: HTMLElement;
  overlayCanvas: CanvasRenderingContext2D;
  markerLabelElement: HTMLElement;
  altMarkerLabelElement: HTMLElement;
  waveformsCanvasElement: HTMLElement;
  waveformsCanvas: CanvasRenderingContext2D;
  netlistLinkElement: HTMLElement;
  linkText: HTMLElement;
  valueLinkObject: NetlistVariable | null = null;

  highlightEndEvent: MouseEvent | null    = null;
  highlightStartEvent: MouseEvent | null  = null;
  highlightIsZoom           = false;
  highlightDebounce: ReturnType<typeof setTimeout> | null    = null;

  // Scroll handler variables
  pseudoScrollLeft: number    = 0;
  viewerWidth: number         = 0;
  halfViewerWidth: number     = 0;
  maxScrollLeft: number       = 0;
  maxscrollbarPositionX: number = 0;
  scrollbarWidth: number      = 17;
  scrollbarPositionX: number  = 0;
  scrollbarHiddenX: boolean   = true;
  timeScrollLeft: number      = 0;
  viewerWidthTime: number     = 0;
  timeScrollRight: number     = 0;
  timeScale: number           = 1;
  adjustedLogTimeScale: number= 0;
  timeUnit: string            = 'ns';
  displayTimeUnit: string     = 'ns';
  timeStop: number            = 0;
  timeTableCount: number      = 0;
  // Shared drag state for whichever scrollbar is currently being dragged
  scrollbarDragStart: number  = 0;
  pointerDragStart: number    = 0;

  pseudoScrollTop: number     = 0;
  viewerHeight: number        = 0;
  waveformsHeight: number     = 0;
  maxScrollTop: number        = 0;
  maxScrollbarPositionY: number = 0;
  scrollbarHeight: number      = 17;
  scrollbarPositionY: number   = 0;
  scrollbarHiddenY: boolean    = true;

  // Zoom level variables
  zoomRatio: number           = 1;
  defaultPixelTime: number    = 1;
  zoomOffset: number          = 0;
  pixelTime: number           = 1;
  maxZoomRatio: number        = 64;
  minZoomRatio: number        = 1 / 64;
  minDrawWidth: number        = 1;
  rulerNumberSpacing: number  = 100;
  rulerTickSpacing: number    = 10;
  rulerNumberIncrement: number = 100;
  readonly minNumberSpacing: number = 100;
  readonly minTickSpacing: number   = 20;
  rulerLineX: [number, number][] = [];
  annotateTime: number[]      = [];

  pixelRatio: number          = 1;
  updatePending: boolean      = false;
  scrollEventPending: boolean = false;
  hoverItemRowId: RowId | null = null;

  constructor(
    private events: EventHandler,
  ) {
    const labelsScroll        = document.getElementById('waveform-labels-container');
    const valuesScroll        = document.getElementById('value-display-container');
    const scrollArea          = document.getElementById('scrollArea');
    const contentArea         = document.getElementById('contentArea');
    const horizontalScrollbar = document.getElementById('horizontal-scrollbar-slider');
    const ScrollbarContainerH = document.getElementById('horizontal-scrollbar');
    const verticalScrollbar   = document.getElementById('vertical-scrollbar-slider');
    const ScrollbarContainerV = document.getElementById('vertical-scrollbar');
    const scrollbarCanvas     = document.getElementById('scrollbarAreaCanvas');
    const rulerElement        = document.getElementById('ruler');
    const rulerCanvas         = document.getElementById('rulerCanvas');
    const markerLabelElement  = document.getElementById('main-marker-label');
    const altMarkerLabelElement = document.getElementById('alt-marker-label');
    const netlistLinkElement  = document.getElementById('netlist-link');
    const linkText            = document.getElementById('netlist-link-text');
    const selectionCanvas     = document.getElementById('viewport-selection');
    const backgroundCanvas    = document.getElementById('viewport-background');
    const waveformsCanvas     = document.getElementById('viewport-waveforms');
    const overlayCanvas       = document.getElementById('viewport-overlay');

    if (
      labelsScroll === null || valuesScroll === null ||
      scrollArea === null || contentArea === null || horizontalScrollbar === null || 
      ScrollbarContainerH === null || verticalScrollbar === null || ScrollbarContainerV === null || scrollbarCanvas === null || 
      rulerElement === null || rulerCanvas === null ||
      markerLabelElement === null || altMarkerLabelElement === null ||
      netlistLinkElement === null || linkText === null ||
      backgroundCanvas === null || waveformsCanvas === null || 
      overlayCanvas === null || selectionCanvas === null) {
      throw new Error('Viewport elements not found');
    }

    const canvasContext = (scrollbarCanvas as HTMLCanvasElement).getContext('2d');
    const rulerCanvasCtx = (rulerCanvas as HTMLCanvasElement).getContext('2d');
    const backgroundCanvasCtx = (backgroundCanvas as HTMLCanvasElement).getContext('2d');
    const waveformsCanvasCtx = (waveformsCanvas as HTMLCanvasElement).getContext('2d');
    const overlayCanvasCtx = (overlayCanvas as HTMLCanvasElement).getContext('2d');
    const selectionCanvasCtx = (selectionCanvas as HTMLCanvasElement).getContext('2d');

    if (canvasContext === null || rulerCanvasCtx === null || 
      backgroundCanvasCtx === null || overlayCanvasCtx === null ||
      waveformsCanvasCtx === null || selectionCanvasCtx === null) {
      throw new Error('Canvas context not found');
    }

    this.labelsScroll           = labelsScroll;
    this.valuesScroll           = valuesScroll;
    this.scrollArea             = scrollArea;
    this.contentArea            = contentArea;
    this.horizontalScrollbar    = horizontalScrollbar;
    this.markerLabelElement     = markerLabelElement;
    this.altMarkerLabelElement  = altMarkerLabelElement;
    this.ScrollbarContainerH    = ScrollbarContainerH;
    this.scrollbarCanvasElement = scrollbarCanvas;
    this.scrollbarCanvas        = canvasContext;
    this.verticalScrollbar      = verticalScrollbar;
    this.ScrollbarContainerV    = ScrollbarContainerV;
    this.rulerElement           = rulerElement;
    this.rulerCanvasElement     = rulerCanvas;
    this.rulerCanvas            = rulerCanvasCtx;
    this.selectionCanvasElement = selectionCanvas;
    this.selectionCanvas        = selectionCanvasCtx;
    this.netlistLinkElement     = netlistLinkElement;
    this.linkText               = linkText;
    this.backgroundCanvasElement = backgroundCanvas;
    this.backgroundCanvas       = backgroundCanvasCtx;
    this.waveformsCanvasElement = waveformsCanvas;
    this.waveformsCanvas        = waveformsCanvasCtx;
    this.overlayCanvasElement   = overlayCanvas;
    this.overlayCanvas          = overlayCanvasCtx;
    this.scrollAreaBounds       = this.scrollArea.getBoundingClientRect();

    // click handler to handle clicking inside the waveform viewer
    // gets the absolute x position of the click relative to the scrollable content
    const horizontalAxis = this.horizontalAxis();
    const verticalAxis   = this.verticalAxis();
    overlayCanvas.addEventListener('mousedown',      (e) => {this.handleScrollAreaMouseDown(e);});
    horizontalScrollbar.addEventListener('pointerdown', (e) => {this.handleScrollbarDrag(e, horizontalAxis);});
    ScrollbarContainerH.addEventListener('pointerdown', (e) => {this.handleScrollbarContainerClick(e, horizontalAxis);});
    verticalScrollbar.addEventListener('pointerdown',   (e) => {this.handleScrollbarDrag(e, verticalAxis);});
    ScrollbarContainerV.addEventListener('pointerdown', (e) => {this.handleScrollbarContainerClick(e, verticalAxis);});
    overlayCanvas.addEventListener('contextmenu',    (e) => {this.handleContextMenu(e);});
    overlayCanvas.addEventListener("pointermove",    (e) => {this.handleMouseOver(e);});
    linkText.addEventListener('click',               (e) => {vscodeWrapper.executeCommand("waveformViewerNetlistView.focus", []);});

    this.handleContextMenu = this.handleContextMenu.bind(this);
    this.updateViewportWidth = this.updateViewportWidth.bind(this);
    this.handleZoom = this.handleZoom.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);
    this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.highlightZoom = this.highlightZoom.bind(this);
    this.drawHighlightZoomCanvas = this.drawHighlightZoomCanvas.bind(this);
    this.handleRemoveVariable = this.handleRemoveVariable.bind(this);
    this.handleAddVariable = this.handleAddVariable.bind(this);
    this.handleRedrawSignal = this.handleRedrawSignal.bind(this);
    this.handleColorChange = this.handleColorChange.bind(this);
    this.handleExitBatchMode = this.handleExitBatchMode.bind(this);

    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    this.events.subscribe(ActionType.AddVariable, this.handleAddVariable);
    this.events.subscribe(ActionType.RemoveVariable, this.handleRemoveVariable);
    this.events.subscribe(ActionType.RedrawVariable, this.handleRedrawSignal);
    this.events.subscribe(ActionType.Resize, this.updateViewportWidth);
    this.events.subscribe(ActionType.UpdateColorTheme, this.handleColorChange);
    this.events.subscribe(ActionType.ExitBatchMode, this.handleExitBatchMode);
  }

  handleExitBatchMode() {
    const totalSignals = viewerState.displayedSignalsFlat.length;
    this.netlistLinkElement.style.display = totalSignals > 0 ? 'none' : 'flex';
    this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
    this.updateWaveformsHeight();
    this.updateBackgroundCanvas();
    this.redrawViewport();
    this.handleSignalSelect(viewerState.selectedSignal, viewerState.lastSelectedSignal);
  }

  initViewport(metadata: WaveformDumpMetadata) {
    this.setPixelRatio();
    this.timeScale        = metadata.timeScale;
    this.timeUnit         = metadata.timeUnit;
    this.displayTimeUnit  = metadata.timeUnit;
    this.timeStop         = metadata.timeEnd;
    this.timeTableCount   = metadata.timeTableCount;
    this.defaultPixelTime = 10 ** (Math.round(Math.log10(Number(metadata.minTimeStep))) | 0);
    this.zoomRatio        = 1 / this.defaultPixelTime;
    this.pixelTime        = 1 / this.zoomRatio;
    this.maxZoomRatio     = this.zoomRatio * 256;
    this.adjustedLogTimeScale   = 0;
    this.updateUnits(this.timeUnit, false);
    this.setRulerVscodeContext();
    this.netlistLinkElement.style.display = 'flex';
    this.updateViewportWidth();
    this.updateHorizontalScrollbar();
    this.updateVerticalScrollbar();
    this.handleZoom(-4, 0, 0);
  }

  async handleColorChange() {
    this.redrawViewport();
  }

  setPixelRatio() {
    if (config.overrideDevicePixelRatio) {
      this.pixelRatio = config.userPixelRatio || 1;
    } else {
      this.pixelRatio = window.devicePixelRatio || 1;
    }
    styles.updateglowBlur();
  }

  setRulerVscodeContext() {
    const maxTime   = (10 ** logScaleFromUnits(this.timeUnit)) * this.timeScale * this.timeStop;
    const context: RulerContext = {
      webviewSection: 'ruler',
      preventDefaultContextMenuItems: true,
      rulerLines: config.rulerLines,
      fillBitVector: config.fillMultiBitValues,
      enableAnimations: config.enableAnimations,
      fs: maxTime >= (10 ** logScaleFromUnits('fs')),
      ps: maxTime >= (10 ** logScaleFromUnits('ps')),
      ns: maxTime >= (10 ** logScaleFromUnits('ns')),
      µs: maxTime >= (10 ** logScaleFromUnits('µs')),
      ms: maxTime >= (10 ** logScaleFromUnits('ms')),
      s:  maxTime >= (10 ** logScaleFromUnits('s')),
    };

    const contextAttribute = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
    this.rulerElement.setAttribute("data-vscode-context", contextAttribute);
    controlBar.settings.setAttribute("data-vscode-context", contextAttribute);
  }

  public resizeCanvas(canvasElement: HTMLElement, ctx: CanvasRenderingContext2D, width: number, height: number) {
    canvasElement.setAttribute("width",  `${width * this.pixelRatio}`);
    canvasElement.setAttribute("height", `${height * this.pixelRatio}`);
    canvasElement.style.width  = `${width}px`;
    canvasElement.style.height = `${height}px`;
    ctx.scale(this.pixelRatio, this.pixelRatio);
  }

  handleAddVariable(rowIdList: RowId[], updateFlag: boolean) {
    if (this.events.isBatchMode) {return;}
    rowIdList.forEach((rowId) => {
      if (!rowHandler.rowItems[rowId]) {return;}
      this.netlistLinkElement.style.display = 'none';
      const netlistData = rowHandler.rowItems[rowId];

      if (updateFlag) {netlistData.renderWaveform();}
    });
    this.updateWaveformsHeight();
    this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
    this.updateBackgroundCanvas();
    this.updateOverlayCanvas();
  }

  getTimeFromClick(event: MouseEvent) {
    const eventLeft = Math.round(event.pageX - this.scrollAreaBounds.left);
    const pixelLeft = Math.min(Math.max(0, eventLeft), this.viewerWidth);
    return Math.round((pixelLeft + this.pseudoScrollLeft) * this.pixelTime);
  }

  getRowIdFromMouseEvent(event: MouseEvent): RowId | null {
    const eventTop   = Math.round(event.pageY - this.scrollAreaBounds.top - styles.rulerHeight);
    const pageY      = eventTop + this.pseudoScrollTop;

    for (const rowId of viewerState.visibleSignalsFlat) {
      const bounds = this.getRowIdBounds(rowId);
      if (bounds === null) {continue;}
      const [topBounds, bottomBounds] = bounds;
      if (pageY >= topBounds && pageY < bottomBounds) {
        return rowId;
      }
    }
    return null;
  }

  getViewportLeft(time: number, clamp: number) {
    const x = (time * this.zoomRatio) - this.pseudoScrollLeft;
    return Math.max(Math.min(x, this.viewerWidth + clamp), -clamp);
  }

  updateWaveformsHeight() {
    const index  = viewerState.displayedSignalsFlat.length - 1;
    const rowId  = viewerState.displayedSignalsFlat[index];
    const bounds = this.getRowIdBounds(rowId);
    if (bounds === null) {
      this.waveformsHeight = 0;
    } else {
      this.waveformsHeight = bounds[1];
    }
    this.updateVerticalScrollbar();
  }

  isInView(time: number) {
    return (time >= this.timeScrollLeft && time <= this.timeScrollRight);
  }

  getRowIdBounds(rowId: RowId): [number, number] | null {
    const netlistData = rowHandler.rowItems[rowId];
    if (!netlistData) {return null;}
    const topBounds = netlistData.topBounds;
    if (topBounds === null) {return null;}
    const rowHeight = netlistData.rowHeight * styles.rowHeight;
    const bottomBounds = topBounds + rowHeight;
    return [topBounds, bottomBounds];
  }

  moveViewToTime(time: number) {
    const moveViewer = !(this.isInView(time));
    if (moveViewer) {
      this.handleScrollEvent((time * this.zoomRatio) - this.halfViewerWidth, this.pseudoScrollTop);
    }
    return moveViewer;
  }

  setValueLinkCursor(keyDown: boolean) {
    if (this.valueLinkObject === null) {return;}

    if (this.valueLinkObject.valueLinkIndex >= 0 && keyDown) {
      this.overlayCanvasElement.classList.add('waveform-link');
    } else {
      this.overlayCanvasElement.classList.remove('waveform-link');
    }
  }

  handleContextMenu(event: MouseEvent) {
    const rowId = this.getRowIdFromMouseEvent(event);
    if (rowId !== null) {
      const signalItem = rowHandler.rowItems[rowId];
      if (signalItem) {
        this.overlayCanvasElement.setAttribute('data-vscode-context', signalItem.vscodeContext);
        return;
      }
    }
    this.overlayCanvasElement.setAttribute('data-vscode-context', "{}");
  }

  handleMouseOver(event: MouseEvent) {
    const rowId = this.getRowIdFromMouseEvent(event);
    if (rowId !== null) {
      const signalItem = rowHandler.rowItems[rowId];
      if (signalItem instanceof NetlistVariable && signalItem.valueLinkEnable) {
        signalItem.handleValueLinkMouseOver(event);
      }
    }
    if (this.hoverItemRowId !== null && rowId !== this.hoverItemRowId) {
      const oldSignalItem = rowHandler.rowItems[this.hoverItemRowId];
      if (oldSignalItem instanceof NetlistVariable) {
        oldSignalItem.handleValueLinkMouseExit(event);
      }
    }
    this.hoverItemRowId = rowId;
  }

  handleScrollAreaMouseDown(event: MouseEvent) {
    if (event.button === 1) {
      this.handleScrollAreaClick(event, 1);
      return;
    }
    if (event.button !== 0) {return;}

    this.highlightStartEvent = event;
    this.highlightEndEvent   = null;
    this.highlightIsZoom     = false;
    // A click in empty space below the waveforms still needs to deselect on release,
    // but it must not draw a highlight rectangle.
    const startRowId = this.getRowIdFromMouseEvent(event);

    dragController.begin(event, {
      kind: 'pointer',
      focusOnStart: true,
      onMove: (e) => {
        if (startRowId === null) {return;}
        this.drawHighlightZoomCanvas(e as MouseEvent);
      },
      onEnd: (e, abort) => this.endScrollAreaClickDrag(abort),
    });
  }

  endScrollAreaClickDrag(abort: boolean) {
    if (this.highlightDebounce) {
      clearTimeout(this.highlightDebounce);
      this.highlightDebounce = null;
    }
    if (this.highlightIsZoom) {
      this.highlightZoom(abort);
    } else {
      if (this.highlightStartEvent) {this.handleScrollAreaClick(this.highlightStartEvent, 0);}
      this.updateOverlayCanvas();
    }
  }

  handleScrollAreaClick(event: MouseEvent, eventButton: number) {

    let button = eventButton;

    if (eventButton === 1) {event.preventDefault();}
    if (eventButton === 2) {return;}
    if (eventButton === 0 && event.altKey) {button = 1;}

    const snapToDistance = 3.5;

    // Get the time position of the click
    const time     = this.getTimeFromClick(event);
    let snapToTime = time;

    // Get the signal id of the click
    const rowId    = this.getRowIdFromMouseEvent(event);
    if (rowId === null) {
      rowHandler.deselectAllSignals();
      return;
    }
    const signalItem = rowHandler.rowItems[rowId];
    if (!signalItem) {return;}

    let updateContext = false;
    if (signalItem instanceof NetlistVariable || signalItem instanceof CustomVariable) {
      // Snap to the nearest transition if the click is close enough
      const nearestTransition = signalItem.getNearestTransition(time);

      // only set the marker if we're actually clicking on a waveform
      if (nearestTransition !== null) {

        const nearestTime   = nearestTransition[0];
        const pixelDistance = Math.abs(nearestTime - time) * this.zoomRatio;

        if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}

        if (button === 0 && (event.ctrlKey || event.metaKey)) {
          const linkClicked = signalItem.handleValueLink(time, snapToTime);
          if (linkClicked) {return;}
        }
        if (!(event.ctrlKey || event.shiftKey || event.metaKey)) {
          this.events.markerSet(snapToTime, button, false);
          updateContext = true;
        }
      }
    }

    if (button === 0) {
      // This will call sendWebviewContext(), so we don't need to call it again below
      handleClickSelection(event, rowId);
      updateContext = false;
    }

    if (updateContext) {
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    }
  }

  updateHorizontalScrollbar() {
    this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.timeStop * this.zoomRatio)), 17);
    this.maxscrollbarPositionX = Math.max(this.viewerWidth - this.scrollbarWidth, 0);
    this.updatescrollbarPositionX();
    this.horizontalScrollbar.style.width = this.scrollbarWidth + 'px';
    this.updateScrollContainer();
  }

  updatescrollbarPositionX() {
    this.scrollbarHiddenX         = this.maxScrollLeft === 0;
    this.scrollbarPositionX       = Math.round((this.pseudoScrollLeft / this.maxScrollLeft) * this.maxscrollbarPositionX);
    this.horizontalScrollbar.style.display = this.scrollbarHiddenX ? 'none' : 'block';
    this.horizontalScrollbar.style.left    = this.scrollbarPositionX + 'px';
  }

  updateVerticalScrollbar() {
    this.maxScrollTop           = Math.max(this.waveformsHeight - this.viewerHeight, 0);
    this.scrollbarHeight        = Math.max(Math.round((this.viewerHeight ** 2) / this.waveformsHeight), 17);
    this.maxScrollbarPositionY  = Math.max(this.viewerHeight - this.scrollbarHeight, 0);
    this.updatescrollbarPositionY();
    this.verticalScrollbar.style.height = this.scrollbarHeight + 'px';
  }

  updatescrollbarPositionY() {
    this.scrollbarHiddenY         = this.maxScrollTop === 0;
    this.scrollbarPositionY       = Math.round((this.pseudoScrollTop / this.maxScrollTop) * this.maxScrollbarPositionY);
    this.verticalScrollbar.style.display = this.scrollbarHiddenY ? 'none' : 'block';
    this.verticalScrollbar.style.top     = this.scrollbarPositionY + 'px';
  }

  horizontalAxis(): ScrollAxis {
    return {
      slider:       this.horizontalScrollbar,
      clientCoord:  (e) => e.clientX,
      boundsOffset: () => this.scrollAreaBounds.left,
      position:     () => this.scrollbarPositionX,
      maxPosition:  () => this.maxscrollbarPositionX,
      maxScroll:    () => this.maxScrollLeft,
      size:         () => this.scrollbarWidth,
      hidden:       () => this.scrollbarHiddenX,
      scrollTo:     (v) => this.handleScrollEvent(v, this.pseudoScrollTop),
    };
  }

  verticalAxis(): ScrollAxis {
    return {
      slider:       this.verticalScrollbar,
      clientCoord:  (e) => e.clientY,
      boundsOffset: () => this.scrollAreaBounds.top,
      position:     () => this.scrollbarPositionY,
      maxPosition:  () => this.maxScrollbarPositionY,
      maxScroll:    () => this.maxScrollTop,
      size:         () => this.scrollbarHeight,
      hidden:       () => this.scrollbarHiddenY,
      scrollTo:     (v) => this.handleScrollEvent(this.pseudoScrollLeft, v),
    };
  }

  handleScrollbarContainerClick(e: PointerEvent, axis: ScrollAxis) {
    e.preventDefault();
    if (axis.hidden()) {return;}
    const coord       = axis.clientCoord(e) - axis.boundsOffset();
    const newPosition = Math.min(Math.max(0, coord - (axis.size() / 2)), axis.maxPosition());
    const newScroll   = Math.round((newPosition / axis.maxPosition()) * axis.maxScroll());
    axis.scrollTo(newScroll);

    // roll this event into the scrollbar drag event
    this.handleScrollbarDrag(e, axis);
  }

  handleScrollbarDrag(event: PointerEvent, axis: ScrollAxis) {
    event.preventDefault();
    event.stopPropagation();
    this.scrollbarDragStart = axis.position();
    this.pointerDragStart   = axis.clientCoord(event);
    axis.slider.classList.add('is-dragging');

    dragController.begin(event, {
      kind: 'pointer',
      capture: axis.slider,
      onMove: (e) => this.handleScrollbarMove(e, axis),
      onEnd:  () => axis.slider.classList.remove('is-dragging'),
    });
  }

  handleScrollbarMove(e: MouseEvent | PointerEvent, axis: ScrollAxis) {
    const newPosition = axis.clientCoord(e) - this.pointerDragStart + this.scrollbarDragStart;
    const newScroll   = Math.round((newPosition / axis.maxPosition()) * axis.maxScroll());
    // No need to clamp the value, because handleScrollEvent() clamps it for us
    axis.scrollTo(newScroll);
  }

  highlightZoom(abort: boolean) {
    this.updateOverlayCanvas();
    if (abort) {return;}
    if (!this.highlightStartEvent || !this.highlightEndEvent || abort) {return;}
    const timeStart = this.getTimeFromClick(this.highlightStartEvent);
    const timeEnd   = this.getTimeFromClick(this.highlightEndEvent);
    this.animateZoomRange(timeStart, timeEnd);
  }

  drawHighlightZoomCanvas(event: MouseEvent) {

    const ctx = this.overlayCanvas;

    // workaround for issue with canvas draw
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, 1);
    ctx.stroke();

    this.updateOverlayCanvas();
    this.highlightEndEvent = event;
    if (!this.highlightStartEvent) {return;}
    const width       = Math.abs(this.highlightEndEvent.pageX - this.highlightStartEvent.pageX);
    const left        = Math.min(this.highlightStartEvent.pageX, this.highlightEndEvent.pageX);
    const elementLeft = left - this.scrollAreaBounds.left;
    ctx.fillStyle     = styles.highlightColor;
    ctx.globalAlpha   = 0.5;
    ctx.roundRect(elementLeft, 0, width, this.waveformsHeight, 2);
    ctx.fill();
    ctx.globalAlpha   = 1;

    if (width > 5) {this.highlightIsZoom = true;}

    if (!this.highlightDebounce) {
      this.highlightDebounce = setTimeout(() => {
        this.highlightIsZoom = true;
      }, 300);
    }
  }

  updateMarker() {
    const clamp = 100;
    if (viewerState.markerTime !== null) {
      const screenX = this.getViewportLeft(viewerState.markerTime, clamp);
      this.markerLabelElement.style.left = screenX + 'px';
    }
    if (viewerState.altMarkerTime !== null) {
      const screenX = this.getViewportLeft(viewerState.altMarkerTime, clamp);
      this.altMarkerLabelElement.style.left = screenX + 'px';
    }
    this.updateOverlayCanvas();
  }

  renderAllWaveforms() {
    if (this.events.isBatchMode) {return;}

    const scrollTop    = this.pseudoScrollTop;
    const windowHeight = scrollTop + this.viewerHeight;

    this.waveformsCanvas.clearRect(0, 0, this.viewerWidth, this.viewerHeight);

    viewerState.visibleSignalsFlat.forEach((rowId) => {
      const bounds = this.getRowIdBounds(rowId);
      if (bounds === null) {return;}
      const [topBounds, bottomBounds] = bounds;
      const netlistData = rowHandler.rowItems[rowId];

      if (bottomBounds <= scrollTop || topBounds >= windowHeight || topBounds < 0) {
        netlistData.wasRendered = false;
        return;
      }

      netlistData.renderWaveform();
    });
  }

  async annotateWaveform(rowId: RowId, valueList: string[]) {

    const netlistData = rowHandler.rowItems[rowId];
    if (!netlistData) {return;}
    this.annotateTime = netlistData.getAllEdges(valueList);
    this.updateBackgroundCanvas();
  }

  handleReorderSignals(rowIdList: number[], newGroupId: number, newIndex: number) {
    if (this.events.isBatchMode) {return;}
    this.renderAllWaveforms();
  }

  handleRemoveVariable(rowId: RowId[], recursive: boolean) {

    this.updateWaveformsHeight();
    this.renderAllWaveforms();
    this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
    this.updateBackgroundCanvas();
    this.updateOverlayCanvas();

    if (viewerState.displayedSignalsFlat.length === 0) {
      this.netlistLinkElement.style.display = 'flex';
    }
  }

  handleMarkerSet(time: number, markerType: number, dragging: boolean) {
    if (time > this.timeStop || time < 0) {return;}

    const labelElement = markerType === 0 ? this.markerLabelElement : this.altMarkerLabelElement;

    if (time === null) {
      labelElement.style.display = 'none';
      return;
    }

    if (markerType === 0) {
      viewerState.markerTime = time;
      if (!this.events.isBatchMode) {
        this.moveViewToTime(time);
      }
    } else {
      viewerState.altMarkerTime = time;
    }

    this.updateMarker();
    this.updateScrollContainer();
    labelElement.style.display = 'block';
    labelElement.innerText = this.scaleTime(time) + ' ' + this.displayTimeUnit;
  }

  updateScrollContainer() {
    this.scrollbarCanvas.clearRect(0, 0, this.scrollbarCanvas.canvas.width, this.scrollbarCanvas.canvas.height);
    this.annotateScrollContainer(styles.markerAnnotation , viewerState.markerTime);
    this.annotateScrollContainer(styles.markerAnnotation , viewerState.altMarkerTime);
  }

  annotateScrollContainer(color: string, time: number | null) {

    if (time === null) {return;}
    const xOffset = (time / this.timeStop) * this.viewerWidth;
    this.scrollbarCanvas.lineWidth   = 2;
    this.scrollbarCanvas.strokeStyle = color;
    this.scrollbarCanvas.beginPath();
    this.scrollbarCanvas.moveTo(xOffset, 0);
    this.scrollbarCanvas.lineTo(xOffset, this.viewerWidth);
    this.scrollbarCanvas.stroke();
  }

  handleSignalSelect(rowIdList: RowId[], lastSelected: RowId | null) {
    this.updateSelectionCanvas(rowIdList, lastSelected);
  }

  updateSelectionCanvas(rowIdList: RowId[], lastSelected: RowId | null) {
    const ctx = this.selectionCanvas;
    ctx.clearRect(0, 0, this.viewerWidth, this.viewerHeight);
    ctx.fillStyle = styles.selectionBackgroundColor;
    ctx.strokeStyle = styles.selectionContrastBorder;
    ctx.lineWidth = 1;
    ctx.setLineDash([1, 1]);
    const yOffset = this.pseudoScrollTop;
    rowIdList.forEach((rowId) => {
      const bounds = this.getRowIdBounds(rowId);
      if (bounds === null) {return;}
      const topBounds = bounds[0];
      const screenTop = topBounds - yOffset;
      const height    = styles.rowHeight * rowHandler.rowItems[rowId].rowHeight;
      ctx.fillRect(0, screenTop, this.viewerWidth, height);
    });
    ctx.setLineDash([]);
    ctx.strokeStyle = styles.selectionBorderColor;
    if (lastSelected === null) {return;}
    const bounds = this.getRowIdBounds(lastSelected);
    if (bounds === null) {return;}
    ctx.beginPath();
    ctx.moveTo(0, bounds[0] + 0.5 - yOffset);
    ctx.lineTo(this.viewerWidth, bounds[0] - yOffset);
    ctx.moveTo(0, bounds[1] - 0.5 - yOffset);
    ctx.lineTo(this.viewerWidth, bounds[1] - yOffset);
    ctx.stroke();
  }

  scaleTime(time: number) {
    let scale;
    if (this.adjustedLogTimeScale >= 0) {
      scale = 10 ** this.adjustedLogTimeScale;
      return time * this.timeScale * scale;
    } else {
      scale = 10 ** -this.adjustedLogTimeScale;
      return time * this.timeScale / scale;
    }
  }

  updateUnits(units: string, updateContext: boolean) {
    const validUnits = ['fs', 'ps', 'ns', 'µs', 'us', 'ms', 's'];

    if (!validUnits.includes(units)) {return;}
    if (units === this.displayTimeUnit) {return;}

    let newUnits = units;
    if (units === 'us') {newUnits = 'µs';}

    this.displayTimeUnit = newUnits;
    this.adjustedLogTimeScale = logScaleFromUnits(this.timeUnit) - logScaleFromUnits(units);
    if (viewerState.markerTime !== null) {
      this.markerLabelElement.innerText = this.scaleTime(viewerState.markerTime) + ' ' + this.displayTimeUnit;
    }
    if (viewerState.altMarkerTime !== null) {
      this.altMarkerLabelElement.innerText = this.scaleTime(viewerState.altMarkerTime) + ' ' + this.displayTimeUnit;
    }
    this.updateRuler();
    if (updateContext) {
      //console.log('updateUnits');
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    }
  }

  updateRuler() {
    let tickX = this.rulerTickSpacing - (this.pseudoScrollLeft % this.rulerTickSpacing) - (this.rulerTickSpacing + 0.5);
    let tickXalt = tickX - (this.rulerTickSpacing / 2);
    let numberX = -1 * (this.pseudoScrollLeft % this.rulerNumberSpacing);
    const numberDirty = (this.pseudoScrollLeft + numberX) * this.pixelTime;
    let number = Math.round(numberDirty / this.rulerNumberIncrement) * this.rulerNumberIncrement;
    let setIndex = Math.round(number / this.rulerNumberIncrement);
    const alpha = Math.min((this.zoomOffset - Math.floor(this.zoomOffset)) * 4, 1);
    const twoPi = Math.PI * 2;
    const textBaseline = 23 + styles.baselineOffset;

    const ctx = this.rulerCanvas;
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    ctx.lineWidth = 1;
    ctx.strokeStyle = styles.rulerTextColor;
    ctx.font = styles.fontStyle;
    ctx.fillStyle = styles.rulerGuideColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.clearRect(0, 0, this.viewerWidth, styles.rulerHeight);

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
    ctx.fillStyle = styles.rulerTextColor;
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

      // Y height is .time-marker-label top offset
      ctx.fillText(valueString, numberX, textBaseline);
      numberX += this.rulerNumberSpacing;
      number += this.rulerNumberIncrement;
      setIndex += 1;
    }

    ctx.globalAlpha = 1;
  }

  updateBackgroundCanvas() {

    if (this.events.isBatchMode) {return;}

    const ctx = this.backgroundCanvas;
    ctx.strokeStyle = styles.rulerGuideColor;
    ctx.lineWidth   = 1;
    ctx.clearRect(0, 0, this.viewerWidth, this.viewerHeight);

    // Ruler Lines
    if (config.rulerLines) {
      this.rulerLineX.forEach(([x, alpha]) => {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.waveformsHeight);
        ctx.stroke();
      });
    }

    if (this.annotateTime.length === 0) {return;}

    // Annotation lines
    const startIndex = dataManager.binarySearchTime(this.annotateTime, this.timeScrollLeft);
    const endIndex   = dataManager.binarySearchTime(this.annotateTime, this.timeScrollRight);
    const lineList: number[]= [];
    const boxList: [number, number][] = [];
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

    ctx.strokeStyle  = styles.edgeGuideColor;
    ctx.fillStyle    = styles.edgeGuideColor;
    ctx.globalAlpha  = 1;
    ctx.beginPath();
    lineList.forEach((time: number) => {
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

  updateOverlayCanvas() {
    const ctx = this.overlayCanvas;
    let drawAltMarker = true;
    ctx.clearRect(0, 0, this.viewerWidth, this.viewerHeight);
    ctx.strokeStyle = styles.markerColor;
    ctx.lineWidth = 1;

    if (viewerState.markerTime !== null) {
      // set stroke dash array to 2 2
      ctx.setLineDash([2, 2]);
      if (viewerState.altMarkerTime === viewerState.markerTime) {
        ctx.setLineDash([]);
        drawAltMarker = false;
      }
      const markerX = this.getViewportLeft(viewerState.markerTime, 100);
      ctx.beginPath();
      ctx.moveTo(markerX, 0);
      ctx.lineTo(markerX, this.waveformsHeight);
      ctx.stroke();
    }

    if (viewerState.altMarkerTime !== null && drawAltMarker) {
      ctx.setLineDash([6, 2, 2, 2]);
      const altMarkerX = this.getViewportLeft(viewerState.altMarkerTime, 100);
      ctx.beginPath();
      ctx.moveTo(altMarkerX, 0);
      ctx.lineTo(altMarkerX, this.waveformsHeight);
      ctx.stroke();
    }
  }

  clampZoomRatio(zoomRatio: number) {
    return Math.max(this.minZoomRatio, Math.min(zoomRatio, this.maxZoomRatio));
  }

  setViewportRange(startTime: number, endTime: number) {
    const timeRange = Math.max(endTime - startTime, 1);

    if (this.updatePending) {return;}
    if (startTime < 0 || endTime <= startTime || endTime > this.timeStop) {return;}
    if (timeRange <= 0) {return;}

    // Calculate the zoom ratio needed to show this range
    const newZoomRatio     = this.viewerWidth / timeRange;
    const clampedZoomRatio = this.clampZoomRatio(newZoomRatio);
    const newScrollLeft    = startTime * clampedZoomRatio;
    this.applyZoom(newScrollLeft, clampedZoomRatio);
  }

  handleZoom(amount: number, zoomOrigin: number, screenPosition: number) {
    // -1 zooms in, +1 zooms out
    // zoomRatio is in pixels per time unit
    if (this.updatePending) {return;}
    if (amount === 0) {return;}

    const newZoomRatio     = this.zoomRatio * 2 ** (-1 * amount);
    const clampedZoomRatio = this.clampZoomRatio(newZoomRatio);
    const newScrollLeft    = (zoomOrigin * clampedZoomRatio) - screenPosition;

    if (clampedZoomRatio === this.zoomRatio) {return;}

    this.applyZoom(newScrollLeft, clampedZoomRatio);
  }

  applyZoom(newScrollLeft: number, newZoomRatio: number) {

    this.updatePending    = true;
    this.zoomRatio        = newZoomRatio;
    this.pixelTime        = 1 / this.zoomRatio;
    this.minDrawWidth     = this.pixelTime / this.pixelRatio;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth, 0));
    this.pseudoScrollLeft = Math.max(Math.min(newScrollLeft, this.maxScrollLeft), 0);
    this.timeScrollLeft   = this.pseudoScrollLeft * this.pixelTime;
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.timeScrollRight  = this.timeScrollLeft + this.viewerWidthTime;

    //console.log('zoom ratio: ' + this.zoomRatio + ' base zoom: ' + baseZoom);

    this.updateRulerSpacing();
    this.updateHorizontalScrollbar();
    this.redrawViewport();
  }

  updateRulerNumberBasis(inputIncrement: number, updateState: boolean) {
    let numberIncrement = this.minNumberSpacing * this.pixelTime;
    if (inputIncrement > 0) {
      numberIncrement = inputIncrement;
    }

    const numberBasis     = 10 ** (Math.round(Math.log10(numberIncrement)) | 0);
    const newPixelTime    = numberBasis / this.minNumberSpacing;

    if (newPixelTime === this.defaultPixelTime) {return;}

    this.defaultPixelTime = newPixelTime;
    this.updateRulerSpacing();
    this.updateRuler();
    this.updateBackgroundCanvas();
    if (updateState) {
      vscodeWrapper.sendWebviewContext(StateChangeType.User);
    }
  }

  updateRulerSpacing() {
    this.zoomOffset           = Math.log2(this.zoomRatio * this.defaultPixelTime);
    const baseZoom            = (2 ** Math.floor(this.zoomOffset)) / this.defaultPixelTime;
    const spacingRatio        = 2 ** (this.zoomOffset - Math.floor(this.zoomOffset));
    this.rulerTickSpacing     = this.minTickSpacing * spacingRatio;
    this.rulerNumberSpacing   = this.minNumberSpacing * spacingRatio;
    this.rulerNumberIncrement = this.minNumberSpacing / baseZoom;
  }

  private animate(callback: (progress: number) => void): Promise<void> {
    return new Promise((resolve) => {
      let startTime: number | null = null;
  
      const frame = (timestamp: number) => {
        if (startTime === null) startTime = timestamp;
        const progress = Math.min((timestamp - startTime) / config.animationDuration, 1);
  
        callback(progress);
  
        if (progress < 1) {
          requestAnimationFrame(frame);
        } else {
          resolve();
        }
      };
  
      requestAnimationFrame(frame);
    });
  }

  async animateZoomRange(t1: number, t2: number) {
    const timeStart = Math.min(t1, t2);
    const timeEnd   = Math.max(t1, t2);
  
    if (!config.enableAnimations) {
      this.setViewportRange(timeStart, timeEnd);
      return;
    }
  
    const pixelTimeStart = (timeStart - this.timeScrollLeft) * this.zoomRatio;
    const pixelTimeEnd   = (timeEnd   - this.timeScrollLeft) * this.zoomRatio;
    const pixelDelta     = this.viewerWidth - pixelTimeEnd;
    const deltaTime      = timeEnd - timeStart;
  
    await this.animate((progress) => {
      const newPixelTimeStart = pixelTimeStart - (pixelTimeStart * progress);
      const newPixelTimeEnd   = pixelTimeEnd   + (pixelDelta * progress);
      const newDeltaTime      = Math.max(newPixelTimeEnd - newPixelTimeStart, 1);
      const newPixelTime      = deltaTime / newDeltaTime;
      const newTimeStart      = timeStart - (newPixelTimeStart * newPixelTime);
      const newTimeEnd        = timeEnd + ((this.viewerWidth - newPixelTimeEnd) * newPixelTime);
      this.setViewportRange(newTimeStart, newTimeEnd);
    });
  }

  async animateZoom(amount: number, zoomOrigin: number, screenPosition: number) {
    if (!config.enableAnimations) {
      this.handleZoom(amount, zoomOrigin, screenPosition);
      return;
    }
  
    let totalZoomAmount = 0;
    await this.animate((progress) => {
      const partialZoomAmount = (amount * progress) - totalZoomAmount;
      totalZoomAmount += partialZoomAmount;
      this.handleZoom(partialZoomAmount, zoomOrigin, screenPosition);
    });
  }

  redrawViewport() {
    this.updatePending = true;
    this.updateMarker();
    this.updateRuler();
    this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
    this.updateBackgroundCanvas();
    this.renderAllWaveforms();
    this.updatePending = false;
  }

  updateElementHeight() {

    this.updateWaveformsHeight();
    this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
    this.updateBackgroundCanvas();
    this.renderAllWaveforms();
    this.updateOverlayCanvas();
  }

  handleRedrawSignal(rowId: RowId) {
    const signalItem = rowHandler.rowItems[rowId];
    if (!signalItem) {return;}
    labelsPanel.valueAtMarker[rowId] = signalItem.getValueAtTime(viewerState.markerTime);
    signalItem.renderWaveform();
  }

  updateViewportWidth() {

    this.setPixelRatio();
    this.scrollbarCanvasElement.setAttribute("width",  `0`);
    this.scrollbarCanvasElement.style.width  = `0px`;
    this.scrollAreaBounds = this.scrollArea.getBoundingClientRect();
    this.viewerWidth      = this.scrollAreaBounds.width - 10;
    this.viewerHeight     = this.scrollAreaBounds.height - styles.rulerHeight;
    this.halfViewerWidth  = this.viewerWidth / 2;
    this.maxScrollLeft    = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth, 0));
    this.viewerWidthTime  = this.viewerWidth * this.pixelTime;
    this.timeScrollRight  = this.timeScrollLeft + this.viewerWidthTime;
    this.minZoomRatio     = this.viewerWidth / this.timeStop;

    // Update Ruler Canvas, Background Canvas, and Scrollbar Canvas Dimensions
    this.resizeCanvas(this.scrollbarCanvasElement, this.scrollbarCanvas, this.viewerWidth, 10);
    this.resizeCanvas(this.rulerCanvasElement, this.rulerCanvas, this.viewerWidth, styles.rulerHeight);
    this.resizeCanvas(this.selectionCanvasElement, this.selectionCanvas, this.viewerWidth, this.viewerHeight);
    this.resizeCanvas(this.backgroundCanvasElement, this.backgroundCanvas, this.viewerWidth, this.viewerHeight);
    this.resizeCanvas(this.waveformsCanvasElement, this.waveformsCanvas, this.viewerWidth, this.viewerHeight);
    this.resizeCanvas(this.overlayCanvasElement, this.overlayCanvas, this.viewerWidth, this.viewerHeight);

    if (this.minZoomRatio > this.zoomRatio) {
      this.handleZoom(1, 0, 0);
    } else {
      this.updateHorizontalScrollbar();
      this.handleScrollEvent(this.pseudoScrollLeft, this.labelsScroll.scrollTop);
    }
    this.updateVerticalScrollbar();
  }

  handleScrollEvent(newScrollLeft: number, newScrollTop: number) {
    const clampedScrollLeft = Math.max(Math.min(newScrollLeft, this.maxScrollLeft), 0);
    this.pseudoScrollLeft   = clampedScrollLeft;
    this.timeScrollLeft     = this.pseudoScrollLeft * this.pixelTime;
    this.timeScrollRight    = this.timeScrollLeft + this.viewerWidthTime;
    this.updatescrollbarPositionX();

    const clampedScrollTop = Math.max(Math.min(newScrollTop, this.maxScrollTop), 0);
    if (clampedScrollTop !== this.pseudoScrollTop) {
      this.pseudoScrollTop = clampedScrollTop;
      this.updateSelectionCanvas(viewerState.selectedSignal, viewerState.lastSelectedSignal);
      this.updatescrollbarPositionY();
      this.labelsScroll.scrollTop = newScrollTop;
      this.valuesScroll.scrollTop = newScrollTop;
      dragController.contentMoved();
    }

    if (this.scrollEventPending) {return;}
    this.scrollEventPending = true;
    this.redrawViewport();
    this.scrollEventPending = false;
  }
}