(function () {
  const vscode = acquireVsCodeApi();

// Rendering Herlper functions

// Parse VCD values into either binary, hex, or decimal
// This function is so cursed...
parseValue = function (binaryString, width, is4State) {

  let stringArray;

  if (numberFormat === 2) {
    return binaryString.replace(/\B(?=(\d{4})+(?!\d))/g, "_");
  }

  if (numberFormat === 16) {
    if (is4State) {
      stringArray = binaryString.replace(/\B(?=(\d{4})+(?!\d))/g, "_").split("_");
      return stringArray.map((chunk) => {
        if (chunk.match(/[zZ]/)) {return "Z";}
        if (chunk.match(/[xX]/)) {return "X";}
        return parseInt(chunk, 2).toString(numberFormat);
      }).join('').replace(/\B(?=(\d{4})+(?!\d))/g, "_");
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

busElement = function (deltaTime, transition, backgroundPositionX, backgroundSizeX, textPosition, signalWidth) {
  const value            = transition[1];
  const backgroundWidth  = backgroundSizeX * zoomRatio;
  const is4State = valueIs4State(value);
  const color    = is4State ? 'background-color:var(--vscode-debugTokenExpression-error)' : '';
  const divTag   = `<div class="bus-waveform-value" style="flex:${deltaTime};-webkit-mask-position:${backgroundPositionX * zoomRatio}px;-webkit-mask-size:${backgroundWidth}px;${color}">`;

  if ((backgroundWidth > 10) && (textPosition > 0)) {
    const displayValue = parseValue(value, signalWidth, is4State);
    return `${divTag}<p>${displayValue}</p></div>`;
  } else {
    return `${divTag}</div>`;
  }
};

busElementsfromTransitionData = function (transitionData, initialState, postState, signalWidth) {
  let backgroundPositionX = Math.max(initialState[0], -1 * chunkTime);
  let result       = [];
  let initialTime  = 0;
  let initialValue = initialState;
  let deltaTime;
  let backgroundSizeX;
  let textPosition;
  let spansChunk    = true;

  transitionData.forEach((transition) => {
    deltaTime       = transition[0] - initialTime;
    backgroundSizeX = (deltaTime - backgroundPositionX);
    textPosition    = (transition[0] + initialValue[0]) / 2;
    result.push(busElement(deltaTime, initialValue, backgroundPositionX, backgroundSizeX, textPosition, signalWidth));
    spansChunk          = false;
    initialTime         = transition[0];
    initialValue        = transition;
    backgroundPositionX = 0;
  });
  deltaTime       = chunkTime - initialTime;
  backgroundSizeX = (Math.min(postState[0], 2 * chunkTime) - initialTime) - backgroundPositionX;
  textPosition  = (postState[0] + initialValue[0]) / 2;

  // let the renderer know not not to render the text if it is out of bounds
  // easier to check for this one case than to check for all cases
  if (textPosition > chunkTime) {textPosition = -1;}
  result.push(busElement(deltaTime, initialValue, backgroundPositionX, backgroundSizeX, textPosition, signalWidth));
  return result.join('');
};


//polylinePathFromTransitionData = function (transitionData, initialState, polylineAttributes) {
//  var result          = [];
//  var xzPolylines     = [];
//  var initialValue    = initialState[1];
//  var accumulatedPath = "-1," + initialValue + " ";
//  var xzAccumulatedPath = "";
//  if (initialValue === "x" | initialValue === "z") {
//    xzAccumulatedPath = "-1,0 -1,1 ";
//  }
//  transitionData.forEach(([time, value]) => {
//    if (initialValue === "x" | value === "z") {
//      xzAccumulatedPath += time + ",1 " + time + ",0 ";
//      xzPolylines.push(`<polyline points="${xzAccumulatedPath}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
//      xzAccumulatedPath = "";
//    }
//    if (value === "x" | value === "z") {
//      value = 0;
//    } else {
//      accumulatedPath += time + "," + initialValue + " ";
//      accumulatedPath += time + "," + value + " ";
//    }
//    initialValue = value;
//  });
//  if (xzAccumulatedPath !== "") {
//    xzAccumulatedPath += chunkTime + ",1";
//    xzPolylines.push(`<polyline points="${xzAccumulatedPath}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
//  }
//
//  accumulatedPath += chunkTime + "," + initialValue;
//  return `<polyline points="` + accumulatedPath + `" ${polylineAttributes}/>` + xzPolylines.join('');
//};

polylinePathFromTransitionData = function (transitionData, initialState, polylineAttributes) {
  var initialValue    = initialState[1];
  var accumulatedPath = "-1," + initialValue + " ";
  transitionData.forEach(([time, value]) => {
    if (value === "x") {value = 0;}
    accumulatedPath += time + "," + initialValue + " ";
    accumulatedPath += time + "," + value + " ";
    initialValue = value;
  });
  accumulatedPath += chunkTime + "," + initialValue;
  return `<polyline points="` + accumulatedPath + `" ${polylineAttributes}>`;
};

binaryElementFromTransitionData = function (transitionData, initialState) {
  const svgHeight  = 20;
  const waveHeight = 16;
  const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
  const polylineAttributes = `stroke="var(--vscode-debugTokenExpression-number)"`;
  const gAttributes = `fill="none" transform="translate(0.5 ${waveOffset}.5) scale(${zoomRatio} -${waveHeight})"`;
  let result = '';
  result += `<svg height="${svgHeight}" width="${chunkWidth}" viewbox="0 0 ${chunkWidth} ${svgHeight}" class="binary-waveform-svg">`;
  result += `<g ${gAttributes}>`;
  result += polylinePathFromTransitionData(transitionData, initialState, polylineAttributes);
  result += `</g></svg>`;
  return result;
};

createWaveformSVG = function (transitionData, initialState, postState, width, chunkIndex, signalId) {
  let className    = 'waveform-chunk';
  if (signalId === selectedSignal) {className += ' is-selected';}
  if (width === 1) {
    return `<div class="${className}" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              ${binaryElementFromTransitionData(transitionData, initialState)}
            </div>`;
  } else {
    return `<div class="${className}" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              ${busElementsfromTransitionData(transitionData, initialState, postState, width)}
            </div>`;
  }
};

renderWaveformChunk = function (signalId, chunkIndex) {
  var result         = {};
  const data         = waveformData[signalId];
  const timeStart    = chunkIndex * chunkTime;
  const timeEnd      = timeStart + chunkTime;
  const width        = data.signalWidth;
  const startIndex   = data.chunkStart[chunkIndex];
  const endIndex     = data.chunkStart[chunkIndex + 1];
  const initialState = data.transitionData[startIndex - 1];

  let   postState;
  if (chunkIndex === data.chunkStart.length - 1) {
    postState  = [timeEnd, data.transitionData[data.transitionData.length - 1][1]];
  } else {
    postState  = data.transitionData[endIndex];
  }
  const relativeInitialState = [initialState[0] - timeStart, initialState[1]];
  const relativePostState    = [postState[0]    - timeStart, postState[1]];

  var chunkTransitionData = data.transitionData.slice(startIndex, endIndex).map(([time, value]) => {
    //if (time < timeStart || time >= timeEnd) {
    //  console.log('transition data out of range: ' + signalId + time + ' at index ' + startIndex + '');
    //}

    return [time - timeStart, value];
  });

  result.html = createWaveformSVG(chunkTransitionData, relativeInitialState, relativePostState, width, chunkIndex, signalId);
  return result;
};

// This function creates ruler elements for a chunk
createRulerChunk = function (chunkIndex) {
  const timeMarkerInterval = rulerNumberSpacing / zoomRatio;
  const chunkStartTime     = chunkIndex * chunkTime;
  const chunkStartPixel    = chunkIndex * chunkWidth;
  const numberStartpixel   = -1 * (chunkStartPixel % rulerNumberSpacing);
  const tickStartpixel     = rulerTickSpacing   - (chunkStartPixel % rulerTickSpacing);
  var   numValue           = chunkStartTime + (numberStartpixel / zoomRatio);
  var   elements           = [];

  for (var i = numberStartpixel; i <= chunkWidth + 64; i+= rulerNumberSpacing ) {
    elements.push(`<text x="${i}" y="20">${numValue}</text>`);
    numValue += timeMarkerInterval;
  }

  for (var i = tickStartpixel; i <= chunkWidth; i+= rulerTickSpacing) {
    elements.push(`<line class="ruler-tick" x1="${i}" y1="30" x2="${i}" y2="35" stroke-width="1" />`);
  }

  return `
    <div class="ruler-chunk">
      <svg height="40" width="${chunkWidth}" class="ruler-svg">${elements.join('')}</svg>
    </div>`;
};

createBaseChunk = function (chunkIndex) {
  return `<div class="column-chunk" style="min-width:${chunkWidth}px"></div>`;
};

createTimeCursor = function (time) {
  const x = (time % chunkTime) * zoomRatio;
  return `
    <svg class="time-cursor" style="left:${x}px">
      <line x1="0" y1="0" x2="0" y2="100%" stroke-dasharray="2 2"/>
    </svg>`;
};

createLabel = function (signalId, signalName, isSelected) {
  //let selectorClass = 'is-idle';
  //if (isSelected) {selectorClass = 'is-selected';}
  const vscodeContextMenuAttribute = `data-vscode-context='{"webviewSection": "signal", "preventDefaultContextMenuItems": true}'`;
  selectorClass = isSelected ? 'is-selected' : 'is-idle';
  return `<div class="waveform-label ${selectorClass}" id="label-${signalId}" ${vscodeContextMenuAttribute}>
            <div class='codicon codicon-grabber'></div>
            <p>${signalName}</p>
          </div>`;
};

createValueDisplayElement = function (signalId, value, isSelected) {
  selectorClass      = isSelected ? 'is-selected' : 'is-idle';
  const joinString   = '<p style="color:var(--vscode-foreground)">-></p>';
  const width        = waveformData[signalId].signalWidth;
  const displayValue = value.map(v => {
    return parseValue(v, width, valueIs4State(v));
  }).join(joinString);

  return `<div class="waveform-label ${selectorClass}" id="value-${signalId}">
            <p>${displayValue}</p></div>`;
};

updateWaveformInCache = function (signalIdList) {
  signalIdList.forEach((signalId) => {
    for (var i = dataCache.startIndex; i < dataCache.endIndex; i++) {
      dataCache.columns[i].waveformChunk[signalId] = renderWaveformChunk(signalId, i);
    }
    dataCache.valueAtCursor[signalId] = getValueAtTime(signalId, cursorTime);
  });
};

// Event handler helper functions

updateChunkInCache = function (chunkIndex) {

  let result = {
    rulerChunk:    createRulerChunk(chunkIndex),
    waveformChunk: {},
    overlays:      []
  };

  displayedSignals.forEach((signalId) => {
    result.waveformChunk[signalId] = renderWaveformChunk(signalId, chunkIndex);
  });

  if (cursorChunkIndex === chunkIndex) {
    result.overlays.push(createTimeCursor(cursorTime));
  }
  return result;
};

handleZoom = function (amount) {
  // -1 zooms in, +1 zooms out
  // zoomRatio is in pixels per time unit
  zoomRatio  = zoomRatio * Math.pow(2, (-1 * amount));
  chunkWidth = chunkTime * zoomRatio;

  for (i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    dataCache.columns[i] = (updateChunkInCache(i));
  }

  updatePending = true;
  clusterizeContent.refresh(chunkWidth);
  //clusterizeContent.render();
};

// return chunks to be rendered
handleFetchColumns = function (startIndex, endIndex) {

  if (startIndex < dataCache.startIndex) {
    console.log('building chunks from ' + startIndex + ' to ' + dataCache.startIndex + '');
    for (var i = dataCache.startIndex - 1; i >= startIndex; i-=1) {
      dataCache.columns[i] = (updateChunkInCache(i));
    }
  }
  if (endIndex > dataCache.endIndex) {
    console.log('building chunks from ' + dataCache.endIndex + ' to ' + endIndex + '');
    for (var i = dataCache.endIndex; i < endIndex; i+=1) {
      dataCache.columns[i] = (updateChunkInCache(i));
    }
  }

  dataCache.startIndex = Math.min(startIndex, dataCache.startIndex);
  dataCache.endIndex   = Math.max(endIndex,   dataCache.endIndex);

  return dataCache.columns.slice(startIndex, endIndex).map(c => {
    return `<div class="column-chunk" style="width:${chunkWidth}px">
      ${c.rulerChunk}
      <div class="waveform-column" style="font-family:monospaced">
        ${displayedSignals.map((signal) => {return c.waveformChunk[signal].html;}).join('')}
      </div>
      ${c.overlays}
    </div>`;
  });
};

setSeletedSignalOnStatusBar = function (signalId) {
  vscode.postMessage({
    command: 'setSelectedSignal',
    signalId: signalId
  });
};

handleSignalSelect = function (signalId) {

  let element;
  let index;

  for (var i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    element = document.getElementById('idx' + i + '-' + chunkSample + '--' + selectedSignal);
    if (element) {
      element.classList.remove('is-selected');
      dataCache.columns[i].waveformChunk[selectedSignal].html = element.outerHTML;
    }

    element = document.getElementById('idx' + i + '-' + chunkSample + '--' + signalId);
    if (element) {
      element.classList.add('is-selected');
      dataCache.columns[i].waveformChunk[signalId].html = element.outerHTML;
    }
  }

  selectedSignal      = signalId;
  selectedSignalIndex = displayedSignals.findIndex((signal) => {return signal === signalId;});
  if (selectedSignalIndex === -1) {selectedSignalIndex = null;}

  setSeletedSignalOnStatusBar(signalId);
  renderLabelsPanels();

  if (signalId === null) {return;}

  updateButtonsForSelectedWaveform(waveformData[signalId].signalWidth);
};

unsetCursor = function () {

  if (cursorTime !== null) {
    if (cursorChunkElement !== null) {
      let timeCursor = cursorChunkElement.getElementsByClassName('time-cursor')[0];
      if (timeCursor) {timeCursor.remove();}
      //element.removeChild(timeCursor);
      console.log('removing cursor at time ' + cursorTime + ' from chunk ' + cursorChunkIndex + '');
      dataCache.columns[cursorChunkIndex].overlays = [];
    } else {
      console.log('chunk index ' + cursorChunkIndex + ' is not in cache');
    }
  }

  cursorChunkIndex   = null;
  cursorChunkElement = null;
  cursorTime         = null;
};

getValueAtTime = function (signalId, time) {

  let result = [];
  if (time === null) {return result;}

  const data        = waveformData[signalId];
  const chunk       = Math.floor(time / chunkTime);
  const startIndex  = Math.max(0, data.chunkStart[chunk] - 1);
  const endIndex    = data.chunkStart[chunk + 1] + 1;
  const searchIndex = data.transitionData.slice(startIndex, endIndex).findIndex(([t, v]) => {return t >= time;});
  const transitionIndex = startIndex + searchIndex;

  if (searchIndex === -1) {
    console.log('search found a -1 index');
    return result;
  }

  if (transitionIndex > 0) {
    result.push(data.transitionData[transitionIndex - 1][1]);
  }

  if (data.transitionData[transitionIndex][0] === time) {
    result.push(data.transitionData[transitionIndex][1]);
  }

  return result;
};

setTimeOnStatusBar = function (time) {
  vscode.postMessage({
    command: 'setTime',
    time:    time.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ","),
  });
};

handleCursorSet = function (time) {

  // dispose of old cursor
  unsetCursor();

  if (time === null) {return;}

  // first find the chunk with the cursor
  cursorChunkIndex   = Math.floor(time / chunkTime);

  // create new cursor
  if (cursorChunkIndex >= dataCache.startIndex && cursorChunkIndex < dataCache.endIndex) {
    cursorChunkElement = scrollArea.getElementsByClassName('column-chunk')[cursorChunkIndex - dataCache.startIndex];
    let cursor = createTimeCursor(time);

    cursorChunkElement.innerHTML += cursor;
    dataCache.columns[cursorChunkIndex].overlays = cursor;
    console.log('adding cursor at time ' + time + ' from chunk ' + cursorChunkIndex + '');
  } else {
    console.log('chunk index ' + cursorChunkIndex + ' is not in cache');
  }

  cursorTime = time;
  moveViewToTime(cursorTime);

  // Get values for all displayed signals at the cursor time
  displayedSignals.forEach((signalId) => {
    dataCache.valueAtCursor[signalId] = getValueAtTime(signalId, time);
  });

  setTimeOnStatusBar(time);
  renderLabelsPanels();
};

isInView = function(time) {
  const pixel      = time * zoomRatio;
  const scrollLeft = scrollArea.scrollLeft;

  if (pixel < scrollLeft || pixel > scrollLeft + viewerWidth) {return false;}
  else {return true;}
};

moveViewToTime = function(time) {
  if (isInView(time)) {return;}
  else {scrollArea.scrollLeft = (time * zoomRatio) - (viewerWidth / 2);}
};

goToNextTransition = function (direction, edge) {
  if (selectedSignal === null) {
    //handleCursorSet(cursorTime + direction);
    return;
  }

  const data = waveformData[selectedSignal];
  const time = cursorTime;
  
  let indexIncrement;

  if (edge === undefined) {
    timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time;});
    indexIncrement = 1;
  } else {
    timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= time && v === edge;});
    indexIncrement = 2;
  }

  if (timeIndex === -1) {
    console.log('search found a -1 index');
    return;
  }

  if ((direction === 1) && (time === data.transitionData[timeIndex][0])) {timeIndex += indexIncrement;}
  else if (direction === -1) {timeIndex -= indexIncrement;}

  timeIndex = Math.max(timeIndex, 0);
  timeIndex = Math.min(timeIndex, data.transitionData.length - 1);

  handleCursorSet(data.transitionData[timeIndex][0]);
};

