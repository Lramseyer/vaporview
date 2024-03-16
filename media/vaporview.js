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

// This function actually creates the individual bus elements, and has can
// potentially called thousands of times during a render
busElement = function (flexWidth, transition, backgroundPositionX, backgroundSizeX, deltaTime, spansChunk, signalWidth, textWidth) {
  const value            = transition[1];
  const backgroundWidth  = backgroundSizeX * zoomRatio;
  const is4State   = valueIs4State(value);
  const color      = is4State ? 'background-color:var(--vscode-debugTokenExpression-error)' : '';
  const totalWidth = deltaTime * zoomRatio;
  const initialTime = transition[0];
  let pElement      = '';
  let justifyDirection = '';

  // Don't even bother rendering text if the element is too small. Since 
  // there's an upper limit to the number of larger elements that will be 
  // displayed, we can spend a little more time rendering them and making them
  // readable in all cases.
  if (totalWidth > 10) {
    const displayValue = parseValue(value, signalWidth, is4State);
    let textOffset     = 0;
    if (totalWidth > textWidth) {
      justifyDirection = 'justify-content: center';
    }

    // If the element spans the chunk boundary, we need to center the text
    if (spansChunk) {
      justifyDirection  = 'justify-content: center';
      let leftOverflow  = Math.min(initialTime, 0);
      let rightOverflow = Math.max(initialTime + deltaTime - chunkTime, 0);
      if (totalWidth < textWidth) {
        textOffset        = ((totalWidth - textWidth) / 2) - 5;
      }
      textOffset       += ((leftOverflow + rightOverflow) / 2) * zoomRatio;
    }

    // If the element is too wide to fit in the viewer, we need to display
    // the value in multiple places so it's always in sight
    if (totalWidth > viewerWidth) {
      // count the number of text elements that will be displayed 1 viewer width or 1 text width + 20 px (whichever is greater) in this state
      let elementWidth   = flexWidth * zoomRatio;
      let renderInterval = Math.max(viewerWidth, textWidth + 50);
      let textCount      = 1 + Math.floor((totalWidth - textWidth) / renderInterval);
      // figure out which ones are in the chunk and where they are relative to the chunk boundary
      let firstOffset    = Math.min(transition[0] * zoomRatio, 0) + ((totalWidth - ((textCount - 1) * renderInterval)) / 2);
      let lowerBound     = -0.5 * (textWidth + elementWidth);
      let upperBound     =  0.5 * (textWidth + elementWidth);
      let textPosition   = firstOffset - (0.5 * elementWidth);
      let offsetStart         = Math.floor((lowerBound - firstOffset) / renderInterval);
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
  }
  
  const divTag  = `<div class="bus-waveform-value" style="flex:${flexWidth};-webkit-mask-position:${backgroundPositionX * zoomRatio}px;-webkit-mask-size:${backgroundWidth}px;${color};${justifyDirection}">`;
  return `${divTag}${pElement}</div>`;
};

busElementsfromTransitionData = function (transitionData, initialState, postState, signalWidth, textWidth) {
  let backgroundPositionX = Math.max(initialState[0], -1 * chunkTime);
  let result       = [];
  let initialTime  = 0;
  let initialValue = initialState;
  let flexWidth;
  let backgroundSizeX;
  let deltaTime;
  let spansChunk    = true;

  transitionData.forEach((transition) => {
    flexWidth       = transition[0] - initialTime;
    backgroundSizeX = (flexWidth - backgroundPositionX);
    deltaTime       = (transition[0] - initialValue[0]);
    result.push(busElement(flexWidth, initialValue, backgroundPositionX, backgroundSizeX, deltaTime, spansChunk, signalWidth, textWidth));
    spansChunk          = false;
    initialTime         = transition[0];
    initialValue        = transition;
    backgroundPositionX = 0;
  });
  spansChunk      = true;
  deltaTime       = postState[0] - initialValue[0];
  flexWidth       = chunkTime - initialTime;
  backgroundSizeX = (Math.min(postState[0], 2 * chunkTime) - initialTime) - backgroundPositionX;

  result.push(busElement(flexWidth, initialValue, backgroundPositionX, backgroundSizeX, deltaTime, spansChunk, signalWidth, textWidth));
  return result.join('');
};

polylinePathFromTransitionData = function (transitionData, initialState, polylineAttributes) {
  var deltaTime;
  var xzPolylines        = [];
  var initialValue       = initialState[1];
  var initialValue2state = initialValue;
  var initialTime        = Math.max(initialState[0], -10);
  var xzAccumulatedPath = "";
  if (initialValue === "x" | initialValue === "z") {
    xzAccumulatedPath = "-1,0 -1,1 ";
    initialValue2state = 0;
  }
  var accumulatedPath    = "-1," + initialValue2state + " ";

  transitionData.forEach(([time, value]) => {
    if (initialValue === "x" | initialValue === "z") {
      deltaTime          = time - initialTime;
      xzPolylines.push(`<rect x="${initialTime}" y="0" height="1" width="${deltaTime}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      initialValue2state = 0;
    }

    accumulatedPath += time + "," + initialValue2state + " ";

    if (value === "x" | value === "z") {accumulatedPath += time + "," + 0 + " ";}
    else                               {accumulatedPath += time + "," + value + " ";}

    initialTime        = time;
    initialValue       = value;
    initialValue2state = value;
  });
  if (initialValue === "x" | initialValue === "z")  {
    deltaTime = chunkTime - initialTime + 10;
    xzPolylines.push(`<rect x="${initialTime}" y="0" height="1" width="${deltaTime}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
    initialValue2state = 0;
  }

  accumulatedPath += chunkTime + "," + initialValue2state;
  return `<polyline points="` + accumulatedPath + `" ${polylineAttributes}/>` + xzPolylines.join('');
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

createWaveformSVG = function (transitionData, initialState, postState, width, chunkIndex, signalId, textWidth) {
  let className    = 'waveform-chunk';
  if (signalId === selectedSignal) {className += ' is-selected';}
  if (width === 1) {
    return `<div class="${className}" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              ${binaryElementFromTransitionData(transitionData, initialState)}
            </div>`;
  } else {
    return `<div class="${className}" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              ${busElementsfromTransitionData(transitionData, initialState, postState, width, textWidth)}
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
  const textWidth    = data.textWidth;

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

  result.html = createWaveformSVG(chunkTransitionData, relativeInitialState, relativePostState, width, chunkIndex, signalId, textWidth);
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
  var   textElements       = [];
  var   tickElements       = [];

  for (var i = numberStartpixel; i <= chunkWidth + 64; i+= rulerNumberSpacing ) {
    textElements.push(`<text x="${i}" y="20">${numValue * timeScale}</text>`);
    numValue += timeMarkerInterval;
  }

  for (var i = tickStartpixel; i <= chunkWidth; i+= rulerTickSpacing) {
    //tickElements.push(`<line x1="${i}" y1="30" x2="${i}" y2="35"/>`);
    tickElements.push(`<use href="#rt" x="${i}"/>`);
  }

  return `
    <div class="ruler-chunk">
      <svg height="40" width="${chunkWidth}" class="ruler-svg">
        <symbol id="rt" viewBox="0 0 ${chunkWidth} 40"><line class="ruler-tick" x1="0" y1="30" x2="0" y2="35"/></symbol>
        ${textElements.join('')}${tickElements.join('')}
      </svg>
    </div>`;
};

createBaseChunk = function (chunkIndex) {
  return `<div class="column-chunk" style="min-width:${chunkWidth}px"></div>`;
};

createTimeCursor = function (time, cursorType) {
  const x  = (time % chunkTime) * zoomRatio;
  const id = cursorType === 0 ? 'main-cursor' : 'alt-cursor';
  return `
    <svg id="${id}" class="time-cursor" style="left:${x}px">
      <line x1="0" y1="0" x2="0" y2="100%"/>
    </svg>`;
};

createLabel = function (signalId, signalName, isSelected) {
  //let selectorClass = 'is-idle';
  //if (isSelected) {selectorClass = 'is-selected';}
  const vscodeContextMenuAttribute = `data-vscode-context='{"webviewSection": "signal", "preventDefaultContextMenuItems": true, "signalId": "${signalId}"}'`;
  const selectorClass = isSelected ? 'is-selected' : 'is-idle';
  const modulePath    = waveformData[signalId].modulePath + '.';
  const fullPath      = modulePath + signalName;
  return `<div class="waveform-label ${selectorClass}" id="label-${signalId}" title="${fullPath}" ${vscodeContextMenuAttribute}>
            <div class='codicon codicon-grabber'></div>
            <p style="opacity:50%">${modulePath}</p><p>${signalName}</p>
          </div>`;
};

createValueDisplayElement = function (signalId, value, isSelected) {

  if (value === undefined) {value = [];}

  const selectorClass = isSelected ? 'is-selected' : 'is-idle';
  const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
  const width         = waveformData[signalId].signalWidth;
  const displayValue  = value.map(v => {
    return parseValue(v, width, valueIs4State(v));
  }).join(joinString);

  return `<div class="waveform-label ${selectorClass}" id="value-${signalId}">
            <p>${displayValue}</p></div>`;
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

updateWaveformInCache = function (signalIdList) {
  console.log(dataCache);
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
    cursor:        [],
    altCursor:     [],
  };

  displayedSignals.forEach((signalId) => {
    result.waveformChunk[signalId] = renderWaveformChunk(signalId, chunkIndex);
  });

  if (cursorChunkIndex === chunkIndex) {
    result.cursor = createTimeCursor(cursorTime, 0);
  }
  if (altCursorChunkIndex === chunkIndex) {
    result.altCursor = createTimeCursor(altCursorTime, 1);
  }
  return result;
};

// Event handler helper functions
handleZoom = function (amount, adjustScroll) {
  // -1 zooms in, +1 zooms out
  // zoomRatio is in pixels per time unit
  if (amount === 0) {return;}

  const newZoomRatio  = zoomRatio * Math.pow(2, (-1 * amount));
  const centerTime    = (scrollArea.scrollLeft + (viewerWidth / 2)) / zoomRatio;
  touchpadScrollCount = 0;

  if (newZoomRatio > maxZoomRatio) {
    console.log('zoom ratio is too high: ' + newZoomRatio + '');
    return;
  }

  zoomRatio  = newZoomRatio;
  chunkWidth = chunkTime * zoomRatio;

  for (i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    dataCache.columns[i] = (updateChunkInCache(i));
  }

  updatePending = true;
  clusterizeContent.refresh(chunkWidth);
  //clusterizeContent.render();

  if (adjustScroll) {
    scrollArea.scrollLeft = centerTime * zoomRatio - (viewerWidth / 2);
  }

  handleUpdatePending();
};

// return chunks to be rendered
handleFetchColumns = function (startIndex, endIndex) {

  if (startIndex < dataCache.startIndex) {
    const upperBound = Math.min(dataCache.startIndex, endIndex);
    console.log('building chunks from ' + startIndex + ' to ' + upperBound + '');
    for (var i = upperBound - 1; i >= startIndex; i-=1) {
      dataCache.columns[i] = (updateChunkInCache(i));
    }
  }
  if (endIndex > dataCache.endIndex) {
    const lowerBound = Math.max(dataCache.endIndex, startIndex);
    console.log('building chunks from ' + lowerBound + ' to ' + endIndex + '');
    for (var i = lowerBound; i < endIndex; i+=1) {
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
      ${c.cursor}
      ${c.altCursor}
    </div>`;
  });
};

// Experimental asynchronous rendering path
renderWaveformsAsync_new = async function (node, chunkIndex) {
  let innerHtml;
  let chunkData = {};

  try {
    console.log('rendering chunk async ' + chunkIndex + '');

    // Render each waveform chunk asynchronously
    for (let signalId of displayedSignals) {
      // Check the abort flag at the start of each iteration
      if (dataCache.columns[chunkIndex].abortFlag) {continue;}

      // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
      await new Promise(resolve => requestAnimationFrame(() => {
        chunkData[signalId] = renderWaveformChunk(signalId, chunkIndex);
        if (!dataCache.columns[chunkIndex]) {console.log(chunkIndex);}
        resolve();
      }));
    }
    
    if (!dataCache.columns[chunkIndex].abortFlag) {
      dataCache.columns[chunkIndex].waveformChunk = chunkData;
      innerHtml = displayedSignals.map(signal => dataCache.columns[chunkIndex].waveformChunk[signal].html).join('');
    }

    // Update the DOM in the next animation frame
    await new Promise(resolve => requestAnimationFrame(() => {
      let domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + chunkSample);
      if (domRef && !dataCache.columns[chunkIndex].abortFlag) { // Always check if the element still exists
        domRef.innerHTML = innerHtml;
        node.classList.remove('rendering-chunk');
      }
      resolve();
    }));

    if (dataCache.columns[chunkIndex]) {
      if (dataCache.columns[chunkIndex].abortFlag) {
        console.log('aborting render for chunk ' + chunkIndex);
          console.log('late deleting chunk  ' + chunkIndex);
          dataCache.columns[chunkIndex] = undefined;
      } else {
        dataCache.columns[chunkIndex].isSafeToRemove = true;
      }
    }
  } finally {

    dataCache.updatesPending -= 1;
    handleUpdatePending();
  }
};

renderWaveformsAsync_gpt = async function (node, chunkIndex) {
  try {
    let innerHtml;
    let chunkData = {};

    console.log('rendering chunk async ' + chunkIndex + '');

    // Render each waveform chunk asynchronously
    for (let signalId of displayedSignals) {
      // Check the abort flag at the start of each iteration
      if (dataCache.columns[chunkIndex] && dataCache.columns[chunkIndex].abortFlag) continue;

      // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
      await new Promise(resolve => requestAnimationFrame(() => {
        if (dataCache.columns[chunkIndex]) { // Ensure chunk still exists
          chunkData[signalId] = renderWaveformChunk(signalId, chunkIndex);
        }
        resolve();
      }));
    }

    if (dataCache.columns[chunkIndex] && !dataCache.columns[chunkIndex].abortFlag) {
      dataCache.columns[chunkIndex].waveformChunk = chunkData;
      innerHtml = displayedSignals.map(signal => dataCache.columns[chunkIndex].waveformChunk[signal].html).join('');
    }

    // Update the DOM in the next animation frame
    await new Promise(resolve => requestAnimationFrame(() => {
      let domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + chunkSample);
      if (domRef && dataCache.columns[chunkIndex] && !dataCache.columns[chunkIndex].abortFlag) {
        domRef.innerHTML = innerHtml;
        node.classList.remove('rendering-chunk');
      }
      resolve();
    }));

    if (dataCache.columns[chunkIndex]) {
      if (dataCache.columns[chunkIndex].abortFlag) {
        console.log('aborting render for chunk ' + chunkIndex);
          console.log('late deleting chunk  ' + chunkIndex);
          dataCache.columns[chunkIndex] = undefined;
      } else {
        dataCache.columns[chunkIndex].isSafeToRemove = true;
      }
    }
  } finally {
    // This block executes regardless of whether the try block succeeds or an error occurs
    dataCache.updatesPending -= 1;
    handleUpdatePending();
  }
};

handleUpdatePending = function () {
  if (dataCache.updatesPending === 0) {
    console.log('all updates are done, running garbage collection');
    updatePending = false;
    garbageCollectChunks();
  }
};

flagDeleteChunk = function (chunkIndex) {

  if (!dataCache.columns[chunkIndex]) {return;}
  dataCache.columns[chunkIndex].abortFlag = true;

  if (dataCache.updatesPending === 0) {
    dataCache.columns[chunkIndex] = undefined;
  }
};

garbageCollectChunks = function () {
  for (var i = 0; i < dataCache.startIndex; i++) {
    if (!updatePending) {
      dataCache.columns[i] = undefined;
    } else {
      console.log('aborting garbage collection');
      return;
    }
  }
  for (var i = dataCache.endIndex; i < dataCache.columns.length; i++) {
    if (!updatePending) {
      dataCache.columns[i] = undefined;
    } else {
      console.log('aborting garbage collection');
      return;
    }
  }
};

uncacheChunks = function (startIndex, endIndex, deleteChunk) {

  for (var i = dataCache.startIndex; i < startIndex; i++) {
    flagDeleteChunk(i);
  }
  for (var i = dataCache.endIndex - 1; i >= endIndex; i-=1) {
    flagDeleteChunk(i);
  }
};

updateChunkInCacheShallow = function (chunkIndex) {

  if (dataCache.columns[chunkIndex]) {
    dataCache.columns[chunkIndex].abortFlag = false;
    console.log('chunk ' + chunkIndex + ' is already in cache');
    return;
  }

  let result = {
    rulerChunk:    createRulerChunk(chunkIndex),
    cursor:        [],
    altCursor:     [],
    abortFlag:     false,
    isSafeToRemove: false,
  };

  if (cursorChunkIndex === chunkIndex) {
    result.cursor = createTimeCursor(cursorTime, 0);
  }
  if (altCursorChunkIndex === chunkIndex) {
    result.altCursor = createTimeCursor(altCursorTime, 1);
  }

  dataCache.columns[chunkIndex] = result;
};

shallowFetchColumns = function (startIndex, endIndex) {

  console.log('shallow fetching chunks from ' + startIndex + ' to ' + endIndex + '');

  if (startIndex < dataCache.startIndex) {
    const upperBound = Math.min(dataCache.startIndex, endIndex);
    console.log('building shallow chunks from ' + startIndex + ' to ' + upperBound + '');
    for (var i = upperBound - 1; i >= startIndex; i-=1) {
      updateChunkInCacheShallow(i);
    }
  }
  if (endIndex > dataCache.endIndex) {
    const lowerBound = Math.max(dataCache.endIndex, startIndex);
    console.log('building shallow chunks from ' + lowerBound + ' to ' + endIndex + '');
    for (var i = lowerBound; i < endIndex; i+=1) {
      updateChunkInCacheShallow(i);
    }
  }

  dataCache.startIndex = Math.min(startIndex, dataCache.startIndex);
  dataCache.endIndex   = Math.max(endIndex,   dataCache.endIndex);

  let j = startIndex;
  let shallowChunkClass;
  let idTag;
  return dataCache.columns.slice(startIndex, endIndex).map(c => {
    let result;
    let waveforms = "";
    shallowChunkClass = "";
    idTag = `${j}-${chunkSample}`;
    if (!c) {console.log('chunk ' + j + ' is undefined');}
    if (c.waveformChunk) {
      waveforms = displayedSignals.map((signal) => {return c.waveformChunk[signal].html;}).join('');
    } else {
      shallowChunkClass = " shallow-chunk";
      
    }

    result = `<div class="column-chunk${shallowChunkClass}" id="column-${idTag}" style="width:${chunkWidth}px">
    ${c.rulerChunk}
    <div class="waveform-column" id="waveform-column-${idTag}" style="font-family:monospaced">
    ${waveforms}
    </div>
    ${c.cursor}
    ${c.altCursor}
    </div>`;
    
    c.isSafeToRemove = true;
    j += 1;
    return result;
  });
};

handleClusterChanged = function (startIndex, endIndex) {
  //console.log('deleting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
  //console.log('chunk cache start index: ' + dataCache.startIndex + ' end index: ' + dataCache.endIndex + '');
  uncacheChunks(startIndex, endIndex);
  dataCache.startIndex     = startIndex;
  dataCache.endIndex       = endIndex;
};

// Run after chunks are rendered
handleClusterWillChange = function (startIndex, endIndex) {

  console.log('aborting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
  console.log('chunk cache start index: ' + dataCache.startIndex + ' end index: ' + dataCache.endIndex + '');

  //uncacheChunks(startIndex, endIndex);

  if (cursorChunkIndex >= startIndex && cursorChunkIndex < endIndex) {
    cursorChunkElement = scrollArea.getElementsByClassName('column-chunk')[cursorChunkIndex - dataCache.startIndex];
  } else {
    cursorChunkElement = null;
  }

  if (altCursorChunkIndex >= startIndex && altCursorChunkIndex < endIndex) {
    altCursorChunkElement = scrollArea.getElementsByClassName('column-chunk')[altCursorChunkIndex - dataCache.startIndex];
  } else {
    altCursorChunkElement = null;
  }
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

getNearestTransitionIndex = function (signalId, time) {

  if (time === null) {return -1;}

  let endIndex;
  const data        = waveformData[signalId];
  const chunk       = Math.floor(time / chunkTime);
  const startIndex  = Math.max(0, data.chunkStart[chunk] - 1);
  if (chunk === chunkCount - 1) {
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

  let result            = [];
  const data            = waveformData[signalId].transitionData;
  const transitionIndex = getNearestTransitionIndex(signalId, time);

  if (transitionIndex === -1) {return result;}

  if (transitionIndex > 0) {
    result.push(data[transitionIndex - 1][1]);
  }

  if (data[transitionIndex][0] === time) {
    result.push(data[transitionIndex][1]);
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

setTimeOnStatusBar = function () {
  // .toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  vscode.postMessage({
    command: 'setTime',
    time:    cursorTime,
    altTime: altCursorTime
  });
};

handleCursorSet = function (time, cursorType) {

  let   oldCursorTime = cursorType === 0 ? cursorTime         : altCursorTime;
  let   chunkElement  = cursorType === 0 ? cursorChunkElement : altCursorChunkElement;
  let   chunkIndex    = cursorType === 0 ? cursorChunkIndex   : altCursorChunkIndex;
  const id            = cursorType === 0 ? 'main-cursor'      : 'alt-cursor';
  const cacheRef      = cursorType === 0 ? 'cursor'           : 'altCursor';

  // dispose of old cursor
  if (oldCursorTime !== null) {
    if (chunkElement) {
      let timeCursor = document.getElementById(id);
      if (timeCursor) {timeCursor.remove();}
      console.log('removing cursor at time ' + oldCursorTime + ' from chunk ' + chunkIndex + '');
      dataCache.columns[chunkIndex][cacheRef] = [];
    } else {
      console.log('chunk index ' + chunkIndex + ' is not in cache');
    }
  }

  if (time === null) {
    if (cursorType === 0) {
      cursorTime         = null;
      cursorChunkElement = null;
      cursorChunkIndex   = null;
    } else {
      altCursorTime         = null;
      altCursorChunkElement = null;
      altCursorChunkIndex   = null;
    }
    return;
  }

  // first find the chunk with the cursor
  chunkIndex   = Math.floor(time / chunkTime);

  // create new cursor
  if (chunkIndex >= dataCache.startIndex && chunkIndex < dataCache.endIndex) {
    chunkElement = scrollArea.getElementsByClassName('column-chunk')[chunkIndex - dataCache.startIndex];
    let cursor = createTimeCursor(time, cursorType);

    chunkElement.innerHTML += cursor;
    dataCache.columns[chunkIndex][cacheRef] = cursor;

    console.log('adding cursor at time ' + time + ' from chunk ' + chunkIndex + '');
  } else {
    console.log('chunk index ' + chunkIndex + ' is not in cache');
  }

  if (cursorType === 0) {
    cursorTime            = time;
    cursorChunkElement    = chunkElement;
    cursorChunkIndex      = chunkIndex;

    moveViewToTime(time);

    // Get values for all displayed signals at the cursor time
    displayedSignals.forEach((signalId) => {
      dataCache.valueAtCursor[signalId] = getValueAtTime(signalId, time);
    });

    renderLabelsPanels();
  } else {
    altCursorTime         = time;
    altCursorChunkElement = chunkElement;
    altCursorChunkIndex   = chunkIndex;
  }

  setTimeOnStatusBar();
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
    //handleCursorSet(cursorTime + direction, 0);
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

  handleCursorSet(data.transitionData[timeIndex][0], 0);
};

  // UI preferences
  rulerNumberSpacing = 100;
  rulerTickSpacing   = 10;

  // state variables
  touchpadScrolling   = false;
  touchpadScrollCount = 0;
  selectedSignal      = null;
  selectedSignalIndex = null;
  searchState         = 0;
  searchInFocus       = false;
  parsedSearchValue   = null;
  cursorTime          = null;
  cursorChunkElement  = null;
  cursorChunkIndex    = null;
  altCursorTime       = null;
  altCursorChunkElement = null;
  altCursorChunkIndex = null;
  timeScale           = 1;
  chunkTime           = 512;
  chunkWidth          = 512;
  zoomRatio           = 1;
  maxZoomRatio        = 64;
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
    valueAtCursor:  {},
    updatesPending: 0
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
    let data;
    displayedSignals.forEach((signalId, index) => {
      data = waveformData[signalId];
      data.textWidth = getValueTextWidth(data.signalWidth, numberFormat);
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

    let updateSignals = displayedSignals.filter((signalId) => {
      return waveformData[signalId].signalWidth > 1;
    });
    updatePending     = true;
    handleSearchBarEntry({key: 'none'});
    renderLabelsPanels();
    updateWaveformInCache(updateSignals);
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
      handleCursorSet(parseInt(parsedSearchValue), 0);
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
          handleCursorSet(data.transitionData[i][0], 0);
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

  function resetTouchpadScrollCount() {
    touchpadScrollCount = 0;
  };

  // scroll handler to handle zooming and scrolling
  scrollArea.addEventListener('wheel', (event) => { 

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
      if      (!touchpadScrolling && (deltaY > 0)) {handleZoom(1, false);}
      else if (!touchpadScrolling && (deltaY < 0)) {handleZoom(-1, false);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else if (touchpadScrolling) {
        touchpadScrollCount += deltaY;
        clearTimeout(resetTouchpadScrollCount);
        setTimeout(resetTouchpadScrollCount, 1000);
        handleZoom(Math.round(touchpadScrollCount / 25), false);
      }

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

    if (event.key === 'd' && event.ctrlKey) {
      console.log(updatePending);
      console.log(dataCache);
    }

    // left and right arrow keys move the cursor
    // ctrl + left and right arrow keys move the cursor to the next transition
    if ((event.key === 'ArrowRight') && (cursorTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(1);}
      else                {handleCursorSet(cursorTime + 1, 0);}
    } else if ((event.key === 'ArrowLeft') && (cursorTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(-1);}
      else                {handleCursorSet(cursorTime - 1, 0);}

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

  function getTimeFromClick(event) {
    const bounds      = scrollArea.getBoundingClientRect();
    const pixelLeft   = Math.round(scrollArea.scrollLeft + event.pageX - bounds.left);
    return Math.round(pixelLeft / zoomRatio);
  }

  function handleScrollAreaClick(event, eventButton) {

    console.log(event);

    button = eventButton;
  
    if (eventButton === 1) {event.preventDefault();}
    if (eventButton === 2) {return;}
    if (eventButton === 0 && event.altKey) {button = 1;}

    const snapToDistance = 3.5;

    // Get the time position of the click
    const time     = getTimeFromClick(event);
    let snapToTime = time;

    // Get the signal id of the click
    let signalId      = null;
    const waveChunkId = event.target.closest('.waveform-chunk');
    if (waveChunkId) {signalId = waveChunkId.id.split('--').slice(1).join('--');}
    if (signalId)    {
      if (button === 0) {
        handleSignalSelect(signalId);
      }

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = getNearestTransition(signalId, time);
      const nearestTime       = nearestTransition[0];
      const pixelDistance     = Math.abs(nearestTime - time) * zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
    }

    handleCursorSet(snapToTime, button);
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

  // click handler to handle clicking inside the waveform viewer
  // gets the absolute x position of the click relative to the scrollable content
  scrollArea.addEventListener('click',     (e) => {handleScrollAreaClick(e, 0);});
  scrollArea.addEventListener('mousedown', (e) => {if (e.button === 1) {handleScrollAreaClick(e, 1);}});

  // resize handler to handle column resizing
  resize1.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize1, 1);});
  resize2.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize2, 2);});

  // Control bar button event handlers
  zoomInButton.addEventListener( 'click', (e) => {handleZoom(-1, true);});
  zoomOutButton.addEventListener('click', (e) => {handleZoom(1, true);});
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

  mutationObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.classList.contains('shallow-chunk')) {
          node.classList.remove('shallow-chunk');
          node.classList.add('rendering-chunk');
          let chunkIndex = parseInt(node.id.split('-')[1]);
          const data     = dataCache.columns[chunkIndex];
          if (!data || data.abortFlag || !data.isSafeToRemove) {
            console.log('chunk ' + chunkIndex + ' is not safe to touch');
            console.log(data);
            return;
          }
          dataCache.columns[chunkIndex].isSafeToRemove = false;
          dataCache.updatesPending++;
          renderWaveformsAsync_new(node, chunkIndex);
        }
      });
    });
  });
  mutationObserver.observe(contentArea, {childList: true});

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
        timeScale         = waveformDataSet.timeScale;
        maxZoomRatio      = zoomRatio * 64;
        chunkWidth        = chunkTime * zoomRatio;
        chunkCount        = Math.ceil(waveformDataSet.timeEnd / waveformDataSet.chunkTime);
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
            clusterWillChange: function(startIndex, endIndex) {handleClusterWillChange(startIndex, endIndex);},
            clusterChanged:    function(startIndex, endIndex) {handleClusterChanged(startIndex, endIndex);},
            setViewerWidth:    function(width) {viewerWidth = width;},
            scrollingProgress: function(progress) {},
            fetchColumns:      (startIndex, endIndex) => {return shallowFetchColumns(startIndex, endIndex);},
            checkUpdatePending: function() {return updatePending;},
            clearUpdatePending: function() {handleUpdatePending();}
          }
        });

        break;
      }
      case 'render-signal': {
        // Handle rendering a signal, e.g., render the signal based on message content

        displayedSignals.push(message.signalId);
        waveformData[message.signalId] = message.waveformData;
        waveformData[message.signalId].textWidth = getValueTextWidth(message.waveformData.signalWidth, numberFormat);

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
        setTimeOnStatusBar();
        setSeletedSignalOnStatusBar(selectedSignal);

        let displaySignalContext = displayedSignals.map((signalId) => {
          return {
            signalId: signalId,
            signalName: waveformData[signalId].name,
            modulePath: waveformData[signalId].modulePath
          };
        });

        //vscode.postMessage({type: 'context', context: displaySignalContext});
        break;
      }
      case 'getContext': {
        return displayedSignals.map((signalId) => {
          return waveformData[signalId].modulePath + "." + waveformData[signalId].name;
        });
      }
    }
  });

  // Send a message back to the extension to signal that the webview is ready
  vscode.postMessage({type: 'ready'});

  });
})();