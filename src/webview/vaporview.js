/* eslint-disable no-undef */
(function () {
const vscode = acquireVsCodeApi();

// Search handler variables
searchState         = 0;
searchInFocus       = false;

// Data formatting variables
bitChunkWidth       = 4;

// drag handler variables
labelsList            = [];
idleItems             = [];
draggableItem         = null;
draggableItemIndex    = null;
draggableItemNewIndex = null;
pointerStartX         = null;
pointerStartY         = null;
resizeIndex           = null;

resizeDebounce       = 0;
highlightElement     = null;
highlightDebounce    = null;
highlightListenerSet = false;
mouseupEventType     = null;
touchpadScrolling    = false;

// Marker and signal selection variables
markerTime          = null;
markerChunkIndex    = undefined;
altMarkerTime       = null;
altMarkerChunkIndex = undefined;
selectedSignal      = null;
selectedSignalIndex = null;

// Data variables
contentData         = [];
displayedSignals    = [];
waveformData        = {};
netlistData         = {};
waveformDataTemp    = {};

waveDromClock = {
  netlistId: null,
  edge: '1',
};
domParser           = new DOMParser();

// #region Viewport
class Viewport {
  // UI preferences
  rulerNumberSpacing = 100;
  rulerTickSpacing   = 10;

  // Scroll handler variables
  pseudoScrollLeft    = 0;
  contentLeft         = 0;
  leftOffset          = 0;
  viewerWidth         = 0;
  halfViewerWidth     = 0;
  maxScrollLeft       = 0;
  maxScrollbarPosition = 0;
  scrollbarWidth      = 17;
  scrollbarPosition   = 0;

  touchpadScrollCount = 0;
  scrollbarMoved      = false;
  scrollbarStartX     = 0;

  // Zoom level variables
  timeScale           = 1;
  chunkCount          = null;
  chunkTime           = 512;
  chunkWidth          = 512;
  zoomRatio           = 1;
  maxZoomRatio        = 64;
  chunksInColumn      = 1;
  columnTime          = this.chunkTime * this.chunksInColumn;
  timeStop            = 0;

  // Clusterize variables
  updatePending       = false;
  columnsInCluster    = 4;
  scrollEventPending  = false;
  currentCluster      = [0, 0];
  columnWidth         = this.chunksInColumn  * this.chunkWidth;

  dataCache           = {
    startIndex:     0,
    endIndex:       0,
    columns:        [],
    valueAtMarker:  {},
    updatesPending: 0,
    markerElement:  '',
    altMarkerElement: '',
  };

  constructor(scrollArea, contentArea, scrollbar) {
    this.scrollArea  = scrollArea;
    this.contentArea = contentArea;
    this.scrollbar   = scrollbar;
    this.handleScrollEvent = this.handleScrollEvent.bind(this);
    this.handleScrollbarMove = this.handleScrollbarMove.bind(this);
    this.handleScrollbarDrag = this.handleScrollbarDrag.bind(this);
    this.updateScrollbarResize = this.updateScrollbarResize.bind(this);
    this.updateViewportWidth = this.updateViewportWidth.bind(this);
  }

  // This function actually creates the individual bus elements, and has can
  // potentially called thousands of times during a render
  busElement = function(time, deltaTime, displayValue, spansChunk, textWidth, leftOverflow, rightOverflow) {
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
  
    let flexWidth    = deltaTime - flexWidthOverflow;
    let elementWidth = flexWidth * this.zoomRatio;
  
    // If the element is too wide to fit in the viewer, we need to display
    // the value in multiple places so it's always in sight
    if (totalWidth > this.viewerWidth) {
      // count the number of text elements that will be displayed 1 viewer width or 1 text width + 20 px (whichever is greater) in this state
      let renderInterval = Math.max(this.viewerWidth, textWidth + 20);
      let textCount      = 1 + Math.floor((totalWidth - textWidth) / renderInterval);
      // figure out which ones are in the chunk and where they are relative to the chunk boundary
      let firstOffset    = Math.min(time * this.zoomRatio, 0) + ((totalWidth - ((textCount - 1) * renderInterval)) / 2);
      let lowerBound     = -0.5 * (textWidth + elementWidth);
      let upperBound     =  0.5 * (textWidth + elementWidth);
      let textPosition   = firstOffset - (0.5 * elementWidth);
      let offsetStart    = Math.floor((lowerBound - firstOffset) / renderInterval);
  
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
  };

  busElementsfromTransitionData = function (transitionData, initialState, postState, signalWidth, textWidth, numberFormat) {

    let elementWidth;
    let is4State;
    let value           = initialState[1];
    let time            = initialState[0];
    let emptyDivWidth   = 0;
    let xPosition       = 0;
    let yPosition       = 0;
    let points          = [time + ',0'];
    let endPoints       = [time + ',0'];
    let xzValues        = [];
    let textElements    = [];
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

    let polyline      = points.concat(endPoints.reverse()).join(' ');
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
  };

  polylinePathFromTransitionData = function (transitionData, initialState, postState, polylineAttributes) {
    var xzPolylines        = [];
    var initialValue       = initialState[1];
    var initialValue2state = initialValue;
    var initialTime        = initialState[0];
    var initialTimeOrStart = Math.max(initialState[0], -10);
    const minDrawWidth     = 1 / this.zoomRatio;
    var xzAccumulatedPath = "";

    if (valueIs9State(initialValue)) {
      xzAccumulatedPath = "0,0 0,1 ";
      initialValue2state = 0;
    }
    var accumulatedPath    = ["0," + initialValue2state];

    let value2state    = 0;
    // No Draw Code
    let lastDrawTime   = 0;
    let lastNoDrawTime = null;
    let noDrawFlag     = false;
    var noDrawPath     = [];
    let lastDrawValue  = initialValue2state;
    let lastnoDrawValue = null;

    transitionData.forEach(([time, value]) => {
      let xzPath = "";

      if (time - initialTime < minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
        lastnoDrawValue = value;
      } else {

        if (noDrawFlag) {
          initialValue2state = initialValue;
          if (valueIs9State(initialValue)) {initialValue2state = 0;}

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
        if (valueIs9State(value)) {value2state =  0;}

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
    if (valueIs9State(initialValue)) {initialValue2state = 0;}

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

    let polylinePath = accumulatedPath.join(" ");
    let polyline     = `<polyline points="` + polylinePath + `" ${polylineAttributes}/>`;
    let noDraw       = `<polygon points="${noDrawPath}" stroke="none" fill="var(--vscode-debugTokenExpression-number)"/>`;
    let shadedArea   = `<polygon points="0,0 ${polylinePath} ${this.columnTime},0" stroke="none" fill="var(--vscode-debugTokenExpression-number)" fill-opacity="0.1"/>`;
    return polyline + shadedArea + noDraw + xzPolylines.join('');
  };


  binaryElementFromTransitionData = function (transitionData, initialState, postState) {
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
  };

  createWaveformSVG = function (transitionData, initialState, postState, width, chunkIndex, netlistId, textWidth) {
    let   className     = 'waveform-chunk';
    const vscodeContext = netlistData[netlistId].vscodeContext;
    if (netlistId === selectedSignal) {className += ' is-selected';}
    if (width === 1) {
      return `<div class="${className}" id="idx${chunkIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}>
      ${this.binaryElementFromTransitionData(transitionData, initialState, postState)}
      </div>`;
    } else {
      const numberFormat  = netlistData[netlistId].numberFormat;
      return `<div class="${className}" id="idx${chunkIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}>
                ${this.busElementsfromTransitionData(transitionData, initialState, postState, width, textWidth, numberFormat)}
              </div>`;
    }
  };

  renderWaveformChunk = function (netlistId, chunkStartIndex) {
    var result         = {};
    const signalId     = netlistData[netlistId].signalId;
    const data         = waveformData[signalId];

    if (!data) {
      const vscodeContext = netlistData[netlistId].vscodeContext;
      return {html: `<div class="waveform-chunk" id="idx${chunkStartIndex}-${this.chunksInColumn}--${netlistId}" ${vscodeContext}></div>`};
    }

    const timeStart    = chunkStartIndex * this.chunkTime;
    const timeEnd      = timeStart + this.columnTime;
    const width        = data.signalWidth;
    const startIndex   = data.chunkStart[chunkStartIndex];
    const endIndex     = data.chunkStart[chunkStartIndex + this.chunksInColumn];
    const initialState = data.transitionData[startIndex - 1];
    const textWidth    = data.textWidth;

    let   postState;
    if (chunkStartIndex >= data.chunkStart.length - this.chunksInColumn) {
      postState  = [timeEnd, data.transitionData[data.transitionData.length - 1][1]];
    } else {
      postState  = data.transitionData[endIndex];
    }
    const relativeInitialState = [initialState[0] - timeStart, initialState[1]];
    const relativePostState    = [postState[0]    - timeStart, postState[1]];
    //let chunkTransitionData    = [];
    //for (let i = startIndex; i < endIndex; i++) {
    //  const [time, value] = data.transitionData[i];
    //  chunkTransitionData.push([time - timeStart, value]);
    //}

    var chunkTransitionData = data.transitionData.slice(startIndex, endIndex).map(([time, value]) => {
      return [time - timeStart, value];
    });

    result.html = this.createWaveformSVG(chunkTransitionData, relativeInitialState, relativePostState, width, chunkStartIndex, netlistId, textWidth);
    return result;
  };

  // This function creates ruler elements for a chunk
  createRulerChunk = function (chunkStartIndex) {
    const timeMarkerInterval = this.rulerNumberSpacing / this.zoomRatio;
    const chunkStartTime     = chunkStartIndex * this.chunkTime;
    const chunkStartPixel    = chunkStartIndex * this.chunkWidth;
    const numberStartpixel   = -1 * (chunkStartPixel % this.rulerNumberSpacing);
    const tickStartpixel     = this.rulerTickSpacing - (chunkStartPixel % this.rulerTickSpacing) - this.rulerNumberSpacing;
    var   numValue           = chunkStartTime + (numberStartpixel / this.zoomRatio);
    var   textElements       = [];

    for (var i = numberStartpixel; i <= this.columnWidth + 64; i+= this.rulerNumberSpacing ) {
      textElements.push(`<text x="${i}" y="20">${numValue * this.timeScale}</text>`);
      numValue += timeMarkerInterval;
    }

    return `
      <div class="ruler-chunk">
        <svg height="40" width="${this.columnWidth}" class="ruler-svg">
        <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${this.columnWidth}" y2="32.5"/>
          ${textElements.join('')}</svg></div>`;
  };

  // This function creates ruler elements for a chunk
  createRulerElement = function (chunkStartIndex) {
    const timeMarkerInterval = this.rulerNumberSpacing / this.zoomRatio;
    const chunkStartTime     = chunkStartIndex * this.chunkTime;
    const chunkStartPixel    = chunkStartIndex * this.chunkWidth;
    const numberStartpixel   = -1 * (chunkStartPixel % this.rulerNumberSpacing);
    const tickStartpixel     = this.rulerTickSpacing - (chunkStartPixel % this.rulerTickSpacing) - this.rulerNumberSpacing;
    const totalWidth         = this.columnWidth * this.columnsInCluster;
    var   numValue           = chunkStartTime + (numberStartpixel / this.zoomRatio);
    var   textElements       = [];

    for (var i = numberStartpixel; i <= totalWidth + 64; i+= this.rulerNumberSpacing ) {
      textElements.push(`<text x="${i}" y="20">${numValue * this.timeScale}</text>`);
      numValue += timeMarkerInterval;
    }

    return `
      <div class="ruler-chunk">
        <svg height="40" width="${totalWidth}" class="ruler-svg">
        <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${totalWidth}" y2="32.5"/>
          ${textElements.join('')}</svg></div>`;
  };

  createTimeMarker = function (time, markerType) {
    const x  = (time % this.columnTime) * this.zoomRatio;
    const id = markerType === 0 ? 'main-marker' : 'alt-marker';
    return `
      <svg id="${id}" class="time-marker" style="left:${x}px">
        <line x1="0" y1="0" x2="0" y2="100%"/>
      </svg>`;
  };

  getValueTextWidth = function (width, numberFormat) {
    const characterWidth = 7.69;
    let   numeralCount;
    let   underscoreCount;

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
  };

  updateWaveformInCache = function (netlistIdList) {
    netlistIdList.forEach((netlistId) => {
      const signalId = netlistData[netlistId].signalId;
      for (var i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
        this.dataCache.columns[i].waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, i);
      }
      this.dataCache.valueAtMarker[signalId] = getValueAtTime(signalId, markerTime);
    });
    for (var i = this.dataCache.startIndex; i < this.dataCache.endIndex; i+=this.chunksInColumn) {
      this.parseHtmlInChunk(i);
    }
  };

  // Event handler helper functions
  updateChunkInCache = function (chunkIndex) {

    let result = {
      rulerChunk:    this.createRulerChunk(chunkIndex),
      waveformChunk: {},
      marker:        [],
      altMarker:     [],
    };

    displayedSignals.forEach((netlistId) => {
      result.waveformChunk[netlistId] = this.renderWaveformChunk(netlistId, chunkIndex);
    });

    return result;
  };


  // Event handler helper functions
  handleZoom = function (amount, zoomOrigin, screenPosition) {
    // -1 zooms in, +1 zooms out
    // zoomRatio is in pixels per time unit
    if (this.updatePending) {return;}
    if (amount === 0) {return;}

    let newZoomRatio  = this.zoomRatio * Math.pow(2, (-1 * amount));
    this.touchpadScrollCount = 0;
    
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
  };

  // Experimental asynchronous rendering path
  renderWaveformsAsync = async function (node, chunkIndex) {
    this.updatePending       = true;
    let chunkData       = {};
    let chunkElements   = {};
    let orderedElements = [];

    try {

      // Render each waveform chunk asynchronously
      for (let netlistId of displayedSignals) {
        //let signalId = netlistData[netlistId].signalId;
        // Check the abort flag at the start of each iteration
        if (this.dataCache.columns[chunkIndex].abortFlag) {continue;}

        // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
        await new Promise(resolve => requestAnimationFrame(() => {
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
      await new Promise(resolve => requestAnimationFrame(() => {
        displayedSignals.forEach((netlistId) => {orderedElements.push(chunkElements[netlistId]);});
        let domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + this.chunksInColumn);
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
  };

  handleUpdatePending = function () {
    if (this.dataCache.updatesPending === 0) {
      //console.log('all updates are done, running garbage collection');
      this.updatePending = false;
      this.garbageCollectChunks();
    }
  };

  flagDeleteChunk = function (chunkIndex) {

    if (!this.dataCache.columns[chunkIndex]) {return;}
    this.dataCache.columns[chunkIndex].abortFlag = true;

    if (this.dataCache.updatesPending === 0) {
      this.dataCache.columns[chunkIndex] = undefined;
    }
  };

  garbageCollectChunks = function () {
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
  };

  uncacheChunks = function (startIndex, endIndex, deleteChunk) {

    for (let i = this.dataCache.startIndex; i < startIndex; i++) {
      this.flagDeleteChunk(i);
    }
    for (let i = this.dataCache.endIndex - 1; i >= endIndex; i-=1) {
      this.flagDeleteChunk(i);
    }
  };

  updateChunkInCacheShallow = function (chunkIndex) {

    if (this.dataCache.columns[chunkIndex]) {
      this.dataCache.columns[chunkIndex].abortFlag = false;
      //console.log('chunk ' + chunkIndex + ' is already in cache');
      return;
    }

    let result = {
      rulerChunk:    this.createRulerChunk(chunkIndex),
      marker:        [],
      altMarker:     [],
      abortFlag:     false,
      isSafeToRemove: false,
      element:       undefined,
    };

    this.dataCache.columns[chunkIndex] = result;
  };

  parseHtmlInChunk = function (chunkIndex) {
    let overlays  = '';
    let waveforms = "";
    let shallowChunkClass = "";
    let idTag = `${chunkIndex}-${this.chunksInColumn}`;
    if (this.dataCache.columns[chunkIndex].waveformChunk) {
      waveforms = displayedSignals.map((signal) => {return this.dataCache.columns[chunkIndex].waveformChunk[signal].html;}).join('');
    } else {
      shallowChunkClass = " shallow-chunk";
    }

    if (Math.floor(chunkIndex / this.chunksInColumn) === Math.floor(this.markerChunkIndex / this.chunksInColumn))    {overlays += this.createTimeMarker(markerTime, 0);}
    if (Math.floor(chunkIndex / this.chunksInColumn) === Math.floor(this.altMarkerChunkIndex / this.chunksInColumn)) {overlays += this.createTimeMarker(altMarkerTime, 1);}

    let result = `<div class="column-chunk${shallowChunkClass}" id="column-${idTag}" style="width:${this.columnWidth}px">
    ${this.dataCache.columns[chunkIndex].rulerChunk}
    <div class="waveform-column" id="waveform-column-${idTag}" style="font-family:monospaced">
    ${waveforms}
    </div>
    ${overlays}
    </div>`;

    this.dataCache.columns[chunkIndex].element        = domParser.parseFromString(result, 'text/html').body.firstChild;
    this.dataCache.columns[chunkIndex].isSafeToRemove = true;
  };

  shallowFetchColumns = function (startIndex, endIndex) {

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

    let returnData = [];

    for (var chunkIndex = startIndex; chunkIndex < endIndex; chunkIndex+=this.chunksInColumn) {
      //if (!this.dataCache.columns[chunkIndex]) {console.log('chunk ' + chunkIndex + ' is undefined');}
      if (!this.dataCache.columns[chunkIndex].element) {
        this.parseHtmlInChunk(chunkIndex);
      }
      returnData.push(this.dataCache.columns[chunkIndex].element);
    }

    return returnData;
  };

  // ----------------------------------------------------------------------------
  // Modified Clusterize code
  // ----------------------------------------------------------------------------
  handleScrollEvent = function(newScrollLeft) {
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
  };

  getChunksWidth = function() {
    const chunksInCluster  = Math.max(Math.ceil((this.viewerWidth + 1000) / this.chunkWidth), 2);
    this.chunksInColumn         = 4 ** (Math.max(0,(Math.floor(Math.log2(chunksInCluster) / 2) - 1)));
    this.columnWidth            = this.chunkWidth * this.chunksInColumn;
    this.columnsInCluster       = Math.max(Math.ceil((this.viewerWidth / this.columnWidth) * 2), 2);
    this.columnTime             = this.chunkTime * this.chunksInColumn;

    //console.log('chunks in cluster: ' + chunksInCluster + '; chunks in column: ' + this.chunksInColumn + '; column width: ' + this.columnWidth + '; blocks in cluster: ' + this.columnsInCluster + '');
  };

  getBlockNum = function () {
    const blockNum     = (this.pseudoScrollLeft + this.halfViewerWidth) / this.columnWidth;
    const minColumnNum = Math.max(Math.round(blockNum - (this.columnsInCluster / 2)), 0) * this.chunksInColumn;
    const maxColumnNum = Math.min(Math.round(blockNum + (this.columnsInCluster / 2)) * this.chunksInColumn, this.chunkCount);

    //console.log('min column number: ' + minColumnNum + '; max column number: ' + maxColumnNum + '');
    return [minColumnNum, maxColumnNum];
  };

  updateContentArea = function(oldLeftOffset, cluster) {
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
  };

  handleClusterChanged = function (startIndex, endIndex) {
    //console.log('deleting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
    //console.log('chunk cache start index: ' + this.dataCache.startIndex + ' end index: ' + this.dataCache.endIndex + '');
    this.uncacheChunks(startIndex, endIndex);
    this.dataCache.startIndex     = startIndex;
    this.dataCache.endIndex       = endIndex;
  };


  getTimeFromClick = function(event) {
    const bounds      = this.contentArea.getBoundingClientRect();
    const pixelLeft   = Math.round(event.pageX - bounds.left);
    return Math.round(pixelLeft / this.zoomRatio) + (this.chunkTime * this.dataCache.startIndex);
  };


  isInView = function(time) {
    const pixel      = time * this.zoomRatio;
    const scrollLeft = this.pseudoScrollLeft;

    if (pixel < scrollLeft || pixel > scrollLeft + this.viewerWidth) {return false;}
    else {return true;}
  };

  moveViewToTime = function(time) {
    const moveViewer = !(this.isInView(time));
    if (moveViewer) {
      this.handleScrollEvent((time * this.zoomRatio) - this.halfViewerWidth);
    }
    return moveViewer;
  };

  updateScrollbarResize = function() {
    this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.timeStop * this.zoomRatio)), 17);
    //this.scrollbarWidth        = Math.max(Math.round((this.viewerWidth ** 2) / (this.chunkCount * chunkWidth)), 17);
    this.maxScrollbarPosition  = Math.max(this.viewerWidth - this.scrollbarWidth, 0);
    this.updateScrollBarPosition();
    this.scrollbar.style.width = this.scrollbarWidth + 'px';
  };
  
  updateScrollBarPosition = function() {
    this.scrollbarPosition       = Math.round((this.pseudoScrollLeft / this.maxScrollLeft) * this.maxScrollbarPosition);
    this.scrollbar.style.display = this.maxScrollLeft === 0 ? 'none' : 'block';
    this.scrollbar.style.left    = this.scrollbarPosition + 'px';
  };
  
  updateViewportWidth = function() {
    this.viewerWidth     = this.scrollArea.getBoundingClientRect().width;
    this.halfViewerWidth = this.viewerWidth / 2;
    this.maxScrollLeft   = Math.round(Math.max((this.timeStop * this.zoomRatio) - this.viewerWidth + 10, 0));
    //this.maxScrollLeft   = Math.round(Math.max((this.chunkCount * chunkWidth) - this.viewerWidth, 0));
    this.updateScrollbarResize();
  };
  
  handleScrollbarMove = function(e) {
    if (!this.scrollbarMoved) {
      this.scrollbarMoved = e.clientX !== this.scrollbarStartX;
      if (!this.scrollbarMoved) {return;}
    }
    const newPosition   = Math.min(Math.max(0, e.clientX - this.scrollbarStartX + this.scrollbarPosition), this.maxScrollbarPosition);
    this.scrollbarStartX              = e.clientX;
    const newScrollLeft = Math.round((newPosition / this.maxScrollbarPosition) * this.maxScrollLeft);
    this.handleScrollEvent(newScrollLeft);
    
  };
  
  handleScrollbarDrag = function(event) {
    event.preventDefault();
    this.scrollbarMoved = false;
    this.scrollbarStartX = event.clientX;
    this.scrollbar.classList.add('is-dragging');
  
    document.addEventListener('mousemove', this.handleScrollbarMove, false);
    mouseupEventType = 'scroll';
  };

  highlightZoom = function() {
    const timeStart = this.getTimeFromClick(highlightStartEvent);
    const timeEnd   = this.getTimeFromClick(highlightEndEvent);
    const time      = Math.round((timeStart + timeEnd) / 2);
    const width     = Math.abs(highlightStartEvent.pageX - highlightEndEvent.pageX);
    const amount    = Math.ceil(Math.log2(width / this.viewerWidth));
  
    if (highlightElement) {
      highlightElement.remove();
      highlightElement = null;
    }
  
    viewport.handleZoom(amount, time, this.halfViewerWidth);
  };

}

// Initialize the webview when the document is ready
document.addEventListener('DOMContentLoaded', () => {

  // Assuming you have a reference to the webview element
  const webview           = document.getElementById('vaporview-top');
  const controlBar        = document.getElementById('control-bar');
  const viewer            = document.getElementById('waveform-viewer');
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

  const formatBinary  = document.getElementById('format-binary-button');
  const formatHex     = document.getElementById('format-hex-button');
  const formatDecimal = document.getElementById('format-decimal-button');
  const formatEnum    = document.getElementById('format-enum-button');

  const touchScroll   = document.getElementById('touchpad-scroll-button');

  // Search bar
  const searchContainer = document.getElementById('search-container');
  const searchBar     = document.getElementById('search-bar');
  const valueIconRef  = document.getElementById('value-icon-reference');

  // resize elements
  const resize1       = document.getElementById("resize-1");
  const resize2       = document.getElementById("resize-2");
  webview.style.gridTemplateColumns = `150px 50px auto`;

  viewport = new Viewport(scrollArea, contentArea, scrollbar);

// ----------------------------------------------------------------------------
// Rendering Herlper functions
// ----------------------------------------------------------------------------

// Parse VCD values into either binary, hex, or decimal
// This function is so cursed...
parseValue = function (binaryString, width, is4State, numberFormat) {

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
        let digits = Math.ceil(chunk.length / 4);
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
};

valueIs4State = function (value) {
  if (value.match(/[xXzZ]/)) {return true;}
  else {return false;}
};

valueIs9State = function (value) {
  if (value.match(/[UuXxZzWwLlHh-]/)) {return true;}
};

htmlSafe = function (string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

htmlAttributeSafe = function (string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};

createLabel = function (netlistId, isSelected) {
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
};

createValueDisplayElement = function (netlistId, value, isSelected) {

  if (value === undefined) {value = [];}

  const vscodeContext = netlistData[netlistId].vscodeContext;
  const selectorClass = isSelected ? 'is-selected' : 'is-idle';
  const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
  const width         = netlistData[netlistId].signalWidth;
  const numberFormat  = netlistData[netlistId].numberFormat;
  const pElement      = value.map(v => {
    const is4State     = valueIs9State(v);
    const color        = is4State ? 'style="color:var(--vscode-debugTokenExpression-error)"' : '';
    const displayValue = parseValue(v, width, is4State, numberFormat);
    return `<p ${color}>${displayValue}</p>`;
  }).join(joinString);

  return `<div class="waveform-label ${selectorClass}" id="value-${netlistId}" ${vscodeContext}>${pElement}</div>`;
};

// ----------------------------------------------------------------------------
// Event handler helper functions
// ----------------------------------------------------------------------------

copyWaveDrom = function() {

  // Maximum number of transitions to display
  // Maybe I should make this a user setting in the future...
  const MAX_TRANSITIONS = 32;

  // Marker and alt marker need to be set
  if (markerTime === null || altMarkerTime === null) {
    vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
    return;
  }

  const timeWindow   = [markerTime, altMarkerTime].sort((a, b) => a - b);
  const chunkWindow  = [Math.floor(timeWindow[0] / viewport.chunkTime), Math.ceil(timeWindow[1] / viewport.chunkTime)];
  let allTransitions = [];

  // Populate the waveDrom names with the selected signals
  const waveDromData = {};
  displayedSignals.forEach((netlistId) => {
    const netlistItem     = netlistData[netlistId];
    const signalName      = netlistItem.modulePath + "." + netlistItem.signalName;
    const signalId        = netlistItem.signalId;
    const transitionData  = waveformData[signalId].transitionData;
    const chunkStart      = waveformData[signalId].chunkStart;
    const signalDataChunk = transitionData.slice(Math.max(0, chunkStart[chunkWindow[0]] - 1), chunkStart[chunkWindow[1]]);
    let   initialState = "x";
    const json         = {name: signalName, wave: ""};
    const signalDataTrimmed = [];
    if (netlistItem.signalWidth > 1) {json.data = [];}

    signalDataChunk.forEach((transition) => {
      if (transition[0] <= timeWindow[0]) {initialState = transition[1];}
      if (transition[0] >= timeWindow[0] && transition[0] <= timeWindow[1]) {signalDataTrimmed.push(transition);}
    });

    waveDromData[netlistId] = {json: json, signalData: signalDataTrimmed, signalWidth: netlistItem.signalWidth, initialState: initialState};
    const taggedTransitions = signalDataTrimmed.map(t => [t[0], t[1], netlistId]);
    allTransitions = allTransitions.concat(taggedTransitions);
  });

  let currentTime = timeWindow[0];
  let transitionCount = 0;

  if (waveDromClock.netlistId === null) {

    allTransitions = allTransitions.sort((a, b) => a[0] - b[0]);

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
    const clockEdges = waveDromData[waveDromClock.netlistId].signalData.filter((t) => t[1] === waveDromClock.edge);
    const edge       = waveDromClock.edge === '1' ? "p" : "n";
    let nextEdge = null;
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
          let transition = signalData.find((t) => t[0] >= currentTime && t[0] < nextEdge);
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
};

getNearestTransitionIndex = function (signalId, time) {

  if (time === null) {return -1;}

  let endIndex;
  const data        = waveformData[signalId];
  const chunk       = Math.floor(time / viewport.chunkTime);
  const startIndex  = Math.max(0, data.chunkStart[chunk] - 1);
  if (chunk === viewport.chunkCount - 1) {
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
};

getValueAtTime = function (signalId, time) {

  let result = [];
  const data = waveformData[signalId];

  if (!data) {return result;}

  const transitionData  = data.transitionData;
  const transitionIndex = getNearestTransitionIndex(signalId, time);

  if (transitionIndex === -1) {return result;}
  if (transitionIndex > 0) {
    result.push(transitionData[transitionIndex - 1][1]);
  }

  if (transitionData[transitionIndex][0] === time) {
    result.push(transitionData[transitionIndex][1]);
  }

  return result;
};

getNearestTransition = function (signalId, time) {

  let result = null;
  if (time === null) {return result;}
  
  const data  = waveformData[signalId].transitionData;
  const index = getNearestTransitionIndex(signalId, time);
  
  if (index === -1) {return result;}
  if (data[index][0] === time) {
    return data[index];
  }

  let timeBefore = time - data[index - 1][0];
  let timeAfter  = data[index][0] - time;

  if (timeBefore < timeAfter) {
    return data[index - 1];
  } else {
    return data[index];
  }
};

setSeletedSignalOnStatusBar = function (netlistId) {
  vscode.postMessage({
    command: 'setSelectedSignal',
    netlistId: netlistId
  });
};

setTimeOnStatusBar = function () {
  // .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  vscode.postMessage({
    command: 'setTime',
    markerTime:    markerTime,
    altMarkerTime: altMarkerTime
  });
};

sendDisplayedSignals = function () {
  vscode.postMessage({
    command: 'setDisplayedSignals',
    signals: displayedSignals
  });
};

sendWebviewContext = function (responseType) {

  vscode.postMessage({
    command: 'contextUpdate',
    markerTime: markerTime,
    altMarkerTime: altMarkerTime,
    selectedSignal: selectedSignal,
    displayedSignals: displayedSignals,
    zoomRatio: viewport.zoomRatio,
    scrollLeft: viewport.pseudoScrollLeft,
  });
};

goToNextTransition = function (direction, edge) {
  if (selectedSignal === null) {
    //handleMarkerSet(markerTime + direction, 0);
    return;
  }

  const signalId = netlistData[selectedSignal].signalId;
  const data     = waveformData[signalId];
  const time     = markerTime;
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

  handleMarkerSet(data.transitionData[timeIndex][0], 0);
};

renderLabelsPanels = function () {
  labelsList  = [];
  let transitions = [];
  displayedSignals.forEach((netlistId, index) => {
    const signalId     = netlistData[netlistId].signalId;
    const numberFormat = netlistData[netlistId].numberFormat;
    const signalWidth  = netlistData[netlistId].signalWidth;
    let data           = waveformData[signalId];
    const isSelected   = (index === selectedSignalIndex);
    labelsList.push(createLabel(netlistId, isSelected));
    transitions.push(createValueDisplayElement(netlistId, viewport.dataCache.valueAtMarker[signalId], isSelected));
    if (data) {
      data.textWidth   = viewport.getValueTextWidth(signalWidth, numberFormat);
    }
  });
  labels.innerHTML            = labelsList.join('');
  transitionDisplay.innerHTML = transitions.join('');
};

setButtonState = function (buttonId, state) {
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
};

handleSignalSelect = function (netlistId) {

  let element;
  let index;

  for (var i = viewport.dataCache.startIndex; i < viewport.dataCache.endIndex; i+=viewport.chunksInColumn) {
    element = document.getElementById('idx' + i + '-' + viewport.chunksInColumn + '--' + selectedSignal);
    if (element) {
      element.classList.remove('is-selected');
      viewport.dataCache.columns[i].waveformChunk[selectedSignal].html = element.outerHTML;
    }

    element = document.getElementById('idx' + i + '-' + viewport.chunksInColumn + '--' + netlistId);
    if (element) {
      element.classList.add('is-selected');
      viewport.dataCache.columns[i].waveformChunk[netlistId].html = element.outerHTML;
    }
  }

  selectedSignal      = netlistId;
  selectedSignalIndex = displayedSignals.findIndex((signal) => {return signal === netlistId;});
  if (selectedSignalIndex === -1) {selectedSignalIndex = null;}

  //setSeletedSignalOnStatusBar(netlistId);
  sendWebviewContext();
  renderLabelsPanels();

  if (netlistId === null) {return;}

  const numberFormat = netlistData[netlistId].numberFormat;

  updateButtonsForSelectedWaveform(netlistData[netlistId].signalWidth);

  if (numberFormat === 2)  {valueIconRef.setAttribute('href', '#search-binary');}
  if (numberFormat === 10) {valueIconRef.setAttribute('href', '#search-decimal');}
  if (numberFormat === 16) {valueIconRef.setAttribute('href', '#search-hex');}
};

handleTouchScroll = function () {
  touchpadScrolling = !touchpadScrolling;
  setButtonState(touchScroll, touchpadScrolling ? 2 : 1);
};

setBinaryEdgeButtons = function (selectable) {
  setButtonState(prevNegedge, selectable);
  setButtonState(prevPosedge, selectable);
  setButtonState(nextNegedge, selectable);
  setButtonState(nextPosedge, selectable);
};

setBusEdgeButtons = function (selectable) {
  setButtonState(prevEdge, selectable);
  setButtonState(nextEdge, selectable);
};

updateButtonsForSelectedWaveform = function (width) {
  if (width === null) {
    setBinaryEdgeButtons(0);
    setBusEdgeButtons(0);
  } else if (width === 1) {
    setBinaryEdgeButtons(1);
    setBusEdgeButtons(1);
  } else {
    setBinaryEdgeButtons(0);
    setBusEdgeButtons(1);
  }
};

handleSearchButtonSelect = function (button) {
  handleSearchBarInFocus(true);
  searchState = button;
  if (searchState === 0) {
    setButtonState(timeEquals, 2);
    setButtonState(valueEquals, 1);
  } else if (searchState === 1) {
    setButtonState(timeEquals, 1);
    setButtonState(valueEquals, 2);
  }
  handleSearchBarEntry({key: 'none'});
};

setSignalContextAttribute = function (netlistId) {
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
};

checkValidTimeString = function (inputText) {
  if (inputText.match(/^[0-9]+$/)) {
    parsedSearchValue = inputText.replace(/,/g, '');
    return true;
  }
  else {return false;}
};

checkValidBinaryString = function (inputText) {
  if (inputText.match(/^b?[01xzXZdD_]+$/)) {
    parsedSearchValue = inputText.replace(/_/g, '').replace(/[dD]/g, '.');
    return true;
  } 
  else {return false;}
};

checkValidHexString = function (inputText) {
  if (inputText.match(/^(0x)?[0-9a-fA-FxzXZ_]+$/)) {
    parsedSearchValue = inputText.replace(/_/g, '').replace(/^0x/i, '');
    parsedSearchValue = parsedSearchValue.split('').map((c) => {
      if (c.match(/[xXzZ]/)) {return '....';}
      return parseInt(c, 16).toString(2).padStart(4, '0');
    }).join('');
    return true;
  }
  else {return false;}
};

checkValidDecimalString = function (inputText) {
  if (inputText.match(/^[0-9xzXZ_,]+$/)) {
    parsedSearchValue = inputText.replace(/,/g, '');
    parsedSearchValue = parsedSearchValue.split('_').map((n) => {
      if (n === '') {return '';}
      if (n.match(/[xXzZ]/)) {return '.{32}';}
      return parseInt(n, 10).toString(2).padStart(32, '0');
    }).join('');
    return true;
  }
  else {return false;}
};

handleSearchBarKeyDown = function (event) {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSearchGoTo(1);
    return;
  }
};

handleSearchBarEntry = function (event) {
  const inputText  = searchBar.value;
  let inputValid   = true;
  let numberFormat = 16;
  if (selectedSignal) {
    numberFormat = netlistData[selectedSignal].numberFormat;
  }

  // check to see that the input is valid
  if (searchState === 0) {         inputValid = checkValidTimeString(inputText);
  } else if (searchState === 1) {
    if      (numberFormat === 2)  {inputValid = checkValidBinaryString(inputText);}
    else if (numberFormat === 16) {inputValid = checkValidHexString(inputText);} 
    else if (numberFormat === 10) {inputValid = checkValidDecimalString(inputText);}
  }

  // Update UI accordingly
  if (inputValid || inputText === '') {
    searchContainer.classList.remove('is-invalid');
  } else {
    searchContainer.classList.add('is-invalid');
  }

  if (inputValid && inputText !== '') {
    setButtonState(previousButton, searchState);
    setButtonState(nextButton, 1);
  } else {
    setButtonState(previousButton, 0);
    setButtonState(nextButton, 0);
  }
};

handleSearchGoTo = function (direction) {
  if (selectedSignal === null) {return;}
  if (parsedSearchValue === null) {return;}

  const signalId = netlistData[selectedSignal].signalId;

  if (searchState === 0 && direction === 1) {
    handleMarkerSet(parseInt(parsedSearchValue), 0);
  } else {
    const signalWidth      = waveformData[signalId].signalWidth;
    let trimmedSearchValue = parsedSearchValue;
    if (parsedSearchValue.length > signalWidth) {trimmedSearchValue = parsedSearchValue.slice(-1 * signalWidth);}
    let searchRegex = new RegExp(trimmedSearchValue, 'ig');
    const data      = waveformData[signalId];
    const timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= markerTime;});
    let indexOffset = 0;

    if (direction === -1) {indexOffset = -1;}
    else if (markerTime === data.transitionData[timeIndex][0]) {indexOffset = 1;}

    for (var i = timeIndex + indexOffset; i >= 0; i+=direction) {
      if (data.transitionData[i][1].match(searchRegex)) {
        handleMarkerSet(data.transitionData[i][0], 0);
        break;
      }
    }
  }
};

handleSearchBarInFocus = function (isFocused) {
  searchInFocus = isFocused;
  if (isFocused) {
    if (document.activeElement !== searchBar) {
      searchBar.focus();
    }
    if (searchContainer.classList.contains('is-focused')) {return;}
    searchContainer.classList.add('is-focused');
  } else {
    searchContainer.classList.remove('is-focused');
  }
};

function clicklabel (event, containerElement) {
  const labelsList   = Array.from(containerElement.querySelectorAll('.waveform-label'));
  const clickedLabel = event.target.closest('.waveform-label');
  const itemIndex    = labelsList.indexOf(clickedLabel);
  handleSignalSelect(displayedSignals[itemIndex]);
}

// Event handler helper functions
function arrayMove(array, fromIndex, toIndex) {
  var element = array[fromIndex];
  array.splice(fromIndex, 1);
  array.splice(toIndex, 0, element);
}

function reorderSignals(oldIndex, newIndex) {

  if (draggableItem) {
    draggableItem.style   = null;
    draggableItem.classList.remove('is-draggable');
    draggableItem.classList.add('is-idle');
  } else {
    labelsList = Array.from(labels.querySelectorAll('.waveform-label'));
  }

  viewport.updatePending = true;
  arrayMove(displayedSignals, oldIndex, newIndex);
  arrayMove(labelsList,       oldIndex, newIndex);
  handleSignalSelect(displayedSignals[newIndex]);
  renderLabelsPanels();
  for (var i = viewport.dataCache.startIndex; i < viewport.dataCache.endIndex; i+=viewport.chunksInColumn) {
    const waveformColumn = document.getElementById('waveform-column-' + i + '-' + viewport.chunksInColumn);
    const children       = Array.from(waveformColumn.children);
    arrayMove(children, oldIndex, newIndex);
    waveformColumn.replaceChildren(...children);
  }
  viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());
}

function updateIdleItemsStateAndPosition() {
  const draggableItemRect = draggableItem.getBoundingClientRect();
  const draggableItemY    = draggableItemRect.top + draggableItemRect.height / 2;

  let closestItemAbove      = null;
  let closestItemBelow      = null;
  let closestDistanceAbove  = Infinity;
  let closestDistanceBelow  = Infinity;

  idleItems.forEach((item) => {
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

  let closestItemAboveIndex = Math.max(labelsList.indexOf(closestItemAbove), 0);
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

function handleMarkerSet(time, markerType) {

  if (time > viewport.timeStop) {return;}

  let   oldMarkerTime = markerType === 0 ? markerTime         : altMarkerTime;
  let   chunkIndex    = markerType === 0 ? markerChunkIndex   : altMarkerChunkIndex;
  const id            = markerType === 0 ? 'main-marker'      : 'alt-marker';
  let viewerMoved     = false;

  // dispose of old marker
  if (oldMarkerTime !== null) {
    if (chunkIndex >= viewport.dataCache.startIndex && chunkIndex < viewport.dataCache.endIndex + viewport.chunksInColumn) {
      let timeMarker = document.getElementById(id);
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
      markerChunkIndex   = undefined;
    } else {
      altMarkerTime         = null;
      altMarkerChunkIndex   = undefined;
    }
    return;
  }

  // first find the chunk with the marker
  chunkIndex   = Math.floor(time / viewport.chunkTime);

  // create new marker
  if (chunkIndex >= viewport.dataCache.startIndex && chunkIndex < viewport.dataCache.endIndex + viewport.chunksInColumn) {
    const clusterIndex = Math.floor((chunkIndex - viewport.dataCache.startIndex) / viewport.chunksInColumn);
    let chunkElement   = contentArea.getElementsByClassName('column-chunk')[clusterIndex];
    let marker         = domParser.parseFromString(viewport.createTimeMarker(time, markerType), 'text/html').body.firstChild;

    chunkElement.appendChild(marker);

    //console.log('adding marker at time ' + time + ' from chunk ' + chunkIndex + '');
  } else {
    //console.log('chunk index ' + chunkIndex + ' is not in cache');
  }

  if (markerType === 0) {
    markerTime            = time;
    markerChunkIndex      = chunkIndex;

    viewerMoved = viewport.moveViewToTime(time);

    // Get values for all displayed signals at the marker time
    displayedSignals.forEach((netlistId) => {
      let signalId = netlistData[netlistId].signalId;
      viewport.dataCache.valueAtMarker[signalId] = getValueAtTime(signalId, time);
    });

    renderLabelsPanels();
  } else {
    altMarkerTime         = time;
    altMarkerChunkIndex   = chunkIndex;
  }

  //setTimeOnStatusBar();
  sendWebviewContext();
}

function dragStart(event) {
  event.preventDefault();
  labelsList = Array.from(labels.querySelectorAll('.waveform-label'));

  if (event.target.classList.contains('codicon-grabber')) {
    draggableItem = event.target.closest('.waveform-label');
  }

  if (!draggableItem) {return;}

  pointerStartX = event.clientX;
  pointerStartY = event.clientY;

  draggableItem.classList.remove('is-idle');
  draggableItem.classList.remove('is-selected');
  draggableItem.classList.add('is-draggable');

  document.addEventListener('mousemove', dragMove);

  mouseupEventType      = 'rearrange';
  draggableItemIndex    = labelsList.indexOf(draggableItem);
  draggableItemNewIndex = draggableItemIndex;
  idleItems             = labelsList.filter((item) => {return item.classList.contains('is-idle');});
}

function dragMove(event) {
  if (!draggableItem) {return;}

  const pointerOffsetX = event.clientX - pointerStartX;
  const pointerOffsetY = event.clientY - pointerStartY;

  draggableItem.style.transform = `translate(${pointerOffsetX}px, ${pointerOffsetY}px)`;

  updateIdleItemsStateAndPosition();
}

function dragEnd(event) {
  event.preventDefault();
  if (!draggableItem) {return;}

  idleItems.forEach((item) => {item.style = null;});
  document.removeEventListener('mousemove', dragMove);

  reorderSignals(draggableItemIndex, draggableItemNewIndex);

  labelsList            = [];
  idleItems             = [];
  draggableItemIndex    = null;
  draggableItemNewIndex = null;
  pointerStartX         = null;
  pointerStartY         = null;
  draggableItem         = null;
}

function syncVerticalScroll(scrollLevel) {
  if (viewport.updatePending) {return;}
  viewport.updatePending              = true;
  labelsScroll.scrollTop     = scrollLevel;
  transitionScroll.scrollTop = scrollLevel;
  scrollArea.scrollTop       = scrollLevel;
  viewport.updatePending              = false;
}

function drawHighlightZoom(event) {

  highlightEndEvent = event;
  const width       = Math.abs(highlightEndEvent.pageX - highlightStartEvent.pageX);
  const left        = Math.min(highlightStartEvent.pageX, highlightEndEvent.pageX);
  const elementLeft = left - scrollArea.getBoundingClientRect().left;
  const style       = `left: ${elementLeft}px; width: ${width}px; height: ${contentArea.style.height};`;

  if (width > 5) {mouseupEventType = 'highlightZoom';}

  if (!highlightElement) {
    highlightElement = domParser.parseFromString(`<div id="highlight-zoom" style="${style}"></div>`, 'text/html').body.firstChild;
    scrollArea.appendChild(highlightElement);
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

function handleScrollAreaMouseDown(event) {
  if (event.button === 1) {
    handleScrollAreaClick(event, 1);
  } else if (event.button === 0) {
    highlightStartEvent = event;
    mouseupEventType    = 'markerSet';

    if (!highlightListenerSet) {
      scrollArea.addEventListener('mousemove', drawHighlightZoom, false);
      highlightListenerSet = true;
    }

  }
}

function handleScrollAreaClick(event, eventButton) {

  button = eventButton;

  if (eventButton === 1) {event.preventDefault();}
  if (eventButton === 2) {return;}
  if (eventButton === 0 && event.altKey) {button = 1;}

  const snapToDistance = 3.5;

  // Get the time position of the click
  const time     = viewport.getTimeFromClick(event);
  let snapToTime = time;

  // Get the signal id of the click
  let netlistId     = null;
  const waveChunkId = event.target.closest('.waveform-chunk');
  if (waveChunkId) {netlistId = parseInt(waveChunkId.id.split('--').slice(1).join('--'));}
  if (netlistId !== undefined && netlistId !== null) {

    if (button === 0) {
      handleSignalSelect(netlistId);
    }

    const signalId = netlistData[netlistId].signalId;

    // Snap to the nearest transition if the click is close enough
    const nearestTransition = getNearestTransition(signalId, time);

    if (nearestTransition === null) {return;}

    const nearestTime       = nearestTransition[0];
    const pixelDistance     = Math.abs(nearestTime - time) * viewport.zoomRatio;

    if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
  }

  handleMarkerSet(snapToTime, button);
}


// resize handler to handle resizing
function resize(e) {
  const gridTemplateColumns = webview.style.gridTemplateColumns;
  const column1 = parseInt(gridTemplateColumns.split(' ')[0]);
  const column2 = parseInt(gridTemplateColumns.split(' ')[1]);

  if (resizeIndex === 1) {
    webview.style.gridTemplateColumns = `${e.x}px ${column2}px auto`;
    resize1.style.left = `${e.x}px`;
    resize2.style.left = `${e.x + column2}px`;
  } else if (resizeIndex === 2) {
    const newWidth    = Math.max(10, e.x - column1);
    const newPosition = Math.max(10 + column1, e.x);
    webview.style.gridTemplateColumns = `${column1}px ${newWidth}px auto`;
    resize2.style.left = `${newPosition}px`;
  }
}

function handleResizeMousedown(event, element, index) {
  resizeIndex   = index;
  resizeElement = element;
  event.preventDefault();
  resizeElement.classList.add('is-resizing');
  document.addEventListener("mousemove", resize, false);
  mouseupEventType = 'resize';
}


function handleResizeViewer() {
  clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(viewport.updateViewportWidth, 100);
}

function handleMouseUp(event) {
  //console.log('mouseup event type: ' + mouseupEventType);
  if (mouseupEventType === 'rearrange') {
    dragEnd(event);
  } else if (mouseupEventType === 'resize') {
    resizeElement.classList.remove('is-resizing');
    document.removeEventListener("mousemove", resize, false);
    handleResizeViewer();
  } else if (mouseupEventType === 'scroll') {
    scrollbar.classList.remove('is-dragging');
    document.removeEventListener('mousemove', viewport.handleScrollbarMove, false);
    viewport.scrollbarMoved = false;
  } else if (mouseupEventType === 'highlightZoom') {
    scrollArea.removeEventListener('mousemove', drawHighlightZoom, false);
    highlightListenerSet = false;
    viewport.highlightZoom();
  } else if (mouseupEventType === 'markerSet') {
    scrollArea.removeEventListener('mousemove', drawHighlightZoom, false);
    clearTimeout(highlightDebounce);
    handleScrollAreaClick(highlightStartEvent, 0);
    highlightListenerSet = false;
    if (highlightElement) {
      highlightElement.remove();
      highlightElement = null;
    }
  }
  mouseupEventType = null;
}

function resetTouchpadScrollCount() {
  viewport.touchpadScrollCount = 0;
}


  labelsScroll.addEventListener(    'scroll', (e) => {syncVerticalScroll(labelsScroll.scrollTop);});
  transitionScroll.addEventListener('scroll', (e) => {syncVerticalScroll(transitionScroll.scrollTop);});
  scrollArea.addEventListener(      'scroll', (e) => {
    syncVerticalScroll(scrollArea.scrollTop);
    //viewport.handleScrollEvent();
  });

  // scroll handler to handle zooming and scrolling
  scrollArea.addEventListener('wheel', (event) => { 

    event.preventDefault();

    //console.log(event);

    if (!touchpadScrolling) {event.preventDefault();}
    const deltaY = event.deltaY;
    const deltaX = event.deltaX;
    if (event.shiftKey && !touchpadScrolling) {
      event.stopPropagation();
      scrollArea.scrollTop      += deltaY || deltaX;
      labelsScroll.scrollTop     = scrollArea.scrollTop;
      transitionScroll.scrollTop = scrollArea.scrollTop;
    } else if (event.ctrlKey) {
      if      (viewport.updatePending) {return;}
      const bounds      = scrollArea.getBoundingClientRect();
      const pixelLeft   = Math.round(event.pageX - bounds.left);
      const time        = Math.round((pixelLeft - viewport.contentLeft) / viewport.zoomRatio) + (viewport.chunkTime * viewport.dataCache.startIndex);

      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (!touchpadScrolling && (deltaY > 0)) {viewport.handleZoom( 1, time, pixelLeft);}
      else if (!touchpadScrolling && (deltaY < 0)) {viewport.handleZoom(-1, time, pixelLeft);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else if (touchpadScrolling) {
        viewport.touchpadScrollCount += deltaY;
        clearTimeout(resetTouchpadScrollCount);
        setTimeout(resetTouchpadScrollCount, 1000);
        viewport.handleZoom(Math.round(viewport.touchpadScrollCount / 25), time, pixelLeft);
      }

    } else {
      if (touchpadScrolling) {
        viewport.handleScrollEvent(viewport.pseudoScrollLeft + event.deltaX);
        scrollArea.scrollTop       += event.deltaY;
        labelsScroll.scrollTop      = scrollArea.scrollTop;
        transitionScroll.scrollTop  = scrollArea.scrollTop;
      } else {
        viewport.handleScrollEvent(viewport.pseudoScrollLeft + deltaY);
      }
    }
  });
  //scrollArea.addEventListener('wheel', handleScrollMouse, false);

  // move handler to handle moving the marker or selected signal with the arrow keys
  window.addEventListener('keydown', (event) => {

    if (searchInFocus) {return;} 
    else {event.preventDefault();}

    // debug handler to print the data cache
    if (event.key === 'd' && event.ctrlKey) {
      console.log(viewport.updatePending);
      console.log(viewport.dataCache);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition

    if ((event.key === 'ArrowRight') && (markerTime !== null)) {
      if (event.ctrlKey || event.altKey) {goToNextTransition(1);}
      else if (event.metaKey) {handleMarkerSet(viewport.timeStop, 0);}
      else                 {handleMarkerSet(markerTime + 1, 0);}
    } else if ((event.key === 'ArrowLeft') && (markerTime !== null)) {
      if (event.ctrlKey || event.altKey)  {goToNextTransition(-1);}
      else if (event.metaKey) {handleMarkerSet(0, 0);}
      else                 {handleMarkerSet(markerTime - 1, 0);}

    // up and down arrow keys move the selected signal
    // alt + up and down arrow keys reorder the selected signal up and down
    } else if ((event.key === 'ArrowUp') && (selectedSignalIndex !== null)) {
      let newIndex = Math.max(selectedSignalIndex - 1, 0);
      if (event.altKey)  {reorderSignals(selectedSignalIndex, newIndex);}
      else               {handleSignalSelect(displayedSignals[newIndex]);}
    } else if ((event.key === 'ArrowDown') && (selectedSignalIndex !== null)) {
      let newIndex = Math.min(selectedSignalIndex + 1, displayedSignals.length - 1);
      if (event.altKey)  {reorderSignals(selectedSignalIndex, newIndex);}
      else               {handleSignalSelect(displayedSignals[newIndex]);}
    }

    // handle Home and End keys to move to the start and end of the waveform
    else if (event.key === 'Home') {handleMarkerSet(0, 0);}
    else if (event.key === 'End')  {handleMarkerSet(viewport.timeStop, 0);}

    // "N" and Shoft + "N" go to the next transition
    else if (event.key === 'n') {goToNextTransition(1);}
    else if (event.key === 'N') {goToNextTransition(-1);}

  });

  // click handler to handle clicking inside the waveform viewer
  // gets the absolute x position of the click relative to the scrollable content
  contentArea.addEventListener('mousedown', (e) => {handleScrollAreaMouseDown(e);});
  scrollbar.addEventListener('mousedown',   (e) => {viewport.handleScrollbarDrag(e);});

  // resize handler to handle column resizing
  resize1.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize1, 1);});
  resize2.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize2, 2);});
  window.addEventListener('resize',       ()  => {handleResizeViewer();}, false);

  // Control bar button event handlers
  zoomInButton.addEventListener( 'click', (e) => {viewport.handleZoom(-1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
  zoomOutButton.addEventListener('click', (e) => {viewport.handleZoom( 1, (viewport.pseudoScrollLeft + viewport.halfViewerWidth) / viewport.zoomRatio, viewport.halfViewerWidth);});
  prevNegedge.addEventListener(  'click', (e) => {goToNextTransition(-1, '0');});
  prevPosedge.addEventListener(  'click', (e) => {goToNextTransition(-1, '1');});
  nextNegedge.addEventListener(  'click', (e) => {goToNextTransition( 1, '0');});
  nextPosedge.addEventListener(  'click', (e) => {goToNextTransition( 1, '1');});
  prevEdge.addEventListener(     'click', (e) => {goToNextTransition(-1);});
  nextEdge.addEventListener(     'click', (e) => {goToNextTransition( 1);});

  // Search bar event handlers
  searchBar.addEventListener(    'focus', (e) => {handleSearchBarInFocus(true);});
  searchBar.addEventListener(     'blur', (e) => {handleSearchBarInFocus(false);});
  searchBar.addEventListener(  'keydown', (e) => {handleSearchBarKeyDown(e);});
  searchBar.addEventListener(    'keyup', (e) => {handleSearchBarEntry(e);});
  timeEquals.addEventListener(   'click', (e) => {handleSearchButtonSelect(0);});
  valueEquals.addEventListener(  'click', (e) => {handleSearchButtonSelect(1);});
  previousButton.addEventListener('click', (e) => {handleSearchGoTo(-1);});
  nextButton.addEventListener(    'click', (e) => {handleSearchGoTo(1);});
  setButtonState(previousButton, 0);
  touchScroll.addEventListener(   'click', (e) => {handleTouchScroll();});

  // click and drag handlers to rearrange the order of waveform signals
  labels.addEventListener('mousedown', dragStart);
  document.addEventListener('mouseup', handleMouseUp);

  // Event handlers to handle clicking on a waveform label to select a signal
  labels.addEventListener(           'click', (e) => clicklabel(e, labels));
  transitionDisplay.addEventListener('click', (e) => clicklabel(e, transitionDisplay));

  mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.classList.contains('shallow-chunk')) {
          node.classList.remove('shallow-chunk');
          node.classList.add('rendering-chunk');
          let chunkIndex = parseInt(node.id.split('-')[1]);
          const data     = viewport.dataCache.columns[chunkIndex];
          if (!data || data.abortFlag || !data.isSafeToRemove) {
            //console.log('chunk ' + chunkIndex + ' is not safe to touch');
            //console.log(data);
            return;
          }
          viewport.dataCache.columns[chunkIndex].isSafeToRemove = false;
          viewport.dataCache.updatesPending++;
          viewport.renderWaveformsAsync(node, chunkIndex);
        }
      });
    });
  });
  mutationObserver.observe(contentArea, {childList: true});

  // Handle messages from the extension
  window.addEventListener('message', (event) => {
    const message = event.data;

    //console.log('received message: ' + message.command);

    switch (message.command) {
      case 'create-ruler': {
        //vscode.postMessage({ command: 'creating ruler from the js file' });
        //console.log("creating ruler");
        waveformDataSet   = message.waveformDataSet;
        document.title    = waveformDataSet.filename;
        viewport.chunkTime         = waveformDataSet.chunkTime;
        viewport.zoomRatio         = waveformDataSet.defaultZoom;
        viewport.timeScale         = waveformDataSet.timeScale;
        viewport.maxZoomRatio      = viewport.zoomRatio * 64;
        viewport.chunkWidth        = viewport.chunkTime * viewport.zoomRatio;
        viewport.chunkCount        = Math.ceil(waveformDataSet.timeEnd / waveformDataSet.chunkTime);
        viewport.timeStop          = waveformDataSet.timeEnd;
        viewport.dataCache.columns = new Array(viewport.chunkCount);

        viewport.updatePending = true;
        viewport.updateViewportWidth();
        viewport.getChunksWidth();
        viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());

        break;
      }
      case 'unload': {
        //console.log('unloading');

        // Scroll handler variables
        //viewport.pseudoScrollLeft    = 0;
        //viewport.contentLeft         = 0;
        //viewport.leftOffset          = 0;
        //viewport.viewerWidth         = 0;
        //viewport.halfViewerWidth     = 0;
        //viewport.maxScrollLeft       = 0;
        //viewport.maxScrollbarPosition = 0;
        //viewport.scrollbarWidth      = 17;
        //viewport.scrollbarPosition   = 0;
        //touchpadScrolling   = false;
        //viewport.touchpadScrollCount = 0;

        // Zoom level variables
        //timeScale           = 1;
        viewport.chunkCount          = 0;
        //viewport.chunkTime           = 512;
        //viewport.chunkWidth          = 512;
        //viewport.zoomRatio           = 1;
        //viewport.maxZoomRatio        = 64;
        viewport.chunksInColumn      = 1;
        viewport.columnTime          = viewport.chunkTime * viewport.chunksInColumn;
        viewport.timeStop            = 0;
        // Clusterize variables
        viewport.updatePending       = true;
        viewport.columnsInCluster    = 4;
        viewport.scrollEventPending  = false;
        viewport.currentCluster      = [0, 0];
        viewport.columnWidth         = viewport.chunksInColumn  * viewport.chunkWidth;
        // Marker and signal selection variables
        selectedSignal      = null;
        selectedSignalIndex = null;
        markerTime          = null;
        markerChunkIndex    = undefined;
        altMarkerTime       = null;
        altMarkerChunkIndex = undefined;
        // Search handler variables
        searchInFocus       = false;
        parsedSearchValue   = null;
        // Data formatting variables
        bitChunkWidth       = 4;
        labelsList          = [];
        // Data variables
        contentData         = [];
        displayedSignals    = [];
        waveformData        = {};
        netlistData         = {};
        waveformDataTemp    = {};
        viewport.dataCache           = {
          startIndex:     0,
          endIndex:       0,
          columns:        [],
          valueAtMarker:  {},
          updatesPending: 0,
          markerElement:  '',
          altMarkerElement: '',
        };
        waveDromClock = {netlistId: null,};

        contentArea.style.height = '0px';
        viewport.updateContentArea(0, [0, 0]);
        viewport.handleZoom(1, 0, 0);
        renderLabelsPanels();
        vscode.postMessage({type: 'ready'});

        break;
      }
      case 'add-variable': {
        // Handle rendering a signal, e.g., render the signal based on message content
        //console.log(message);

        const signalList    = message.signalList;
        const signalIdList  = [];
        const netlistIdList = [];
        let updateFlag      = false;
        let selectedSignal  = null;

        signalList.forEach((signal) => {

          let netlistId      = signal.netlistId;
          let signalId       = signal.signalId;
          let numberFormat   = signal.numberFormat;
          let signalWidth    = signal.signalWidth;
          displayedSignals.push(netlistId);

          netlistData[netlistId] = {
            signalId:     signalId,
            signalWidth:  signalWidth,
            signalName:   signal.signalName,
            modulePath:   signal.modulePath,
            numberFormat: numberFormat,
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

        viewport.updateWaveformInCache(netlistIdList);
        renderLabelsPanels();

        if (updateFlag) {
          viewport.updatePending  = true;
          viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());
          contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";
          handleSignalSelect(selectedSignal);
        }

        vscode.postMessage({
          command: 'fetchTransitionData',
          signalIdList: signalIdList,
        });

        break;
      }
      case 'update-waveform-chunk': {
        // Newer command used for fetching transition data in chunks

        let signalId = message.signalId;
        if (waveformDataTemp[signalId].totalChunks === 0) {
          waveformDataTemp[signalId].totalChunks = message.totalChunks;
          waveformDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
          waveformDataTemp[signalId].chunkData   = new Array(message.totalChunks).fill("");
        }

        waveformDataTemp[signalId].chunkData[message.chunkNum]   = message.transitionDataChunk;
        waveformDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
        allChunksLoaded = waveformDataTemp[signalId].chunkLoaded.every((chunk) => {return chunk;});

        if (!allChunksLoaded) {break;}

        //console.log('all chunks loaded');

        let transitionData = JSON.parse(waveformDataTemp[signalId].chunkData.join(""));

        let netlistId = waveformDataTemp[signalId].netlistId;
        if (netlistId ===  undefined) {console.log('netlistId not found for signalId ' + signalId); break;}
        let signalWidth = netlistData[netlistId].signalWidth;
        let numberFormat = netlistData[netlistId].numberFormat;
        let nullValue = "X".repeat(signalWidth);

        if (transitionData[0][0] !== 0) {
          transitionData.unshift([0, nullValue]);
        }
        if (transitionData[transitionData.length - 1][0] !== viewport.timeStop) {
          transitionData.push([viewport.timeStop, nullValue]);
        }
        waveformData[signalId] = {
          transitionData: transitionData,
          signalWidth:    signalWidth,
          textWidth:      viewport.getValueTextWidth(signalWidth, numberFormat),
        };

        // Create ChunkStart array
        waveformData[signalId].chunkStart = new Array(viewport.chunkCount).fill(transitionData.length);
        let chunkIndex = 0;
        for (let i = 0; i < transitionData.length; i++) {
          while (transitionData[i][0] >= viewport.chunkTime * chunkIndex) {
            waveformData[signalId].chunkStart[chunkIndex] = i;
            chunkIndex++;
          }
        }
        waveformData[signalId].chunkStart[0] = 1;

        waveformDataTemp[signalId] = undefined;

        viewport.updateWaveformInCache([netlistId]);
        renderLabelsPanels();

        viewport.updatePending  = true;
        viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());
        contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";
        handleSignalSelect(netlistId);

        break;
      }
      case 'remove-signal': {
        // Handle deleting a signal, e.g., remove the signal from the DOM

        const index = displayedSignals.findIndex((netlistId) => netlistId === message.netlistId);
        //console.log('deleting signal' + message.signalId + 'at index' + index);
        if (index === -1) {
          //console.log('could not find signal ' + message.netlistId + ' to delete');
          break;
        } else {
          displayedSignals.splice(index, 1);
          viewport.updatePending    = true;
          renderLabelsPanels();
          for (var i = viewport.dataCache.startIndex; i < viewport.dataCache.endIndex; i+=viewport.chunksInColumn) {
            const waveformColumn = document.getElementById('waveform-column-' + i + '-' + viewport.chunksInColumn);
            const children       = Array.from(waveformColumn.children);
            children.splice(index, 1);
            waveformColumn.replaceChildren(...children);
          }
          viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());
          contentArea.style.height = (40 + (28 * displayedSignals.length)) + "px";

          if (selectedSignal === message.netlistId) {
            handleSignalSelect(null);
          }
        }

        break;
      }
      case 'setNumberFormat': {

        numberFormat = message.numberFormat;
        netlistId    = message.netlistId;

        if (netlistData[netlistId] === undefined) {break;}

        netlistData[netlistId].numberFormat  = numberFormat;
        netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);

        viewport.updatePending = true;
        viewport.updateWaveformInCache([message.netlistId]);
        renderLabelsPanels();
        viewport.updateContentArea(viewport.leftOffset, viewport.getBlockNum());

        if (netlistId === selectedSignal) {
          if (numberFormat === 2)  {valueIconRef.setAttribute('href', '#search-binary');}
          if (numberFormat === 10) {valueIconRef.setAttribute('href', '#search-decimal');}
          if (numberFormat === 16) {valueIconRef.setAttribute('href', '#search-hex');}
        }

        break;
      }
      case 'setWaveDromClock': {
        waveDromClock = {
          netlistId: message.netlistId,
          edge:  message.edge,
        };
        break;
      }
      case 'getSelectionContext': {
        sendWebviewContext('response');
        //vscode.postMessage({type: 'context', context: displaySignalContext});
        break;
      }
      // Handle setting the marker, e.g., update the marker position
      case 'setMarker': {handleMarkerSet(message.time, 0); break; }
      // Handle setting the selected signal, e.g., update the selected signal
      case 'setSelectedSignal': {handleSignalSelect(message.netlistId); break; }
      case 'getContext': {sendWebviewContext('response'); break;}
      case 'copyWaveDrom': {copyWaveDrom(); break;}
    }
  });

  // Send a message back to the extension to signal that the webview is ready
  vscode.postMessage({command: 'ready'});

  });
})();