uncacheChunks = function (startIndex, endIndex) {
  for (var i = 0; i < startIndex; i++) {
    dataCache.columns[i] = undefined;
  }
  for (var i = endIndex; i < contentData.length; i++) {
    dataCache.columns[i] = undefined;
  }

  dataCache.startIndex = startIndex;
  dataCache.endIndex   = endIndex;
};

// Run after chunks are rendered
handleClusterChanged = function (startIndex, endIndex) {

  console.log('removing chunk cache from index ' + startIndex + ' to ' + endIndex + '');
  uncacheChunks(startIndex, endIndex);

  if (cursorChunkIndex >= startIndex && cursorChunkIndex < endIndex) {
    cursorChunkElement = scrollArea.getElementsByClassName('column-chunk')[cursorChunkIndex - dataCache.startIndex];
  } else if ((cursorChunkIndex === null)) {
    cursorChunkElement = null;
  } else {
    cursorChunkElement = null;
  }
};

  // UI preferences
  rulerNumberSpacing = 100;
  rulerTickSpacing   = 10;

  // state variables
  touchpadScrolling   = false;
  selectedSignal      = null;
  selectedSignalIndex = null;
  cursorTime          = null;
  searchState         = 0;
  searchInFocus       = false;
  parsedSearchValue   = null;
  cursorChunkElement  = null;
  cursorChunkIndex    = null;
  altCursorTime       = null;
  chunkTime           = 512;
  chunkWidth          = 512;
  zoomRatio           = 1;
  chunkSample         = 1;
  viewerWidth         = 0;
  numberFormat        = 2;
  bitChunkWidth       = 4;
  contentData         = [];
  displayedSignals    = [];
  waveformData        = {};
  updatePending       = false;
  dataCache           = {
    startIndex:     0,
    endIndex:       0,
    columns:        [],
    valueAtCursor:  {}
  };

  // drag handler variables
  labelsList            = [];
  idleItems             = [];
  draggableItem         = null;
  draggableItemIndex    = null;
  draggableItemNewIndex = null;
  pointerStartX         = null;
  pointerStartY         = null;
  resizeIndex           = null;

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

  renderLabelsPanels = function () {
    let labelsList  = [];
    let transitions = [];
    let isSelected  = false;
    displayedSignals.forEach((signalId, index) => {
      isSelected = (index === selectedSignalIndex);
      labelsList.push(createLabel(signalId, waveformData[signalId].name, isSelected));
      transitions.push(createValueDisplayElement(signalId, dataCache.valueAtCursor[signalId], isSelected));
    });
    labels.innerHTML = labelsList.join('');
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

  toggleButtonState = function (buttonId) {
    if (buttonId.classList.contains('disabled-button')) {
      return;
    }
    if (buttonId.classList.contains('selected-button')) {
      buttonId.classList.remove('selected-button');
      buttonId.classList.remove('disabled-button');
    } else {
      buttonId.classList.add('selected-button');
    }
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

  handleFormatSelect = function (button) {
    numberFormat = button;
    setButtonState(formatBinary, 1);
    setButtonState(formatHex, 1);
    setButtonState(formatDecimal, 1);
    if (button === 2) {
      bitChunkWidth = 4;
      valueIconRef.setAttribute('href', '#search-binary');
      setButtonState(formatBinary, 2);
    } else if (button === 16) {
      bitChunkWidth = 16;
      valueIconRef.setAttribute('href', '#search-hex');
      setButtonState(formatHex, 2);
    } else if (button === 10) {
      bitChunkWidth = 32;
      valueIconRef.setAttribute('href', '#search-decimal');
      setButtonState(formatDecimal, 2);
    } else {
      numberFormat  = 2;
      bitChunkWidth = 4;
      console.log('formatting error: ' + button + '');
    }

    let updateSignals = displayedSignals.filter((signalId) => {return waveformData[signalId].signalWidth > 1;});
    updatePending     = true;
    handleSearchBarEntry({key: 'none'});
    updateWaveformInCache(updateSignals);
    renderLabelsPanels();
    clusterizeContent.render();
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
    const inputText = searchBar.value;
    let inputValid  = true;

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

    if (searchState === 0 && direction === 1) {
      handleCursorSet(parseInt(parsedSearchValue));
    } else {
      const signalWidth      = waveformData[selectedSignal].signalWidth;
      let trimmedSearchValue = parsedSearchValue;
      if (parsedSearchValue.length > signalWidth) {trimmedSearchValue = parsedSearchValue.slice(-1 * signalWidth);}
      let searchRegex = new RegExp(trimmedSearchValue, 'ig');
      const data      = waveformData[selectedSignal];
      const timeIndex = data.transitionData.findIndex(([t, v]) => {return t >= cursorTime;});
      let indexOffset = 0;

      if (direction === -1) {indexOffset = -1;}
      else if (cursorTime === data.transitionData[timeIndex][0]) {indexOffset = 1;}

      for (var i = timeIndex + indexOffset; i >= 0; i+=direction) {
        if (data.transitionData[i][1].match(searchRegex)) {
          handleCursorSet(data.transitionData[i][0]);
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

    updatePending = true;
    arrayMove(displayedSignals, oldIndex, newIndex);
    arrayMove(labelsList,       oldIndex, newIndex);
    handleSignalSelect(displayedSignals[newIndex]);
    renderLabelsPanels();
    clusterizeContent.render();
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
    if (updatePending) {return;}
    updatePending              = true;
    labelsScroll.scrollTop     = scrollLevel;
    transitionScroll.scrollTop = scrollLevel;
    scrollArea.scrollTop       = scrollLevel;
    updatePending              = false;
  }

  labelsScroll.addEventListener(    'scroll', (e) => {syncVerticalScroll(labelsScroll.scrollTop);});
  transitionScroll.addEventListener('scroll', (e) => {syncVerticalScroll(transitionScroll.scrollTop);});
  scrollArea.addEventListener(      'scroll', (e) => {syncVerticalScroll(scrollArea.scrollTop);});

  // scroll handler to handle zooming and scrolling
  scrollArea.addEventListener('wheel', (event) => { 
    console.log(event);
    if (!touchpadScrolling) {event.preventDefault();}
    const deltaY = event.deltaY;
    if (event.shiftKey && !touchpadScrolling) {
      event.stopPropagation();
      scrollArea.scrollTop      += deltaY;
      labelsScroll.scrollTop     = scrollArea.scrollTop;
      transitionScroll.scrollTop = scrollArea.scrollTop;
    } else if (event.ctrlKey) {
      if      (updatePending) {return;}
      const bounds      = scrollArea.getBoundingClientRect();
      const elementLeft = event.pageX - bounds.left;
      const pixelLeft   = Math.round(scrollArea.scrollLeft + elementLeft);
      const time        = Math.round(pixelLeft / zoomRatio);

      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (deltaY > 0) {handleZoom(1);}
      else if (deltaY < 0) {handleZoom(-1);}

      scrollArea.scrollLeft = (time * zoomRatio) - elementLeft;
    } else if (!touchpadScrolling){
      scrollArea.scrollLeft += deltaY;
    }
  });
  //scrollArea.addEventListener('wheel', handleScrollMouse, false);

  // move handler to handle moving the cursor or selected signal with the arrow keys
  window.addEventListener('keydown', (event) => {
    if (searchInFocus) {return;} 
    else {event.preventDefault();} 

    // left and right arrow keys move the cursor
    // ctrl + left and right arrow keys move the cursor to the next transition
    if ((event.key === 'ArrowRight') && (cursorTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(1);}
      else                {handleCursorSet(cursorTime + 1);}
    } else if ((event.key === 'ArrowLeft') && (cursorTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(-1);}
      else                {handleCursorSet(cursorTime - 1);}

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

  });

  // click handler to handle clicking inside the waveform viewer
  // gets the absolute x position of the click relative to the scrollable content
  scrollArea.addEventListener('click', (event) => {

    console.log(event);

    // Get the time position of the click
    const bounds      = scrollArea.getBoundingClientRect();
    const pixelLeft   = Math.round(scrollArea.scrollLeft + event.pageX - bounds.left);
    const time        = Math.round(pixelLeft / zoomRatio);
    handleCursorSet(time);

    // Get the signal id of the click
    let signalId      = null;
    const waveChunkId = event.target.closest('.waveform-chunk');
    if (waveChunkId) {signalId = waveChunkId.id.split('--').slice(1).join('--');}
    if (signalId)    {
      handleSignalSelect(signalId);
    }
  });

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
  };

  function handleResizeMousedown(event, resizeElement, index) {
    resizeIndex = index;
    event.preventDefault();
    resizeElement.classList.add('is-resizing');
    document.addEventListener("mousemove", resize, false);
    document.addEventListener("mouseup", () => {
      resizeElement.classList.remove('is-resizing');
      document.removeEventListener("mousemove", resize, false);
    }, false);
  };

  resize1.addEventListener("mousedown", (e) => {handleResizeMousedown(e, resize1, 1);});
  resize2.addEventListener("mousedown", (e) => {handleResizeMousedown(e, resize2, 2);});

  // Control bar button event handlers
  zoomInButton.addEventListener( 'click', (e) => {handleZoom(-1);});
  zoomOutButton.addEventListener('click', (e) => {handleZoom(1);});
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

  // format button event handlers
  formatBinary.addEventListener( 'click', (e) => {handleFormatSelect(2);});
  formatHex.addEventListener(    'click', (e) => {handleFormatSelect(16);});
  formatDecimal.addEventListener('click', (e) => {handleFormatSelect(10);});
  formatEnum.addEventListener(   'click', (e) => {toggleButtonState(formatEnum);});

  // click and drag handlers to rearrange the order of waveform signals
  labels.addEventListener('mousedown', dragStart);
  document.addEventListener('mouseup', dragEnd);

  // Event handlers to handle clicking on a waveform label to select a signal
  labels.addEventListener(           'click', (e) => clicklabel(e, labels));
  transitionDisplay.addEventListener('click', (e) => clicklabel(e, transitionDisplay));

  // Handle messages from the extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    console.log(event);
    switch (message.command) {
      case 'create-ruler': {
        vscode.postMessage({ command: 'creating ruler from the js file' });
        console.log("creating ruler");
        waveformDataSet   = message.waveformDataSet;
        document.title    = waveformDataSet.filename;
        chunkTime         = waveformDataSet.chunkTime;
        zoomRatio         = waveformDataSet.defaultZoom;
        chunkWidth        = chunkTime * zoomRatio;
        var chunkCount    = Math.ceil(waveformDataSet.timeEnd / waveformDataSet.chunkTime);
        dataCache.columns = new Array(chunkCount);

        for (var i = 0; i < chunkCount; i++) {
          contentData.push(createBaseChunk(i));
        }

        clusterizeContent  = new Clusterize({
          columnCount:     chunkCount,
          columnWidth:     chunkWidth,
          columns:         contentData,
          scrollId:        'scrollArea',
          contentId:       'contentArea',
          columnsInBlock:  4,
          blocksInCluster: 4,
          callbacks: {
            clusterWillChange: function() {},
            clusterChanged:    function(startIndex, endIndex) {handleClusterChanged(startIndex, endIndex);},
            setViewerWidth:    function(width) {viewerWidth = width;},
            scrollingProgress: function(progress) {},
            fetchColumns:      (startIndex, endIndex) => {
              console.log('running callback for fetchColumns with start index ' + startIndex + ' and end index ' + endIndex + '');
              console.log('cached columns start index ' + dataCache.startIndex + ' and end index ' + dataCache.endIndex + '');
              return handleFetchColumns(startIndex, endIndex);},
            checkUpdatePending: function() {return updatePending;},
            clearUpdatePending: function() {updatePending = false;}
          }
        });

        break;
      }
      case 'render-signal': {
        // Handle rendering a signal, e.g., render the signal based on message content

        displayedSignals.push(message.signalId);
        waveformData[message.signalId] = message.waveformData;

        //var childElement = createLabel(message.signalId, message.waveformData.name);
        //labels.innerHTML = labels.innerHTML + childElement;

        console.log(displayedSignals);
        console.log(waveformData);

        updateWaveformInCache([message.signalId]);
        renderLabelsPanels();

        updatePending    = true;
        clusterizeContent.render();

        break;
      }
      case 'remove-signal': {
        // Handle deleting a signal, e.g., remove the signal from the DOM

        const index = displayedSignals.findIndex((signalId) => signalId === message.signalId);
        console.log('deleting signal' + message.signalId + 'at index' + index);
        if (index === -1) {
          console.log('could not find signal ' + message.signalId + ' to delete');
          break;
        } else {
          displayedSignals.splice(index, 1);
          //document.getElementById('label-' + message.signalId).outerHTML = "";
          //document.getElementById('label-' + message.signalId).remove();

          updatePending    = true;
          renderLabelsPanels();
          clusterizeContent.render();

          if (selectedSignal === message.signalId) {
            handleSignalSelect(null);
          }
        }

      break;
      }
      case 'getSelectionContext': {
        setTimeOnStatusBar(cursorTime);
        setSeletedSignalOnStatusBar(selectedSignal);
        break;
      }
      case 'getContext': {
        console.log('getContext - this is a stub');
        break;
      }
    }
  });

  // Send a message back to the extension to signal that the webview is ready
  vscode.postMessage({type: 'ready'});

  });
})();