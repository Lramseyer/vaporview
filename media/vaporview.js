/* eslint-disable no-undef */
(function () {
  const vscode = acquireVsCodeApi();

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

htmlSafe = function (string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
};

htmlAttributeSafe = function (string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};

// This function actually creates the individual bus elements, and has can
// potentially called thousands of times during a render
busElement = function (time, deltaTime, displayValue, spansChunk, textWidth, leftOverflow, rightOverflow) {
  let pElement           = '';
  let justifyDirection   = '';
  let textOffset         = 0;
  const totalWidth       = deltaTime * zoomRatio; 
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
    textOffset       += ((leftOverflow + rightOverflow) / 2) * zoomRatio;
    flexWidthOverflow = rightOverflow - leftOverflow;
  }

  let flexWidth    = deltaTime - flexWidthOverflow;
  let elementWidth = flexWidth * zoomRatio;

  // If the element is too wide to fit in the viewer, we need to display
  // the value in multiple places so it's always in sight
  if (totalWidth > viewerWidth) {
    // count the number of text elements that will be displayed 1 viewer width or 1 text width + 20 px (whichever is greater) in this state
    let renderInterval = Math.max(viewerWidth, textWidth + 20);
    let textCount      = 1 + Math.floor((totalWidth - textWidth) / renderInterval);
    // figure out which ones are in the chunk and where they are relative to the chunk boundary
    let firstOffset    = Math.min(time * zoomRatio, 0) + ((totalWidth - ((textCount - 1) * renderInterval)) / 2);
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
  const minTextWidth  = 12 / zoomRatio;
  const minDrawWidth  = 1 / zoomRatio;
  let leftOverflow    = Math.min(initialState[0], 0);
  const rightOverflow = Math.max(postState[0] - columnTime, 0);

  for (let i = 0; i < transitionData.length; i++) {

    elementWidth = transitionData[i][0] - time;

    // If the element is too small to draw, we need to skip it
    if (elementWidth > minDrawWidth) {

      if (moveCursor) {
        points.push(time + ',0');
        endPoints.push(time + ',0');
        moveCursor = false;
      }

      is4State     = valueIs4State(value);
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
        textElements += busElement(time, elementWidth, parseValue(value, signalWidth, is4State, numberFormat), spansChunk, textWidth, leftOverflow, 0);
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
    is4State     = valueIs4State(value);
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
    textElements += busElement(time, elementWidth, parseValue(value, signalWidth, is4State, numberFormat), true, textWidth, leftOverflow, rightOverflow);
  } else {
    emptyDivWidth += elementWidth + leftOverflow - rightOverflow;
    textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
  }

  let polyline      = points.concat(endPoints.reverse()).join(' ');
  const svgHeight   = 20;
  const gAttributes = `stroke="none" transform="scale(${zoomRatio})"`;
  const polylineAttributes = `fill="var(--vscode-debugTokenExpression-number)"`;
  let backgroundStrokes = "";
  if (drawBackgroundStrokes) {
    backgroundStrokes += `<polyline points="0,0 ${columnTime},0" stroke="var(--vscode-debugTokenExpression-number)" stroke-width="3px" stroke-opacity="40%" vector-effect="non-scaling-stroke"/>`;
    backgroundStrokes += `<polyline points="0,0 ${columnTime},0" stroke="var(--vscode-debugTokenExpression-number)" stroke-width="1px" stroke-opacity="80%" vector-effect="non-scaling-stroke"/>`;
  }
  let result = '';
  result += `<svg height="${svgHeight}" width="${columnWidth}" viewbox="0 -10 ${columnWidth} ${svgHeight}" class="bus-waveform-svg">`;
  result += `<g ${gAttributes}>${backgroundStrokes}<polyline ${polylineAttributes} points="${polyline}"/>${xzValues.join("")}</g></svg>`;
  result += textElements;

  return result;
};

polylinePathFromTransitionDataOld = function (transitionData, initialState, postState, polylineAttributes) {
  var xzPolylines        = [];
  var initialValue       = initialState[1];
  var initialValue2state = initialValue;
  var initialTime        = Math.max(initialState[0], -10);
  const minDrawWidth     = 1 / zoomRatio;
  var xzAccumulatedPath = "";
  if (valueIs4State(initialValue)) {
    xzAccumulatedPath = "-1,0 -1,1 ";
    initialValue2state = 0;
  }
  var accumulatedPath    = "-1," + initialValue2state + " ";

  transitionData.forEach(([time, value]) => {
    if (valueIs4State(initialValue)) {
      xzPolylines.push(`<polyline points="${initialTime},0 ${time},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      xzPolylines.push(`<polyline points="${initialTime},1 ${time},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      xzPolylines.push(`<polyline points="${time},0 ${time},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      if (initialTime >= 0) {
        xzPolylines.push(`<polyline points="${initialTime},0 ${initialTime},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      }
      initialValue2state = 0;
    }

    accumulatedPath += time + "," + initialValue2state + " ";

    if (valueIs4State(value)) {accumulatedPath += time + "," + 0 + " ";}
    else                      {accumulatedPath += time + "," + value + " ";}

    initialTime        = time;
    initialValue       = value;
    initialValue2state = value;
  });
  if (valueIs4State(initialValue))  {
    xzPolylines.push(`<polyline points="${initialTime},0 ${columnTime},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
    xzPolylines.push(`<polyline points="${initialTime},1 ${columnTime},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
    if (initialTime >= 0) {
      xzPolylines.push(`<polyline points="${initialTime},0 ${initialTime},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
    }
    initialValue2state = 0;
  }

  accumulatedPath += columnTime + "," + initialValue2state;
  let polyline = `<polyline points="` + accumulatedPath + `" ${polylineAttributes}/>`;
  let shadedArea = `<polygon points="0,0 ${accumulatedPath} ${columnTime},0" stroke="none" fill="var(--vscode-debugTokenExpression-number)" fill-opacity="0.1"/>`;
  return polyline + shadedArea + xzPolylines.join('');
};

polylinePathFromTransitionData = function (transitionData, initialState, postState, polylineAttributes) {
  var xzPolylines        = [];
  var initialValue       = initialState[1];
  var initialValue2state = initialValue;
  var initialTime        = initialState[0];
  var initialTimeOrStart = Math.max(initialState[0], -10);
  const minDrawWidth     = 1 / zoomRatio;
  var xzAccumulatedPath = "";

  if (valueIs4State(initialValue)) {
    xzAccumulatedPath = "-1,0 -1,1 ";
    initialValue2state = 0;
  }
  var accumulatedPath    = ["-1," + initialValue2state];

  let value2state    = 0;
  // No Draw Code
  let lastDrawTime   = -1;
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
        if (valueIs4State(initialValue)) {initialValue2state = 0;}

        noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + lastNoDrawTime + ",1 " + lastNoDrawTime + ",0 ");
        accumulatedPath.push(lastDrawTime + "," + 0);
        accumulatedPath.push(lastNoDrawTime + "," + 0);
        //accumulatedPath.push(lastNoDrawTime + "," + lastDrawValue);
        accumulatedPath.push(lastNoDrawTime + "," + initialValue2state);
        noDrawFlag = false;
      }

      if (valueIs4State(initialValue)) {
        xzPath = `${initialTimeOrStart},0 ${time},0 ${time},1 ${initialTimeOrStart},1`;
        if (initialTimeOrStart >= 0) {
          xzPath += ` ${initialTimeOrStart},0`;
        }
        xzPolylines.push(`<polyline points="${xzPath}" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      }

      value2state = value;
      if (valueIs4State(value)) {value2state =  0;}

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
  if (valueIs4State(initialValue)) {initialValue2state = 0;}

  if (postState[0] - initialTime < minDrawWidth) {

      noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + columnTime + ",1 " + columnTime + ",0 ");
      accumulatedPath.push(lastDrawTime + ",0");
      accumulatedPath.push(columnTime + ",0");
      //accumulatedPath.push(columnTime + "," + lastDrawValue);
  } else {

    if (noDrawFlag) {

      noDrawPath.push(lastDrawTime + ",0 " + lastDrawTime + ",1 " + lastNoDrawTime + ",1 " + lastNoDrawTime + ",0 ");
      accumulatedPath.push(lastDrawTime + "," + 0);
      accumulatedPath.push(lastNoDrawTime + "," + 0);
      //accumulatedPath.push(lastNoDrawTime + "," + lastDrawValue);
      accumulatedPath.push(lastNoDrawTime + "," + initialValue2state);
    }

    if (valueIs4State(initialValue))  {

      if (initialTimeOrStart >= 0) {
        xzPolylines.push(`<polyline points="${columnTime},1 ${initialTimeOrStart},1 ${initialTimeOrStart},0 ${columnTime},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      } else {
        xzPolylines.push(`<polyline points="${initialTimeOrStart},0 ${columnTime},0" stroke="var(--vscode-debugTokenExpression-error)"/>`);
        xzPolylines.push(`<polyline points="${initialTimeOrStart},1 ${columnTime},1" stroke="var(--vscode-debugTokenExpression-error)"/>`);
      }
    }
  }

  accumulatedPath.push(columnTime + "," + initialValue2state);

  let polylinePath = accumulatedPath.join(" ");
  let polyline     = `<polyline points="` + polylinePath + `" ${polylineAttributes}/>`;
  let noDraw       = `<polygon points="${noDrawPath}" stroke="none" fill="var(--vscode-debugTokenExpression-number)"/>`;
  let shadedArea   = `<polygon points="0,0 ${polylinePath} ${columnTime},0" stroke="none" fill="var(--vscode-debugTokenExpression-number)" fill-opacity="0.1"/>`;
  return polyline + shadedArea + noDraw + xzPolylines.join('');
};


binaryElementFromTransitionData = function (transitionData, initialState, postState) {
  const svgHeight  = 20;
  const waveHeight = 16;
  const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
  const polylineAttributes = `stroke="var(--vscode-debugTokenExpression-number)"`;
  const gAttributes = `fill="none" transform="translate(0.5 ${waveOffset}.5) scale(${zoomRatio} -${waveHeight})"`;
  let result = '';
  result += `<svg height="${svgHeight}" width="${columnWidth}" viewbox="0 0 ${columnWidth} ${svgHeight}" class="binary-waveform-svg">`;
  result += `<g ${gAttributes}>`;
  result += polylinePathFromTransitionData(transitionData, initialState, postState, polylineAttributes);
  result += `</g></svg>`;
  return result;
};

createWaveformSVG = function (transitionData, initialState, postState, width, chunkIndex, netlistId, textWidth) {
  let   className     = 'waveform-chunk';
  const vscodeContext = netlistData[netlistId].vscodeContext;
  if (netlistId === selectedSignal) {className += ' is-selected';}
  if (width === 1) {
    return `<div class="${className}" id="idx${chunkIndex}-${chunksInColumn}--${netlistId}" ${vscodeContext}>
    ${binaryElementFromTransitionData(transitionData, initialState, postState)}
    </div>`;
  } else {
    const numberFormat  = netlistData[netlistId].numberFormat;
    return `<div class="${className}" id="idx${chunkIndex}-${chunksInColumn}--${netlistId}" ${vscodeContext}>
              ${busElementsfromTransitionData(transitionData, initialState, postState, width, textWidth, numberFormat)}
            </div>`;
  }
};

renderWaveformChunk = function (netlistId, chunkStartIndex) {
  var result         = {};
  const signalId     = netlistData[netlistId].signalId;
  const data         = waveformData[signalId];
  const timeStart    = chunkStartIndex * chunkTime;
  const timeEnd      = timeStart + columnTime;
  const width        = data.signalWidth;
  const startIndex   = data.chunkStart[chunkStartIndex];
  const endIndex     = data.chunkStart[chunkStartIndex + chunksInColumn];
  const initialState = data.transitionData[startIndex - 1];
  const textWidth    = data.textWidth;

  let   postState;
  if (chunkStartIndex >= data.chunkStart.length - chunksInColumn) {
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

  result.html = createWaveformSVG(chunkTransitionData, relativeInitialState, relativePostState, width, chunkStartIndex, netlistId, textWidth);
  return result;
};

// This function creates ruler elements for a chunk
createRulerChunk = function (chunkStartIndex) {
  const timeMarkerInterval = rulerNumberSpacing / zoomRatio;
  const chunkStartTime     = chunkStartIndex * chunkTime;
  const chunkStartPixel    = chunkStartIndex * chunkWidth;
  const numberStartpixel   = -1 * (chunkStartPixel % rulerNumberSpacing);
  const tickStartpixel     = rulerTickSpacing - (chunkStartPixel % rulerTickSpacing) - rulerNumberSpacing;
  var   numValue           = chunkStartTime + (numberStartpixel / zoomRatio);
  var   textElements       = [];

  for (var i = numberStartpixel; i <= columnWidth + 64; i+= rulerNumberSpacing ) {
    textElements.push(`<text x="${i}" y="20">${numValue * timeScale}</text>`);
    numValue += timeMarkerInterval;
  }

  return `
    <div class="ruler-chunk">
      <svg height="40" width="${columnWidth}" class="ruler-svg">
      <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${columnWidth}" y2="32.5"/>
        ${textElements.join('')}</svg></div>`;
};

// This function creates ruler elements for a chunk
createRulerElement = function (chunkStartIndex) {
  const timeMarkerInterval = rulerNumberSpacing / zoomRatio;
  const chunkStartTime     = chunkStartIndex * chunkTime;
  const chunkStartPixel    = chunkStartIndex * chunkWidth;
  const numberStartpixel   = -1 * (chunkStartPixel % rulerNumberSpacing);
  const tickStartpixel     = rulerTickSpacing - (chunkStartPixel % rulerTickSpacing) - rulerNumberSpacing;
  const totalWidth         = columnWidth * columnsInCluster;
  var   numValue           = chunkStartTime + (numberStartpixel / zoomRatio);
  var   textElements       = [];

  for (var i = numberStartpixel; i <= totalWidth + 64; i+= rulerNumberSpacing ) {
    textElements.push(`<text x="${i}" y="20">${numValue * timeScale}</text>`);
    numValue += timeMarkerInterval;
  }

  return `
    <div class="ruler-chunk">
      <svg height="40" width="${totalWidth}" class="ruler-svg">
      <line class="ruler-tick" x1="${tickStartpixel}" y1="32.5" x2="${totalWidth}" y2="32.5"/>
        ${textElements.join('')}</svg></div>`;
};

createTimeMarker = function (time, markerType) {
  const x  = (time % columnTime) * zoomRatio;
  const id = markerType === 0 ? 'main-marker' : 'alt-marker';
  return `
    <svg id="${id}" class="time-marker" style="left:${x}px">
      <line x1="0" y1="0" x2="0" y2="100%"/>
    </svg>`;
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
    const is4State     = valueIs4State(v);
    const color        = is4State ? 'style="color:var(--vscode-debugTokenExpression-error)"' : '';
    const displayValue = parseValue(v, width, is4State, numberFormat);
    return `<p ${color}>${displayValue}</p>`;
  }).join(joinString);

  return `<div class="waveform-label ${selectorClass}" id="value-${netlistId}" ${vscodeContext}>${pElement}</div>`;
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
    for (var i = dataCache.startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
      dataCache.columns[i].waveformChunk[netlistId] = renderWaveformChunk(netlistId, i);
      parseHtmlInChunk(i);
    }
    dataCache.valueAtMarker[signalId] = getValueAtTime(signalId, markerTime);
  });
};

// Event handler helper functions
updateChunkInCache = function (chunkIndex) {

  let result = {
    rulerChunk:    createRulerChunk(chunkIndex),
    waveformChunk: {},
    marker:        [],
    altMarker:     [],
  };

  displayedSignals.forEach((netlistId) => {
    result.waveformChunk[netlistId] = renderWaveformChunk(netlistId, chunkIndex);
  });

  return result;
};

// Event handler helper functions
handleZoom = function (amount, zoomOrigin, screenPosition) {
  // -1 zooms in, +1 zooms out
  // zoomRatio is in pixels per time unit
  if (updatePending) {return;}
  if (amount === 0) {return;}

  let newZoomRatio  = zoomRatio * Math.pow(2, (-1 * amount));
  touchpadScrollCount = 0;
  
  if (newZoomRatio > maxZoomRatio) {
    newZoomRatio = maxZoomRatio;

    if (newZoomRatio === zoomRatio) {
      console.log('zoom ratio is too high: ' + newZoomRatio + '');
      return;
    }
  }

  //console.log('zooming to ' + newZoomRatio + ' from ' + zoomRatio + '');

  updatePending    = true;
  zoomRatio        = newZoomRatio;
  chunkWidth       = chunkTime * zoomRatio;
  maxScrollLeft    = Math.round(Math.max((chunkCount * chunkWidth) - viewerWidth, 0));
  pseudoScrollLeft = Math.max(Math.min((zoomOrigin * zoomRatio) - screenPosition, maxScrollLeft), 0);
  for (i = dataCache.startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
    dataCache.columns[i] = undefined;
  }
  getChunksWidth();
  const startIndex  = Math.ceil(dataCache.startIndex / chunksInColumn) * chunksInColumn;
  const endIndex    = Math.floor(dataCache.endIndex / chunksInColumn) * chunksInColumn;
  dataCache.startIndex = startIndex;
  dataCache.endIndex   = endIndex;

  for (i = startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
    dataCache.columns[i] = (updateChunkInCache(i));
  }

  updateContentArea(leftOffset, getBlockNum());
  updateScrollbarResize();
};

// Experimental asynchronous rendering path
renderWaveformsAsync = async function (node, chunkIndex) {
  updatePending       = true;
  let chunkData       = {};
  let chunkElements   = {};
  let orderedElements = [];

  try {

    // Render each waveform chunk asynchronously
    for (let netlistId of displayedSignals) {
      //let signalId = netlistData[netlistId].signalId;
      // Check the abort flag at the start of each iteration
      if (dataCache.columns[chunkIndex].abortFlag) {continue;}

      // Assume renderWaveformChunk is a heavy operation; simulate breaking it up
      await new Promise(resolve => requestAnimationFrame(() => {
        chunkData[netlistId]     = renderWaveformChunk(netlistId, chunkIndex);
        chunkElements[netlistId] = domParser.parseFromString(chunkData[netlistId].html, 'text/html').body.firstChild;
        //if (!dataCache.columns[chunkIndex]) {console.log(chunkIndex);}
        resolve();
      }));
    }

    if (!dataCache.columns[chunkIndex].abortFlag) {
      dataCache.columns[chunkIndex].waveformChunk = chunkData;
    }

    // Update the DOM in the next animation frame
    await new Promise(resolve => requestAnimationFrame(() => {
      displayedSignals.forEach((netlistId) => {orderedElements.push(chunkElements[netlistId]);});
      let domRef = document.getElementById('waveform-column-' + chunkIndex + '-' + chunksInColumn);
      if (domRef && !dataCache.columns[chunkIndex].abortFlag) { // Always check if the element still exists
        domRef.replaceChildren(...orderedElements);
        node.classList.remove('rendering-chunk');
      }
      resolve();
    }));

    if (dataCache.columns[chunkIndex]) {
      if (dataCache.columns[chunkIndex].abortFlag) {
        //console.log('aborting render for chunk ' + chunkIndex);
        //console.log('late deleting chunk  ' + chunkIndex);
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

handleUpdatePending = function () {
  if (dataCache.updatesPending === 0) {
    //console.log('all updates are done, running garbage collection');
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
      //console.log('aborting garbage collection');
      return;
    }
  }
  for (var i = dataCache.endIndex; i < dataCache.columns.length; i++) {
    if (!updatePending) {
      dataCache.columns[i] = undefined;
    } else {
      //console.log('aborting garbage collection');
      return;
    }
  }
  if (!updatePending) {
    sendWebviewContext();
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
    //console.log('chunk ' + chunkIndex + ' is already in cache');
    return;
  }

  let result = {
    rulerChunk:    createRulerChunk(chunkIndex),
    marker:        [],
    altMarker:     [],
    abortFlag:     false,
    isSafeToRemove: false,
    element:       undefined,
  };

  dataCache.columns[chunkIndex] = result;
};

parseHtmlInChunk = function (chunkIndex) {
  let overlays  = '';
  let waveforms = "";
  let shallowChunkClass = "";
  let idTag = `${chunkIndex}-${chunksInColumn}`;
  if (dataCache.columns[chunkIndex].waveformChunk) {
    waveforms = displayedSignals.map((signal) => {return dataCache.columns[chunkIndex].waveformChunk[signal].html;}).join('');
  } else {
    shallowChunkClass = " shallow-chunk";
  }

  if (Math.floor(chunkIndex / chunksInColumn) === Math.floor(markerChunkIndex / chunksInColumn))    {overlays += createTimeMarker(markerTime, 0);}
  if (Math.floor(chunkIndex / chunksInColumn) === Math.floor(altMarkerChunkIndex / chunksInColumn)) {overlays += createTimeMarker(altMarkerTime, 1);}

  result = `<div class="column-chunk${shallowChunkClass}" id="column-${idTag}" style="width:${columnWidth}px">
  ${dataCache.columns[chunkIndex].rulerChunk}
  <div class="waveform-column" id="waveform-column-${idTag}" style="font-family:monospaced">
  ${waveforms}
  </div>
  ${overlays}
  </div>`;

  dataCache.columns[chunkIndex].element        = domParser.parseFromString(result, 'text/html').body.firstChild;
  dataCache.columns[chunkIndex].isSafeToRemove = true;
};

shallowFetchColumns = function (startIndex, endIndex) {

  //console.log('shallow fetching chunks from ' + startIndex + ' to ' + endIndex + '');

  if (startIndex < dataCache.startIndex) {
    const upperBound = Math.min(dataCache.startIndex, endIndex);
    //console.log('building shallow chunks from ' + startIndex + ' to ' + upperBound + '');
    for (var i = upperBound - chunksInColumn; i >= startIndex; i-=chunksInColumn) {
      updateChunkInCacheShallow(i);
    }
  }
  if (endIndex > dataCache.endIndex) {
    const lowerBound = Math.max(dataCache.endIndex, startIndex);
    //console.log('building shallow chunks from ' + lowerBound + ' to ' + endIndex + '');
    for (var i = lowerBound; i < endIndex; i+=chunksInColumn) {
      updateChunkInCacheShallow(i);
    }
  }

  dataCache.startIndex = Math.min(startIndex, dataCache.startIndex);
  dataCache.endIndex   = Math.max(endIndex,   dataCache.endIndex);

  //console.log('aborting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
  //console.log('chunk cache start index: ' + dataCache.startIndex + ' end index: ' + dataCache.endIndex + '');
  //uncacheChunks(startIndex, endIndex);

  let returnData = [];

  for (var chunkIndex = startIndex; chunkIndex < endIndex; chunkIndex+=chunksInColumn) {
    //if (!dataCache.columns[chunkIndex]) {console.log('chunk ' + chunkIndex + ' is undefined');}
    if (!dataCache.columns[chunkIndex].element) {
      parseHtmlInChunk(chunkIndex);
    }
    returnData.push(dataCache.columns[chunkIndex].element);
  }

  return returnData;
};

// ----------------------------------------------------------------------------
// Modified Clusterize code
// ----------------------------------------------------------------------------
handleScrollEvent = function(newScrollLeft) {
  const clampedScrollLeft = Math.max(Math.min(newScrollLeft, maxScrollLeft), 0);
  contentLeft            += pseudoScrollLeft - clampedScrollLeft;
  contentArea.style.left  = contentLeft + 'px';
  pseudoScrollLeft        = clampedScrollLeft;
  updateScrollBarPosition();
  if (scrollEventPending) {return;}

  scrollEventPending = true;
  const thisCluster  = getBlockNum();
  if (currentCluster[0] !== thisCluster[0] || currentCluster[1] !== thisCluster[1]) {
    updateContentArea(leftOffset, thisCluster);
    currentCluster = thisCluster;
  }
  scrollEventPending = false;
};

getChunksWidth = function() {
  const chunksInCluster  = Math.max(Math.ceil((viewerWidth + 1000) / chunkWidth), 2);
  chunksInColumn         = 4 ** (Math.max(0,(Math.floor(Math.log2(chunksInCluster) / 2) - 1)));
  columnWidth            = chunkWidth * chunksInColumn;
  columnsInCluster       = Math.max(Math.ceil((viewerWidth / columnWidth) * 2), 2);
  columnTime             = chunkTime * chunksInColumn;

  //console.log('chunks in cluster: ' + chunksInCluster + '; chunks in column: ' + chunksInColumn + '; column width: ' + columnWidth + '; blocks in cluster: ' + columnsInCluster + '');
};

getBlockNum = function () {
  const blockNum     = (pseudoScrollLeft + halfViewerWidth) / columnWidth;
  const minColumnNum = Math.max(Math.round(blockNum - (columnsInCluster / 2)), 0) * chunksInColumn;
  const maxColumnNum = Math.min(Math.round(blockNum + (columnsInCluster / 2)) * chunksInColumn, chunkCount);

  //console.log('min column number: ' + minColumnNum + '; max column number: ' + maxColumnNum + '');
  return [minColumnNum, maxColumnNum];
};

updateContentArea = function(oldLeftOffset, cluster) {
  const leftHidden = chunkWidth * cluster[0];
  if (updatePending || leftHidden !== oldLeftOffset) {
    const newColumns       = shallowFetchColumns(cluster[0], cluster[1]);
    contentLeft            = leftHidden - pseudoScrollLeft;
    contentArea.style.left = contentLeft + 'px';
    contentArea.replaceChildren(...newColumns);
    leftOffset             = leftHidden;
    handleClusterChanged(cluster[0], cluster[1]);
  }
  handleUpdatePending();
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
  const chunkWindow  = [Math.floor(timeWindow[0] / chunkTime), Math.ceil(timeWindow[1] / chunkTime)];
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
              const is4State = valueIs4State(signal.initialState);
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
              const is4State = valueIs4State(transition[1]);
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

  console.log(waveDromData);

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

handleClusterChanged = function (startIndex, endIndex) {
  //console.log('deleting chunk cache outside of index ' + startIndex + ' to ' + endIndex + '');
  //console.log('chunk cache start index: ' + dataCache.startIndex + ' end index: ' + dataCache.endIndex + '');
  uncacheChunks(startIndex, endIndex);
  dataCache.startIndex     = startIndex;
  dataCache.endIndex       = endIndex;
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
    zoomRatio: zoomRatio,
    scrollLeft: pseudoScrollLeft,
  });
};

handleMarkerSet = function (time, markerType) {

  let   oldMarkerTime = markerType === 0 ? markerTime         : altMarkerTime;
  let   chunkIndex    = markerType === 0 ? markerChunkIndex   : altMarkerChunkIndex;
  const id            = markerType === 0 ? 'main-marker'      : 'alt-marker';
  let viewerMoved     = false;

  // dispose of old marker
  if (oldMarkerTime !== null) {
    if (chunkIndex >= dataCache.startIndex && chunkIndex < dataCache.endIndex + chunksInColumn) {
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
  chunkIndex   = Math.floor(time / chunkTime);
  
  // create new marker
  if (chunkIndex >= dataCache.startIndex && chunkIndex < dataCache.endIndex + chunksInColumn) {
    const clusterIndex = Math.floor((chunkIndex - dataCache.startIndex) / chunksInColumn);
    let chunkElement   = contentArea.getElementsByClassName('column-chunk')[clusterIndex];
    let marker         = domParser.parseFromString(createTimeMarker(time, markerType), 'text/html').body.firstChild;

    chunkElement.appendChild(marker);

    //console.log('adding marker at time ' + time + ' from chunk ' + chunkIndex + '');
  } else {
    //console.log('chunk index ' + chunkIndex + ' is not in cache');
  }

  if (markerType === 0) {
    markerTime            = time;
    markerChunkIndex      = chunkIndex;

    viewerMoved = moveViewToTime(time);

    // Get values for all displayed signals at the marker time
    displayedSignals.forEach((netlistId) => {
      signalId = netlistData[netlistId].signalId;
      dataCache.valueAtMarker[signalId] = getValueAtTime(signalId, time);
    });

    renderLabelsPanels();
  } else {
    altMarkerTime         = time;
    altMarkerChunkIndex   = chunkIndex;
  }

  //setTimeOnStatusBar();
  sendWebviewContext();
};

isInView = function(time) {
  const pixel      = time * zoomRatio;
  const scrollLeft = pseudoScrollLeft;

  if (pixel < scrollLeft || pixel > scrollLeft + viewerWidth) {return false;}
  else {return true;}
};

moveViewToTime = function(time) {
  const moveViewer = !(isInView(time));
  if (moveViewer) {
    handleScrollEvent((time * zoomRatio) - halfViewerWidth);
  }
  return moveViewer;
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
  touchpadScrolling   = false;
  touchpadScrollCount = 0;

  // Zoom level variables
  timeScale           = 1;
  chunkCount          = null;
  chunkTime           = 512;
  chunkWidth          = 512;
  zoomRatio           = 1;
  maxZoomRatio        = 64;
  chunksInColumn      = 1;
  columnTime          = chunkTime * chunksInColumn;
  timeStop            = 0;

  // Clusterize variables
  updatePending       = false;
  columnsInCluster    = 4;
  scrollEventPending  = false;
  currentCluster      = [0, 0];
  columnWidth         = chunksInColumn  * chunkWidth;

  // Marker and signal selection variables
  selectedSignal      = null;
  selectedSignalIndex = null;
  markerTime          = null;
  markerChunkIndex    = undefined;
  altMarkerTime       = null;
  altMarkerChunkIndex = undefined;

  // Search handler variables
  searchState         = 0;
  searchInFocus       = false;
  parsedSearchValue   = null;

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

  // Data variables
  contentData         = [];
  displayedSignals    = [];
  waveformData        = {};
  netlistData         = {};
  dataCache           = {
    startIndex:     0,
    endIndex:       0,
    columns:        [],
    valueAtMarker:  {},
    updatesPending: 0,
    markerElement:  '',
    altMarkerElement: '',
  };
  waveDromClock = {
    netlistId: null,
    edge: '1',
  };
  domParser           = new DOMParser();

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

  renderLabelsPanels = function () {
    let labelsList  = [];
    let transitions = [];
    displayedSignals.forEach((netlistId, index) => {
      const signalId     = netlistData[netlistId].signalId;
      const numberFormat = netlistData[netlistId].numberFormat;
      let data           = waveformData[signalId];
      data.textWidth     = getValueTextWidth(data.signalWidth, numberFormat);
      const isSelected   = (index === selectedSignalIndex);
      labelsList.push(createLabel(netlistId, isSelected));
      transitions.push(createValueDisplayElement(netlistId, dataCache.valueAtMarker[signalId], isSelected));
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
  
    for (var i = dataCache.startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
      element = document.getElementById('idx' + i + '-' + chunksInColumn + '--' + selectedSignal);
      if (element) {
        element.classList.remove('is-selected');
        dataCache.columns[i].waveformChunk[selectedSignal].html = element.outerHTML;
      }
  
      element = document.getElementById('idx' + i + '-' + chunksInColumn + '--' + netlistId);
      if (element) {
        element.classList.add('is-selected');
        dataCache.columns[i].waveformChunk[netlistId].html = element.outerHTML;
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

    updatePending = true;
    arrayMove(displayedSignals, oldIndex, newIndex);
    arrayMove(labelsList,       oldIndex, newIndex);
    handleSignalSelect(displayedSignals[newIndex]);
    renderLabelsPanels();
    for (var i = dataCache.startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
      const waveformColumn = document.getElementById('waveform-column-' + i + '-' + chunksInColumn);
      const children       = Array.from(waveformColumn.children);
      arrayMove(children, oldIndex, newIndex);
      waveformColumn.replaceChildren(...children);
    }
    updateContentArea(leftOffset, getBlockNum());
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
    if (updatePending) {return;}
    updatePending              = true;
    labelsScroll.scrollTop     = scrollLevel;
    transitionScroll.scrollTop = scrollLevel;
    scrollArea.scrollTop       = scrollLevel;
    updatePending              = false;
  }

  labelsScroll.addEventListener(    'scroll', (e) => {syncVerticalScroll(labelsScroll.scrollTop);});
  transitionScroll.addEventListener('scroll', (e) => {syncVerticalScroll(transitionScroll.scrollTop);});
  scrollArea.addEventListener(      'scroll', (e) => {
    syncVerticalScroll(scrollArea.scrollTop);
    //handleScrollEvent();
  });

  function resetTouchpadScrollCount() {
    touchpadScrollCount = 0;
  }

  // scroll handler to handle zooming and scrolling
  scrollArea.addEventListener('wheel', (event) => { 

    event.preventDefault();

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
      const pixelLeft   = Math.round(event.pageX - bounds.left);
      const time        = Math.round((pixelLeft - contentLeft) / zoomRatio) + (chunkTime * dataCache.startIndex);

      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (!touchpadScrolling && (deltaY > 0)) {handleZoom( 1, time, pixelLeft);}
      else if (!touchpadScrolling && (deltaY < 0)) {handleZoom(-1, time, pixelLeft);}

      // Handle zooming with touchpad since we apply scroll attenuation
      else if (touchpadScrolling) {
        touchpadScrollCount += deltaY;
        clearTimeout(resetTouchpadScrollCount);
        setTimeout(resetTouchpadScrollCount, 1000);
        handleZoom(Math.round(touchpadScrollCount / 25), time, pixelLeft);
      }

    } else {
      if (touchpadScrolling) {
        handleScrollEvent(pseudoScrollLeft + event.deltaX);
        scrollArea.scrollTop       += event.deltaY;
        labelsScroll.scrollTop      = scrollArea.scrollTop;
        transitionScroll.scrollTop  = scrollArea.scrollTop;
      } else {
        handleScrollEvent(pseudoScrollLeft + deltaY);
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
      console.log(updatePending);
      console.log(dataCache);
    }

    // left and right arrow keys move the marker
    // ctrl + left and right arrow keys move the marker to the next transition
    if ((event.key === 'ArrowRight') && (markerTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(1);}
      else                {handleMarkerSet(markerTime + 1, 0);}
    } else if ((event.key === 'ArrowLeft') && (markerTime !== null)) {
      if (event.ctrlKey)  {goToNextTransition(-1);}
      else                {handleMarkerSet(markerTime - 1, 0);}

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

    // "N" and Shoft + "N" go to the next transition
    else if (event.key === 'n') {goToNextTransition(1);}
    else if (event.key === 'N') {goToNextTransition(-1);}

  });

  function getTimeFromClick(event) {
    const bounds      = contentArea.getBoundingClientRect();
    const pixelLeft   = Math.round(event.pageX - bounds.left);
    return Math.round(pixelLeft / zoomRatio) + (chunkTime * dataCache.startIndex);
  }

  highlightElement    = null;
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

  function highlightZoom() {
    const timeStart = getTimeFromClick(highlightStartEvent);
    const timeEnd   = getTimeFromClick(highlightEndEvent);
    const time      = Math.round((timeStart + timeEnd) / 2);
    const width     = Math.abs(highlightStartEvent.pageX - highlightEndEvent.pageX);
    const amount    = Math.ceil(Math.log2(width / viewerWidth));

    if (highlightElement) {
      highlightElement.remove();
      highlightElement = null;
    }

    handleZoom(amount, time, halfViewerWidth);
  }

  highlightDebounce    = null;
  highlightListenerSet = false;
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
    const time     = getTimeFromClick(event);
    let snapToTime = time;
    let signalId   = null;

    // Get the signal id of the click
    let netlistId     = null;
    const waveChunkId = event.target.closest('.waveform-chunk');
    if (waveChunkId) {netlistId = parseInt(waveChunkId.id.split('--').slice(1).join('--'));}
    if (netlistId)    {
      if (button === 0) {
        handleSignalSelect(netlistId);
      }

      signalId = netlistData[netlistId].signalId;

      // Snap to the nearest transition if the click is close enough
      const nearestTransition = getNearestTransition(signalId, time);
      const nearestTime       = nearestTransition[0];
      const pixelDistance     = Math.abs(nearestTime - time) * zoomRatio;

      if (pixelDistance < snapToDistance) {snapToTime = nearestTime;}
    }

    handleMarkerSet(snapToTime, button);
  }

  updateScrollbarResize = function () {
    scrollbarWidth        = Math.max(Math.round((viewerWidth ** 2) / (chunkCount * chunkWidth)), 17);
    maxScrollbarPosition  = Math.max(viewerWidth - scrollbarWidth, 0);
    updateScrollBarPosition();
    scrollbar.style.width = scrollbarWidth + 'px';
  };

  updateScrollBarPosition = function () {
    scrollbarPosition       = Math.round((pseudoScrollLeft / maxScrollLeft) * maxScrollbarPosition);
    scrollbar.style.display = maxScrollLeft === 0 ? 'none' : 'block';
    scrollbar.style.left    = scrollbarPosition + 'px';
  };

  updateViewportWidth = function() {
    viewerWidth     = scrollArea.getBoundingClientRect().width;
    halfViewerWidth = viewerWidth / 2;
    maxScrollLeft   = Math.round(Math.max((chunkCount * chunkWidth) - viewerWidth, 0));
    updateScrollbarResize();
  };

  function handleScrollbarMove(e) {
    if (!scrollbarMoved) {
      scrollbarMoved = e.clientX !== startX;
      if (!scrollbarMoved) {return;}
    }
    const newPosition   = Math.min(Math.max(0, e.clientX - startX + scrollbarPosition), maxScrollbarPosition);
    startX              = e.clientX;
    const newScrollLeft = Math.round((newPosition / maxScrollbarPosition) * maxScrollLeft);
    handleScrollEvent(newScrollLeft);
    
  }

  function handleScrollbarDrag(event) {
    event.preventDefault();
    scrollbarMoved = false;
    startX = event.clientX;
    scrollbar.classList.add('is-dragging');

    document.addEventListener('mousemove', handleScrollbarMove, false);
    mouseupEventType = 'scroll';
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

  resizeDebounce = 0;
  function handleResizeViewer() {
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(updateViewportWidth, 100);
  }

  function handleMouseUp(event) {
    if (mouseupEventType === 'rearrange') {
      dragEnd(event);
    } else if (mouseupEventType === 'resize') {
      resizeElement.classList.remove('is-resizing');
      document.removeEventListener("mousemove", resize, false);
      handleResizeViewer();
    } else if (mouseupEventType === 'scroll') {
      scrollbar.classList.remove('is-dragging');
      document.removeEventListener('mousemove', handleScrollbarMove, false);
      scrollbarMoved = false;
    } else if (mouseupEventType === 'highlightZoom') {
      scrollArea.removeEventListener('mousemove', drawHighlightZoom, false);
      highlightListenerSet = false;
      highlightZoom();
    } else if (mouseupEventType === 'markerSet') {
      clearTimeout(highlightDebounce);
      handleScrollAreaClick(highlightStartEvent, 0);
      scrollArea.removeEventListener('mousemove', drawHighlightZoom, false);
      highlightListenerSet = false;
      if (highlightElement) {
        highlightElement.remove();
        highlightElement = null;
      }
    }
    mouseupEventType = null;
  }

  mouseupEventType = null;

  // click handler to handle clicking inside the waveform viewer
  // gets the absolute x position of the click relative to the scrollable content
  contentArea.addEventListener('mousedown', (e) => {handleScrollAreaMouseDown(e);});
  scrollbar.addEventListener('mousedown',   (e) => {handleScrollbarDrag(e);});

  // resize handler to handle column resizing
  resize1.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize1, 1);});
  resize2.addEventListener("mousedown",   (e) => {handleResizeMousedown(e, resize2, 2);});
  window.addEventListener('resize',       ()  => {handleResizeViewer();}, false);

  // Control bar button event handlers
  zoomInButton.addEventListener( 'click', (e) => {handleZoom(-1, (pseudoScrollLeft + halfViewerWidth) / zoomRatio, halfViewerWidth);});
  zoomOutButton.addEventListener('click', (e) => {handleZoom( 1, (pseudoScrollLeft + halfViewerWidth) / zoomRatio, halfViewerWidth);});
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
          const data     = dataCache.columns[chunkIndex];
          if (!data || data.abortFlag || !data.isSafeToRemove) {
            //console.log('chunk ' + chunkIndex + ' is not safe to touch');
            //console.log(data);
            return;
          }
          dataCache.columns[chunkIndex].isSafeToRemove = false;
          dataCache.updatesPending++;
          renderWaveformsAsync(node, chunkIndex);
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
        vscode.postMessage({ command: 'creating ruler from the js file' });
        //console.log("creating ruler");
        waveformDataSet   = message.waveformDataSet;
        document.title    = waveformDataSet.filename;
        chunkTime         = waveformDataSet.chunkTime;
        zoomRatio         = waveformDataSet.defaultZoom;
        timeScale         = waveformDataSet.timeScale;
        maxZoomRatio      = zoomRatio * 64;
        chunkWidth        = chunkTime * zoomRatio;
        chunkCount        = Math.ceil(waveformDataSet.timeEnd / waveformDataSet.chunkTime);
        timeStop          = waveformDataSet.timeEnd;
        dataCache.columns = new Array(chunkCount);

        updatePending = true;
        updateViewportWidth();
        getChunksWidth();
        updateContentArea(leftOffset, getBlockNum());

        break;
      }
      case 'render-var': {
        // Handle rendering a signal, e.g., render the signal based on message content

        //console.log(message);

        let signalId       = message.signalId;
        let netlistId      = message.netlistId;
        let numberFormat   = message.numberFormat;
        let signalWidth    = message.signalWidth;
        displayedSignals.push(netlistId);

        netlistData[netlistId] = {
          signalId:     signalId,
          signalWidth:  message.signalWidth,
          signalName:   message.signalName,
          modulePath:   message.modulePath,
          numberFormat: message.numberFormat,
        };
        netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);


        let transitionData = message.transitionData;
        let nullValue = "X".repeat(signalWidth);

        if (transitionData[0][0] !== 0) {
          transitionData.unshift([0, nullValue]);
        }
        if (transitionData[transitionData.length - 1][0] !== timeStop) {
          transitionData.push([timeStop, nullValue]);
        }
        waveformData[signalId] = {
          transitionData: transitionData,
          signalWidth:    message.signalWidth,
          textWidth:      getValueTextWidth(message.signalWidth, numberFormat),
        };

        // Create ChunkStart array
        waveformData[signalId].chunkStart = new Array(chunkCount).fill(transitionData.length);
        let chunkIndex = 0;
        for (let i = 0; i < transitionData.length; i++) {
          while (transitionData[i][0] >= chunkTime * chunkIndex) {
            waveformData[signalId].chunkStart[chunkIndex] = i;
            chunkIndex++;
          }
        }
        waveformData[signalId].chunkStart[0] = 1;

        updateWaveformInCache([message.netlistId]);
        renderLabelsPanels();

        updatePending  = true;
        updateContentArea(leftOffset, getBlockNum());
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
          updatePending    = true;
          renderLabelsPanels();
          for (var i = dataCache.startIndex; i < dataCache.endIndex; i+=chunksInColumn) {
            const waveformColumn = document.getElementById('waveform-column-' + i + '-' + chunksInColumn);
            const children       = Array.from(waveformColumn.children);
            children.splice(index, 1);
            waveformColumn.replaceChildren(...children);
          }
          updateContentArea(leftOffset, getBlockNum());
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

        netlistData[netlistId].numberFormat  = numberFormat;
        netlistData[netlistId].vscodeContext = setSignalContextAttribute(netlistId);

        updatePending = true;
        updateWaveformInCache([message.netlistId]);
        renderLabelsPanels();
        updateContentArea(leftOffset, getBlockNum());

        if (netlistId === selectedSignal) {
          if (numberFormat === 2)  {valueIconRef.setAttribute('href', '#search-binary');}
          if (numberFormat === 10) {valueIconRef.setAttribute('href', '#search-decimal');}
          if (numberFormat === 16) {valueIconRef.setAttribute('href', '#search-hex');}
        }

        break;
      }
      case 'setMarker': {
        //console.log('setting marker');
        // Handle setting the marker, e.g., update the marker position
        handleMarkerSet(message.time, 0);
        break;
      }
      case 'setSelectedSignal': {
        // Handle setting the selected signal, e.g., update the selected signal
        handleSignalSelect(message.netlistId);
        break;
      }
      case 'getSelectionContext': {

        sendWebviewContext('response');
        //vscode.postMessage({type: 'context', context: displaySignalContext});
        break;
      }
      case 'getContext': {
        sendWebviewContext('response');
        break;
      }
      case 'copyWaveDrom': {
        copyWaveDrom();
        break;
      }
      case 'setWaveDromClock': {
        waveDromClock = {
          netlistId: message.netlistId,
          edge:  message.edge,
        };
        break;
      }
    }
  });

  // Send a message back to the extension to signal that the webview is ready
  vscode.postMessage({type: 'ready'});

  });
})();