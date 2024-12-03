import { vscode, NetlistData, netlistData, WaveformData, waveformData, parseValue, getValueTextWidth, valueIs9State, arrayMove, sendWebviewContext, NetlistId, SignalId, NumberFormat, ValueChange, ActionType, EventHandler, viewerState } from "./vaporview";
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
  waveformData: WaveformData[];
  netlistData: NetlistData[];

  highlightElement: any     = null;
  highlightEndEvent: any = null;
  highlightStartEvent: any = null;
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

  touchpadScrollCount: number = 0;
  scrollbarMoved: boolean      = false;
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
  updatePending: boolean       = false;
  columnsInCluster: number    = 4;
  scrollEventPending: boolean  = false;
  currentCluster      = [0, 0];
  columnWidth         = this.chunksInColumn  * this.chunkWidth;

  // Marker variables
  markerChunkIndex: number | null    = null;
  altMarkerChunkIndex: number | null = null;

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

  constructor(
    private events: EventHandler,
  ) {

    const scrollArea        = document.getElementById('scrollArea');
    const contentArea       = document.getElementById('contentArea');
    const scrollbar         = document.getElementById('scrollbar');

    if (scrollArea === null || contentArea === null || scrollbar === null) {
      throw new Error('Viewport elements not found');
    }

    this.scrollArea = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar = scrollbar;
    this.waveformData = waveformData;
    this.netlistData = netlistData;

    // click handler to handle clicking inside the waveform viewer
    // gets the absolute x position of the click relative to the scrollable content
    contentArea.addEventListener('mousedown', (e) => {this.handleScrollAreaMouseDown(e);});
    scrollbar.addEventListener('mousedown',   (e) => {this.handleScrollbarDrag(e);});


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

    //this.handleScrollEvent = this.handleScrollEvent.bind(this);
    this.handleScrollbarMove = this.handleScrollbarMove.bind(this);
    //this.updateScrollbarResize = this.updateScrollbarResize.bind(this);
    this.updateViewportWidth = this.updateViewportWidth.bind(this);
    this.handleZoom = this.handleZoom.bind(this);
    this.handleSignalSelect = this.handleSignalSelect.bind(this);
    this.handleMarkerSet = this.handleMarkerSet.bind(this);
    this.handleReorderSignals = this.handleReorderSignals.bind(this);
    this.highlightZoom = this.highlightZoom.bind(this);
    this.drawHighlightZoom = this.drawHighlightZoom.bind(this);


    this.events.subscribe(ActionType.MarkerSet, this.handleMarkerSet);
    this.events.subscribe(ActionType.SignalSelect, this.handleSignalSelect);
    this.events.subscribe(ActionType.Zoom, this.handleZoom);
    this.events.subscribe(ActionType.ReorderSignals, this.handleReorderSignals);
    //this.events.subscribe(ActionType.AddVariable, this.updateWaveformInCache);
    //this.events.subscribe(ActionType.RemoveVariable, this.updateWaveformInCache);
    //this.events.subscribe(ActionType.Scroll, this.handleScrollEvent);
    //this.events.subscribe(ActionType.RedrawVariable, this.updateWaveformInCache);
    this.events.subscribe(ActionType.Resize, this.updateViewportWidth);
  }

  // This function actually creates the individual bus elements, and has can
  // potentially called thousands of times during a render
  busElement(time: number, deltaTime: number, displayValue: string, spansChunk: boolean, textWidth: number, leftOverflow: number, rightOverflow: number) {
    let pElement           = '';
    let justifyDirection   = '';
    let textOffset         = 0;
    const totalWidth       = deltaTime * this.zoomRatio; 
    let flexWidthOverflow  = 0;
    //const characterWidth   = 7.69;
  
    if (totalWidth > textWidth) {
      justifyDirection = 'justify-content: center';
    }
    //else {
      //let slice = charCount - Math.max(0, (Math.floor(totalWidth / characterWidth) - 1));
      //displayValue = '*' + displayValue.slice(slice);
    //}
  
    // If the element spans the chunk boundary, we need to center the text
    if (spansChunk) {
      justifyDirection  = 'justify-content: center';
      if (totalWidth < textWidth) {
        textOffset = ((totalWidth - textWidth) / 2) - 5;
      }
      textOffset       += ((leftOverflow + rightOverflow) / 2) * this.zoomRatio;
      flexWidthOverflow = rightOverflow - leftOverflow;
    }
  
    const flexWidth    = deltaTime - flexWidthOverflow;
    const elementWidth = flexWidth * this.zoomRatio;
  
    // If the element is too wide to fit in the viewer, we need to display
    // the value in multiple places so it's always in sight
    if (totalWidth > this.viewerWidth) {
      // count the number of text elements that will be displayed 1 viewer width or 1 text width + 20 px (whichever is greater) in this state
      const renderInterval = Math.max(this.viewerWidth, textWidth + 20);
      const textCount      = 1 + Math.floor((totalWidth - textWidth) / renderInterval);
      // figure out which ones are in the chunk and where they are relative to the chunk boundary
      const firstOffset    = Math.min(time * this.zoomRatio, 0) + ((totalWidth - ((textCount - 1) * renderInterval)) / 2);
      const lowerBound     = -0.5 * (textWidth + elementWidth);
      const upperBound     =  0.5 * (textWidth + elementWidth);
      let textPosition   = firstOffset - (0.5 * elementWidth);
      const offsetStart    = Math.floor((lowerBound - firstOffset) / renderInterval);
  
      for (let i = offsetStart; i < textCount; i++) {
        if (textPosition >= lowerBound) {
          if (textPosition > upperBound) {break;}
          pElement += `<p style="left:${textPosition}px">${displayValue}</p>`;
        }
        textPosition += renderInterval;
      }
    } else {
      pElement = `<p style="left:${textOffset}px">${displayValue}</p>`;
    }
    
    const divTag  = `<div class="bus-waveform-value" style="flex:${flexWidth};${justifyDirection}">`;
    return `${divTag}${pElement}</div>`;
  }

  busElementsfromTransitionData(transitionData: ValueChange[], initialState: ValueChange, postState: ValueChange, signalWidth: number, textWidth: number, numberFormat: NumberFormat) {

    let elementWidth;
    let is4State        = false;
    let value           = initialState[1];
    let time            = initialState[0];
    let emptyDivWidth   = 0;
    let xPosition       = 0;
    let yPosition       = 0;
    const points          = [time + ',0'];
    const endPoints       = [time + ',0'];
    const xzValues: string[]        = [];
    let textElements: string    = '';
    let spansChunk      = true;
    let moveCursor      = false;
    let drawBackgroundStrokes = false;
    const minTextWidth  = 12 / this.zoomRatio;
    const minDrawWidth  = 1 / this.zoomRatio;
    let leftOverflow    = Math.min(initialState[0], 0);
    const rightOverflow = Math.max(postState[0] - this.columnTime, 0);

    for (let i = 0; i < transitionData.length; i++) {

      elementWidth = transitionData[i][0] - time;

      // If the element is too small to draw, we need to skip it
      if (elementWidth > minDrawWidth) {

        if (moveCursor) {
          points.push(time + ',0');
          endPoints.push(time + ',0');
          moveCursor = false;
        }

        is4State     = valueIs9State(value);
        xPosition    = (elementWidth / 2) + time;
        yPosition    =  elementWidth * 2;
        if (is4State) {
          xzValues.push(`<polyline fill="var(--vscode-debugTokenExpression-error)" points="${time},0 ${xPosition},${yPosition} ${transitionData[i][0]},0 ${xPosition},-${yPosition}"/>`);
        } else {
          points.push(xPosition + ',' + yPosition);
          endPoints.push(xPosition + ',-' + yPosition);
        }

        // Don't even bother rendering text if the element is too small. Since 
        // there's an upper limit to the number of larger elements that will be 
        // displayed, we can spend a little more time rendering them and making them
        // readable in all cases.
        // We group the empty text elements that are too small to render together to
        // reduce the number of DOM operations
        if (elementWidth > minTextWidth) {
          if (emptyDivWidth > 0) {
            textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
          }
          emptyDivWidth = 0;
          textElements += this.busElement(time, elementWidth, parseValue(value, signalWidth, is4State, numberFormat), spansChunk, textWidth, leftOverflow, 0);
        } else {
          emptyDivWidth += elementWidth + leftOverflow;
        }

        points.push(transitionData[i][0] + ',0');
        endPoints.push(transitionData[i][0] + ',0');
      } else {
        emptyDivWidth += elementWidth + leftOverflow;
        drawBackgroundStrokes = true;
        moveCursor = true;
      }

      time         = transitionData[i][0];
      value        = transitionData[i][1];
      spansChunk   = false;
      leftOverflow = 0;
    }

    elementWidth = postState[0] - time;

    if (elementWidth > minDrawWidth) {

      if (moveCursor) {
        points.push(time + ',0');
        endPoints.push(time + ',0');
        moveCursor = false;
      }

      xPosition    = (elementWidth / 2) + time;
      is4State     = valueIs9State(value);
      if (is4State) {
        xzValues.push(`<polyline fill="var(--vscode-debugTokenExpression-error)" points="${time},0 ${xPosition},${elementWidth * 2} ${postState[0]},0 ${xPosition},-${elementWidth * 2}"/>`);
      } else {
        points.push(xPosition + ',' + elementWidth * 2);
        points.push(postState[0] + ',0');
        endPoints.push(xPosition + ',-' + elementWidth * 2);
      }
    }

    if (elementWidth > minTextWidth) {
      if (emptyDivWidth > 0) {
        textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
      }
      emptyDivWidth = 0;
      textElements += this.busElement(time, elementWidth, parseValue(value, signalWidth, is4State, numberFormat), true, textWidth, leftOverflow, rightOverflow);
    } else {
      emptyDivWidth += elementWidth + leftOverflow - rightOverflow;
      textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
    }

    const polyline      = points.concat(endPoints.reverse()).join(' ');
    const svgHeight   = 20;
    const gAttributes = `stroke="none" transform="scale(${this.zoomRatio})"`;
    const polylineAttributes = `fill="var(--vscode-debugTokenExpression-number)"`;
    let backgroundStrokes = "";
    if (drawBackgroundStrokes) {
      backgroundStrokes += `<polyline points="0,0 ${this.columnTime},0" stroke="var(--vscode-debugTokenExpression-number)" stroke-width="3px" stroke-opacity="40%" vector-effect="non-scaling-stroke"/>`;
      backgroundStrokes += `<polyline points="0,0 ${this.columnTime},0" stroke="var(--vscode-debugTokenExpression-number)" stroke-width="1px" stroke-opacity="80%" vector-effect="non-scaling-stroke"/>`;
    }
    let result = '';
    result += `<svg height="${svgHeight}" width="${this.columnWidth}" viewbox="0 -10 ${this.columnWidth} ${svgHeight}" class="bus-waveform-svg">`;
    result += `<g ${gAttributes}>${backgroundStrokes}<polyline ${polylineAttributes} points="${polyline}"/>${xzValues.join("")}</g></svg>`;
    result += textElements;

    return result;
  }

  polylinePathFromTransitionData(transitionData: ValueChange[], initialState: ValueChange, postState: ValueChange, polylineAttributes: any) {
    const xzPolylines: string[]        = [];
    let initialValue       = initialState[1];
    let initialValue2state = initialValue;
    let initialTime        = initialState[0];
    let initialTimeOrStart = Math.max(initialState[0], -10);
    const minDrawWidth     = 1 / this.zoomRatio;
    let xzAccumulatedPath = "";

    if (valueIs9State(initialValue)) {
      xzAccumulatedPath = "0,0 0,1 ";
      initialValue2state = "0";
    }
    const accumulatedPath    = ["0," + initialValue2state];

    let value2state    = "0";
    // No Draw Code
    let lastDrawTime   = 0;
    let lastNoDrawTime: any = null;
    let noDrawFlag     = false;
    const noDrawPath: string[]     = [];
    let lastDrawValue  = initialValue2state;
    let lastnoDrawValue: any = null;

    transitionData.forEach(([time, value]) => {
      let xzPath = "";

      if (time - initialTime < minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
        lastnoDrawValue = value;
      } else {

        if (noDrawFlag) {
          initialValue2state = initialValue;
          if (valueIs9State(initialValue)) {initialValue2state = "0";}

          noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + lastNoDrawTime + ",1 " + lastNoDrawTime + ",0 ");
          accumulatedPath.push(lastDrawTime + "," + 0);
          accumulatedPath.push(lastNoDrawTime + "," + 0);
          //accumulatedPath.push(lastNoDrawTime + "," + lastDrawValue);
          accumulatedPath.push(lastNoDrawTime + "," + initialValue2state);
          noDrawFlag = false;
        }

        if (valueIs9State(initialValue)) {
          xzPath = `${initialTimeOrStart},0 ${time},0 ${time},1 ${initialTimeOrStart},1`;
          if (initialTimeOrStart >= 0) {
            xzPath += ` ${initialTimeOrStart},0`;
          }
          xzPolylines.push(`<polyline points="${xzPath}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
        }

        value2state = value;
        if (valueIs9State(value)) {value2state =  "0";}

        // Draw the current transition to the main path
        accumulatedPath.push(time + "," + initialValue2state);
        accumulatedPath.push(time + "," + value2state);

        lastDrawValue      = value2state;
        lastDrawTime       = time;
        initialValue2state = value2state;
      }

      initialValue       = value;
      initialTimeOrStart = time;
      initialTime        = time;
    });

    initialValue2state = initialValue;
    if (valueIs9State(initialValue)) {initialValue2state = "0";}

    if (postState[0] - initialTime < minDrawWidth) {

        noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + this.columnTime + ",1 " + this.columnTime + ",0 ");
        accumulatedPath.push(lastDrawTime + ",0");
        accumulatedPath.push(this.columnTime + ",0");
        //accumulatedPath.push(this.columnTime + "," + lastDrawValue);
    } else {

      if (noDrawFlag) {

        noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + lastNoDrawTime + ",1 " + lastNoDrawTime + ",0 ");
        accumulatedPath.push(lastDrawTime + "," + 0);
        accumulatedPath.push(lastNoDrawTime + "," + 0);
        //accumulatedPath.push(lastNoDrawTime + "," + lastDrawValue);
        accumulatedPath.push(lastNoDrawTime + "," + initialValue2state);
      }

      if (valueIs9State(initialValue))  {

        if (initialTimeOrStart >= 0) {
          xzPolylines.push(`<polyline points="${this.columnTime},1 ${initialTimeOrStart},1 ${initialTimeOrStart},0 ${this.columnTime},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
        } else {
          xzPolylines.push(`<polyline points="${initialTimeOrStart},0 ${this.columnTime},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
          xzPolylines.push(`<polyline points="${initialTimeOrStart},1 ${this.columnTime},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
        }
      }
    }

    accumulatedPath.push(this.columnTime + "," + initialValue2state);

    const polylinePath = accumulatedPath.join(" ");
    const polyline     = `<polyline points="` + polylinePath + `" ${polylineAttributes}/>`;
    const noDraw       = `<polygon points="${noDrawPath}" stroke="none" fill="var(--vscode-debugTokenExpression-number)"/>`;
    const shadedArea   = `<polygon points="0,0 ${polylinePath} ${this.columnTime},0" stroke="none" fill="var(--vscode-debugTokenExpression-number)" fill-opacity="0.1"/>`;
    return polyline + shadedArea + noDraw + xzPolylines.join('');
  }

  binaryElementFromTransitionData(transitionData: ValueChange[], initialState: ValueChange, postState: ValueChange) {
    const svgHeight  = 20;
    const waveHeight = 16;
    const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
    const polylineAttributes = `stroke="var(--vscode-debugTokenExpression-number)"`;
    const gAttributes = `fill="none" transform="translate(0.5 ${waveOffset}.5) scale(${this.zoomRatio} -${waveHeight})"`;
    let result = '';
    result += `<svg height="${svgHeight}" width="${this.columnWidth}" viewbox="0 0 ${this.columnWidth} ${svgHeight}" class="binary-waveform-svg">`;
    result += `<g ${gAttributes}>`;
    result += this.polylinePathFromTransitionData(transitionData, initialState, postState, polylineAttributes);
    result += `</g></svg>`;
    return result;
  }

  createWaveformSVG(transitionData: ValueChange[], initialState: ValueChange, postState: ValueChange, width: number, chunkIndex: number, netlistId: NetlistId, textWidth: number) {
    let   className     = 'waveform-chunk';
    const vscodeContext = this.netlistData[netlistId].vscodeContext;
    if (netlistId === viewerState.selectedSignal) {className += ' is-selected';}
    if (width === 1) {
      return `<div class="${className}" id="idx${chunkIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}>
      ${this.binaryElementFromTransitionData(transitionData, initialState, postState)}
      </div>`;
    } else {
      const numberFormat  = this.netlistData[netlistId].numberFormat;
      return `<div class="${className}" id="idx${chunkIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}>
                ${this.busElementsfromTransitionData(transitionData, initialState, postState, width, textWidth, numberFormat)}
              </div>`;
    }
  }

  renderWaveformChunk(netlistId: NetlistId, chunkStartIndex: number) {
    const result: any         = {};
    const signalId     = this.netlistData[netlistId].signalId;
    const data         = this.waveformData[signalId];

    if (!data) {
      const vscodeContext = this.netlistData[netlistId].vscodeContext;
      return {html: `<div class="waveform-chunk" id="idx${chunkStartIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}></div>`};
    }

    const timeStart    = chunkStartIndex * this.chunkTime;
    const timeEnd      = timeStart + this.columnTime;
    const width        = data.signalWidth;
    const startIndex   = data.chunkStart[chunkStartIndex];
    const endIndex     = data.chunkStart[chunkStartIndex + this.chunksInColumn];
    const initialState = data.transitionData[startIndex - 1];
    const textWidth    = data.textWidth;

    let postState: ValueChange;
    if (chunkStartIndex >= data.chunkStart.length - this.chunksInColumn) {
      postState  = [timeEnd, data.transitionData[data.transitionData.length - 1][1]];
    } else {
      postState  = data.transitionData[endIndex];
    }
    const relativeInitialState: ValueChange = [initialState[0] - timeStart, initialState[1]];
    const relativePostState: ValueChange    = [postState[0]    - timeStart, postState[1]];
    //let chunkTransitionData    = [];
    //for (let i = startIndex; i < endIndex; i++) {
    //  const [time, value] = data.transitionData[i];
    //  chunkTransitionData.push([time - timeStart, value]);
    //}

    const chunkTransitionData: ValueChange[] = data.transitionData.slice(startIndex, endIndex).map(([time, value]) => {
      return [time - timeStart, value] as ValueChange;
    });

    result.html = this.createWaveformSVG(chunkTransitionData, relativeInitialState, relativePostState, width, chunkStartIndex, netlistId, textWidth);
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
    let textElements       = '';

    for (let i = numberStartpixel; i <= this.columnWidth + 64; i+= this.rulerNumberSpacing ) {
      textElements += `<text x="${i}" y="20">${numValue * this.timeScale}</text>`;
      numValue += timeMarkerInterval;
    }

    return `
      <div class="ruler-chunk">
        <svg height="40" width="${this.columnWidth}" class="ruler-svg">
        <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${this.columnWidth}" y2="32.5"/>
          ${textElements}</svg></div>`;
  }

  // This function creates ruler elements for a chunk
  createRulerElement(chunkStartIndex: number) {
    const timeMarkerInterval = this.rulerNumberSpacing / this.zoomRatio;
    const chunkStartTime     = chunkStartIndex * this.chunkTime;
    const chunkStartPixel    = chunkStartIndex * this.chunkWidth;
    const numberStartpixel   = -1 * (chunkStartPixel % this.rulerNumberSpacing);
    const tickStartpixel     = this.rulerTickSpacing - (chunkStartPixel % this.rulerTickSpacing) - this.rulerNumberSpacing;
    const totalWidth         = this.columnWidth * this.columnsInCluster;
    let   numValue           = chunkStartTime + (numberStartpixel / this.zoomRatio);
    const textElements: string[] = [];

    for (let i = numberStartpixel; i <= totalWidth + 64; i+= this.rulerNumberSpacing ) {
      textElements.push(`<text x="${i}" y="20">${numValue * this.timeScale}</text>`);
      numValue += timeMarkerInterval;
    }

    return `
      <div class="ruler-chunk">
        <svg height="40" width="${totalWidth}" class="ruler-svg">
        <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${totalWidth}" y2="32.5"/>
          ${textElements.join('')}</svg></div>`;
  }

  createTimeMarker(time: number, markerType: number) {
    const x  = (time % this.columnTime) * this.zoomRatio;
    const id = markerType === 0 ? 'main-marker' : 'alt-marker';
    return `
      <svg id="${id}" class="time-marker" style="left:${x}px">
        <line x1="0" y1="0" x2="0" y2="100%"/>
      </svg>`;
  }



  updateWaveformInCache(netlistIdList: NetlistId[]) {
    netlistIdList.forEach((netlistId) => {
      const signalId = this.netlistData[netlistId].signalId;
      for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
        this.dataCache.columns[i].waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, i);
      }
      if (viewerState.markerTime !== null) {
        this.dataCache.valueAtMarker[signalId] = this.getValueAtTime(signalId, viewerState.markerTime);
      }
    });
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      this.parseHtmlInChunk(i);
    }
  }

  // Event handler helper functions
  updateChunkInCache(chunkIndex: number) {

    const result = {
      rulerChunk:    this.createRulerChunk(chunkIndex),
      waveformChunk: {} as { [key: string]: any },
      marker:        [],
      altMarker:     [],
    };

    viewerState.displayedSignals.forEach((netlistId: NetlistId) => {
      result.waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, chunkIndex);
    });

    return result;
  }

  // Experimental asynchronous rendering path
  async renderWaveformsAsync(node: any, chunkIndex: number) {
    this.updatePending       = true;
    const chunkData: any       = [];
    const chunkElements: any[] = [];
    const orderedElements: any[] = [];

    try {

      // Render each waveform chunk asynchronously
      for (const netlistId of viewerState.displayedSignals) {
        //let signalId = netlistData[netlistId].signalId;
        // Check the abort flag at the start of each iteration
        if (this.dataCache.columns[chunkIndex].abortFlag) {continue;}

        // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
        await new Promise<void>(resolve => requestAnimationFrame(() => {
          chunkData[netlistId]     = this.renderWaveformChunk(netlistId, chunkIndex);
          chunkElements[netlistId] = domParser.parseFromString(chunkData[netlistId].html, 'text/html').body.firstChild;
          //if (!this.dataCache.columns[chunkIndex]) {console.log(chunkIndex);}
          resolve();
        }));
      }

      if (!this.dataCache.columns[chunkIndex].abortFlag) {
        this.dataCache.columns[chunkIndex].waveformChunk = chunkData;
      }

      // Update the DOM in the next animation frame
      await new Promise<void>(resolve => requestAnimationFrame(() => {
        viewerState.displayedSignals.forEach((netlistId: NetlistId) => {orderedElements.push(chunkElements[netlistId]);});
        const domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + this.chunksInColumn);
        if (domRef && !this.dataCache.columns[chunkIndex].abortFlag) { // Always check if the element still exists
          domRef.replaceChildren(...orderedElements);
          node.classList.remove('rendering-chunk');
        }
        resolve();
      }));

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
    let overlays  = '';
    let waveforms = "";
    let shallowChunkClass = "";
    const idTag = `${chunkIndex}-${this.chunksInColumn}`;
    if (this.dataCache.columns[chunkIndex].waveformChunk) {
      waveforms = viewerState.displayedSignals.map((signal) => {return this.dataCache.columns[chunkIndex].waveformChunk[signal].html;}).join('');
    } else {
      shallowChunkClass = " shallow-chunk";
    }

    const columnIndex = Math.floor(chunkIndex / this.chunksInColumn);

    if (viewerState.markerTime !== null && this.markerChunkIndex !== null && columnIndex === Math.floor(this.markerChunkIndex / this.chunksInColumn))    {overlays += this.createTimeMarker(viewerState.markerTime, 0);}
    if (viewerState.altMarkerTime !== null && this.altMarkerChunkIndex !== null && columnIndex === Math.floor(this.altMarkerChunkIndex / this.chunksInColumn)) {overlays += this.createTimeMarker(viewerState.altMarkerTime, 1);}

    const result = `<div class="column-chunk${shallowChunkClass}" id="column-${idTag}" style="width:${this.columnWidth}px">
    ${this.dataCache.columns[chunkIndex].rulerChunk}
    <div class="waveform-column" id="waveform-column-${idTag}" style="font-family:monospaced">
    ${waveforms}
    </div>
    ${overlays}
    </div>`;

    this.dataCache.columns[chunkIndex].element        = domParser.parseFromString(result, 'text/html').body.firstChild;
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
      if (!this.dataCache.columns[chunkIndex].element) {
        this.parseHtmlInChunk(chunkIndex);
      }
      returnData.push(this.dataCache.columns[chunkIndex].element);
    }

    return returnData;
  }

  getNearestTransitionIndex(signalId: SignalId, time: number) {

    if (time === null) {return -1;}
  
    let endIndex;
    const data        = this.waveformData[signalId];
    const chunk       = Math.floor(time / this.chunkTime);
    const startIndex  = Math.max(0, data.chunkStart[chunk] - 1);
    if (chunk === this.chunkCount - 1) {
      endIndex    = data.transitionData.length;
    } else {
      endIndex    = data.chunkStart[chunk + 1] + 1;
    }
    const searchIndex = data.transitionData.slice(startIndex, endIndex).findIndex(([t, v]) => {return t >= time;});
    const transitionIndex = startIndex + searchIndex;
  
    if (searchIndex === -1) {
      console.log('search found a -1 index');
      return -1;
    }
  
    return transitionIndex;
  }

  getValueAtTime(signalId: SignalId, time: number) {
  
    const result: string[] = [];
    const data = this.waveformData[signalId];
  
    if (!data) {return result;}
  
    const transitionData  = data.transitionData;
    const transitionIndex = this.getNearestTransitionIndex(signalId, time);
  
    if (transitionIndex === -1) {return result;}
    if (transitionIndex > 0) {
      result.push(transitionData[transitionIndex - 1][1]);
    }
  
    if (transitionData[transitionIndex][0] === time) {
      result.push(transitionData[transitionIndex][1]);
    }
  
    return result;
  }
  
  getNearestTransition(signalId: SignalId, time: number) {
  
    const result = null;
    if (time === null) {return result;}
    
    const data  = this.waveformData[signalId].transitionData;
    const index = this.getNearestTransitionIndex(signalId, time);
    
    if (index === -1) {return result;}
    if (data[index][0] === time) {
      return data[index];
    }
  
    const timeBefore = time - data[index - 1][0];
    const timeAfter  = data[index][0] - time;
  
    if (timeBefore < timeAfter) {
      return data[index - 1];
    } else {
      return data[index];
    }
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
    const chunksInCluster  = Math.max(Math.ceil((this.viewerWidth + 1000) / this.chunkWidth), 2);
    this.chunksInColumn         = 4 ** (Math.max(0,(Math.floor(Math.log2(chunksInCluster) / 2) - 1)));
    this.columnWidth            = this.chunkWidth * this.chunksInColumn;
    this.columnsInCluster       = Math.max(Math.ceil((this.viewerWidth / this.columnWidth) * 2), 2);
    this.columnTime             = this.chunkTime * this.chunksInColumn;

    //console.log('chunks in cluster: ' + chunksInCluster + '; chunks in column: ' + this.chunksInColumn + '; column width: ' + this.columnWidth + '; blocks in cluster: ' + this.columnsInCluster + '');
  }

  getBlockNum() {
    const blockNum     = (this.pseudoScrollLeft + this.halfViewerWidth) / this.columnWidth;
    const minColumnNum = Math.max(Math.round(blockNum - (this.columnsInCluster / 2)), 0) * this.chunksInColumn;
    const maxColumnNum = Math.min(Math.round(blockNum + (this.columnsInCluster / 2)) * this.chunksInColumn, this.chunkCount);

    //console.log('min column number: ' + minColumnNum + '; max column number: ' + maxColumnNum + '');
    return [minColumnNum, maxColumnNum];
  }

  updateContentArea(oldLeftOffset: number, cluster: number[]) {
    const leftHidden = this.chunkWidth * cluster[0];
    if (this.updatePending || leftHidden !== oldLeftOffset) {
      const newColumns       = this.shallowFetchColumns(cluster[0], cluster[1]);
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
    const bounds      = this.contentArea.getBoundingClientRect();
    const pixelLeft   = Math.round(event.pageX - bounds.left);
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

      const signalId = netlistData[netlistId].signalId;

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = this.getNearestTransition(signalId, time);

      if (nearestTransition === null) {return;}

      const nearestTime       = nearestTransition[0];
      const pixelDistance     = Math.abs(nearestTime - time) * this.zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
    }

    this.events.dispatch(ActionType.MarkerSet, snapToTime, button);
  }

  updateScrollbarResize() {
    this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.timeStop * this.zoomRatio)), 17);
    //this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.chunkCount * chunkWidth)), 17);
    this.maxScrollbarPosition  = Math.max(this.viewerWidth - this.scrollbarWidth, 0);
    this.updateScrollBarPosition();
    this.scrollbar.style.width = this.scrollbarWidth + 'px';
  }
  
  updateScrollBarPosition() {
    this.scrollbarPosition       = Math.round((this.pseudoScrollLeft / this.maxScrollLeft) * this.maxScrollbarPosition);
    this.scrollbar.style.display = this.maxScrollLeft === 0 ? 'none' : 'block';
    this.scrollbar.style.left    = this.scrollbarPosition + 'px';
  }

  handleScrollbarDrag(event: MouseEvent) {
    event.preventDefault();
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
    const style       = `left: ${elementLeft}px; width: ${width}px; height: ${this.contentArea.style.height};`;
  
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
    this.scrollbarStartX              = e.clientX;
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
        viewerState.markerTime         = null;
        this.markerChunkIndex   = null;
      } else {
        viewerState.altMarkerTime         = null;
        this.altMarkerChunkIndex   = null;
      }
      return;
    }

    // first find the chunk with the marker
    chunkIndex   = Math.floor(time / this.chunkTime);

    // create new marker
    if (chunkIndex >= this.dataCache.startIndex && chunkIndex < this.dataCache.endIndex + this.chunksInColumn) {
      const clusterIndex = Math.floor((chunkIndex - this.dataCache.startIndex) / this.chunksInColumn);
      const chunkElement   = this.contentArea.getElementsByClassName('column-chunk')[clusterIndex];
      const marker         = domParser.parseFromString(this.createTimeMarker(time, markerType), 'text/html').body.firstChild;

      if (marker) {chunkElement.appendChild(marker);}

      //console.log('adding marker at time ' + time + ' from chunk ' + chunkIndex + '');
    } else {
      //console.log('chunk index ' + chunkIndex + ' is not in cache');
    }

    if (markerType === 0) {
      viewerState.markerTime            = time;
      this.markerChunkIndex      = chunkIndex;

      viewerMoved = this.moveViewToTime(time);

    } else {
      viewerState.altMarkerTime           = time;
      this.altMarkerChunkIndex   = chunkIndex;
    }

  }

  handleSignalSelect(netlistId: NetlistId | null) {
    if (netlistId === null) {return;}
    if (viewerState.selectedSignal === null) {return;}
  
    let element;
    let index;
  
    for (let i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      element = document.getElementById('idx' + i + '-' + this.chunksInColumn + '--' + viewerState.selectedSignal);
      if (element) {
        element.classList.remove('is-selected');
        this.dataCache.columns[i].waveformChunk[viewerState.selectedSignal].html = element.outerHTML;
      }
  
      element = document.getElementById('idx' + i + '-' + this.chunksInColumn + '--' + netlistId);
      if (element) {
        element.classList.add('is-selected');
        this.dataCache.columns[i].waveformChunk[netlistId].html = element.outerHTML;
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
    //this.maxScrollLeft    = Math.round(Math.max((chunkCount * this.chunkWidth) - this.viewerWidth, 0));
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

  updateViewportWidth() {
    this.viewerWidth     = this.scrollArea.getBoundingClientRect().width;
    this.halfViewerWidth = this.viewerWidth / 2;
    this.maxScrollLeft   = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    //this.maxScrollLeft   = Math.round(Math.max((this.chunkCount * chunkWidth) - this.viewerWidth, 0));
    this.updateScrollbarResize();
  }
}