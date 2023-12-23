polylinePathFromTransitionData = function (transitionData, initialState) {
  var initialValue    = initialState[1];
  var accumulatedPath = "-1," + initialValue + " ";
  transitionData.forEach(([time, value]) => {
    if (value === "x") {value = 0;}
    accumulatedPath += time + "," + initialValue + " ";
    accumulatedPath += time + "," + value + " ";
    initialValue = value;
  });
  accumulatedPath += chunkTime + "," + initialValue;
  return accumulatedPath;
};

busElement = function (time, value, backgroundPositionX, backgroundSizeX) {
  return `<div class="bus-waveform-value" style="flex:${time};background-position-x:${backgroundPositionX * zoomRatio}px;background-size:${backgroundSizeX * zoomRatio}px">
    <p>${value}</p>
  </div>`;
};

busElementsfromTransitionData = function (transitionData, initialState, postState) {
  let backgroundPositionX = Math.max(initialState[0], -1 * chunkTime);
  let result       = [];
  let initialTime  = 0;
  let initialValue = initialState[1];
  let deltaTime;
  let backgroundSizeX;

  transitionData.forEach(([time, value]) => {
    deltaTime       = time - initialTime;
    backgroundSizeX = (deltaTime - backgroundPositionX);
    result.push(busElement(deltaTime, initialValue, backgroundPositionX, backgroundSizeX));
    initialTime         = time;
    initialValue        = value;
    backgroundPositionX = 0;
  });
  deltaTime       = chunkTime - initialTime;
  backgroundSizeX = (Math.min(postState[0], 2 * chunkTime) - initialTime) - backgroundPositionX;
  result.push(busElement(deltaTime, initialValue, backgroundPositionX, backgroundSizeX));
  return result.join('');
};

createWaveformSVG = function (transitionData, initialState, postState, width, chunkIndex, signalId) {
  const svgHeight  = 20;
  const waveHeight = 16;
  const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
  if (width === 1) {
    return `<div class="waveform-chunk" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              <svg height="${svgHeight}" width="${chunkWidth}" viewbox="0 0 ${chunkWidth} ${svgHeight}" class="binary-waveform-svg">
                <polyline
                  points="${polylinePathFromTransitionData(transitionData, initialState)}"
                  fill="none" stroke="var(--vscode-debugTokenExpression-number)" vector-effect="non-scaling-stroke"
                  transform="translate(0.5 ${waveOffset}.5) scale(${zoomRatio} -${waveHeight})">
              </svg>
            </div>`;
  } else {
    return `<div class="waveform-chunk" id="idx${chunkIndex}-${chunkSample}--${signalId}">
              ${busElementsfromTransitionData(transitionData, initialState, postState)}
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
  const NumberSpacing    = rulerNumberSpacing / zoomRatio;
  const startTime        = chunkIndex * chunkTime;
  const startPixel       = chunkIndex * chunkWidth;
  const numberStartpixel = rulerNumberSpacing - (startPixel % rulerNumberSpacing);
  const tickStartpixel   = rulerTickSpacing   - (startPixel % rulerTickSpacing);
  var   numValue         = startTime + (numberStartpixel / zoomRatio);
  var   elements         = [];

  for (var i = numberStartpixel; i <= chunkWidth; i+= rulerNumberSpacing ) {
    elements.push(`<text x="${i}" y="20">${numValue}</text>`);
    numValue += NumberSpacing;
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
    <svg class="time-cursor">
      <line x1="${x}" y1="0" x2="${x}" y2="100%" stroke="yellow" stroke-dasharray="2 2"/>
    </svg>`;
};

addWaveformToCache = function (signalIdList) {
  for (var i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    signalIdList.forEach((signalId) => {
      dataCache.columns[i].waveformChunk[signalId] = renderWaveformChunk(signalId, i);
    });
  }
};

addChunkToCache = function (chunkIndex) {

  console.log('adding chunk to cache at index ' + chunkIndex + '');

  let result = {
    rulerChunk:    createRulerChunk(chunkIndex),
    waveformChunk: {}
  };
  displayedSignals.forEach((signalID) => {
    result.waveformChunk[signalID] = renderWaveformChunk(signalID, chunkIndex);
  });
  return result;
};

handleZoom = function (amount) {
  console.log('zooming not supported yet: ' + amount + '');
  // -1 zooms in, +1 zooms out
  zoomLevel += amount;

  zoomRatio  = Math.pow(2, (-1 * zoomLevel));
  chunkWidth = chunkTime * zoomRatio;

  for (i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    dataCache.columns[i] = (addChunkToCache(i));
  }

  updatePending = true;
  clusterizeContent.refresh(chunkWidth);
  //clusterizeContent.render();
};

// return chunks to be rendered
handleFetchColumns = function (startIndex, endIndex) {

  if (startIndex < dataCache.startIndex) {
    for (var i = dataCache.startIndex - 1; i >= startIndex; i-=1) {
      dataCache.columns[i] = (addChunkToCache(i));
    }
  }
  if (endIndex > dataCache.endIndex) {
    for (var i = dataCache.endIndex; i < endIndex; i+=1) {
      dataCache.columns[i] = (addChunkToCache(i));
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
    </div>`;
  });
};

handleSignalSelect = function (signalId) {

  if (signalId === null) {return;}

  let element;

  for (var i = dataCache.startIndex; i < dataCache.endIndex; i++) {
    element = document.getElementById('idx' + i + '-' + chunkSample + '--' + signalId);
    if (element) {element.classList.add('is-selected');}
  }

  selectedSignal = signalId;
};

handleCursorSet = function (time) {
  // dispose of old cursor

  // first find the chunk with the cursor
  const chunkIndexNew = Math.floor(time       / chunkTime);
  let element;
  let timeCursor;

  if (cursorTime !== null) {

    const chunkIndexOld = Math.floor(cursorTime / chunkTime);

    if (chunkIndexOld >= dataCache.startIndex && chunkIndexOld < dataCache.endIndex) {
      element    = scrollArea.getElementsByClassName('column-chunk')[chunkIndexOld - dataCache.startIndex];
      timeCursor = element.getElementsByClassName('time-cursor')[0];
      if (timeCursor) {timeCursor.remove();}
      //element.removeChild(timeCursor);
      console.log('removing cursor at time ' + cursorTime + ' from chunk ' + chunkIndexOld + '');
    } else {
      console.log('chunk index ' + chunkIndexOld + ' is not in cache');
    }
  }

  // create new cursor
  if (chunkIndexNew >= dataCache.startIndex && chunkIndexNew < dataCache.endIndex) {
    element = scrollArea.getElementsByClassName('column-chunk')[chunkIndexNew - dataCache.startIndex];
    let cursor = createTimeCursor(time);

    element.innerHTML += cursor;
    console.log('adding cursor at time ' + time + ' from chunk ' + chunkIndexNew + '');
  } else {
    console.log('chunk index ' + chunkIndexNew + ' is not in cache');
  }

  cursorTime = time;
  moveViewToTime(cursorTime);
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

goToNextTransition = function (direction) {
  if (selectedSignal === null) {return;}
  const data = waveformData[selectedSignal];
  const time = cursorTime;

  timeIndex = data.transitionData.findIndex(([t, v]) => {return t === time;});
  if (timeIndex === -1) {
    console.log('fix later');
  } else {
    timeIndex += direction;
    if (timeIndex < 0 || timeIndex >= data.transitionData.length) {return;}
    handleCursorSet(data.transitionData[timeIndex][0]);
  }
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
createLabel = function (signalId, signalName) {
  return `<div class="waveform-label is-idle" id="label-${signalId}">
            <div class='codicon codicon-grabber'></div>
            <p>${signalName}</p>
          </div>`;
};
(function () {
  const vscode = acquireVsCodeApi();

  // UI preferences
  rulerNumberSpacing = 50;
  rulerTickSpacing   = 10;

  // state variables
  selectedSignal     = null;
  cursorTime         = null;
  altCursorTime      = null;
  chunkTime          = 512;
  chunkWidth         = 512;
  zoomLevel          = 0;
  zoomRatio          = 1;
  chunkSample        = 1;
  viewerWidth        = 0;
  contentData        = [];
  displayedSignals   = [];
  waveformData       = {};
  updatePending      = false;
  dataCache          = {
    startIndex:   0,
    endIndex:     0,
    columns:      [],
  };

  // drag handler variables
  labelsList            = [];
  idleItems             = [];
  draggableItem         = null;
  draggableItemIndex    = null;
  draggableItemNewIndex = null;
  pointerStartX         = null;
  pointerStartY         = null;

  // Initialize the webview when the document is ready
  document.addEventListener('DOMContentLoaded', () => {

  // Assuming you have a reference to the webview element
  const webview      = document.getElementById('vaporview-top');
  const controlBar   = document.getElementById('control-bar');
  const viewer       = document.getElementById('waveform-viewer');
  const labels       = document.getElementById('waveform-labels');
  const labelsScroll = document.getElementById('waveform-labels-container');
  const scrollArea   = document.getElementById('scrollArea');
  const contentArea  = document.getElementById('contentArea');

  // buttons
  const zoomInButton  = document.getElementById('zoom-in-button');
  const zoomOutButton = document.getElementById('zoom-out-button');
  const resizeBar     = document.getElementById("resizeBar");

  // Scroll handlers to keep the labels and content in sync
  labelsScroll.addEventListener('scroll', (event) => {
    if (scrollArea.scrollTop !== labelsScroll.scrollTop) {
      scrollArea.scrollTop = labelsScroll.scrollTop;
    }
  });

  scrollArea.addEventListener('scroll', (event) => {
    if (labelsScroll.scrollTop !== scrollArea.scrollTop) {
      labelsScroll.scrollTop = scrollArea.scrollTop;
    }
  });

  // scroll handler to handle zooming and scrolling
  scrollArea.addEventListener('wheel', (event) => { 
    event.preventDefault();
    const deltaY = event.deltaY;
    if (event.shiftKey) {
      scrollArea.scrollTop += deltaY;
    } else if (event.ctrlKey) {
      if      (updatePending) {return;}
      // scroll up zooms in (- deltaY), scroll down zooms out (+ deltaY)
      if      (deltaY > 0) {handleZoom(1);}
      else if (deltaY < 0) {handleZoom(-1);}
    } else {
      scrollArea.scrollLeft += deltaY;
    }
  });

  // move handler to handle moving the cursor with the arrow keys
  window.addEventListener('keydown', (event) => {
    if (cursorTime === null) {return;}
    else {event.preventDefault();}
    if (event.key === 'ArrowRight') {
      if (event.ctrlKey) {goToNextTransition(1);}
      else               {handleCursorSet(cursorTime + 1);}
    } else if (event.key === 'ArrowLeft') {
      if (event.ctrlKey) {goToNextTransition(-1);}
      else               {handleCursorSet(cursorTime - 1);}
    }
  });

  // click handler to handle clicking inside the waveform viewer
  // gets the absolute x position of the click relative to the scrollable content
  scrollArea.addEventListener('click', (event) => {

    let signalId      = null;
    let chunkIndex    = null;
    const waveChunkId = event.target.closest('.waveform-chunk');
    const bounds      = scrollArea.getBoundingClientRect();
    const pixelLeft   = Math.round(scrollArea.scrollLeft + event.pageX - bounds.left);
    const time        = Math.round(pixelLeft / zoomRatio);

    if (waveChunkId) {
      signalId       = waveChunkId.id.split('--').slice(1).join('--');
    }

    handleCursorSet(time);
    handleSignalSelect(signalId);

    vscode.postMessage({
      command: 'setTime',
      time:     time,
      signalId: signalId
    });
  });

  // resize handler to handle resizing
  function resize(e) {webview.style.gridTemplateColumns = `${e.x}px 4px auto`;}

  resizeBar.addEventListener("mousedown", (event) => {
    event.preventDefault();
    resizeBar.style.borderRight = '4px solid var(--vscode-sash-hoverBorder)';
    document.addEventListener("mousemove", resize, false);
    document.addEventListener("mouseup", () => {
      document.removeEventListener("mousemove", resize, false);
      resizeBar.style.borderRight = '1px solid var(--vscode-widget-border)';
    }, false);
  });

  zoomInButton.addEventListener( 'click', (event) => {handleZoom(-1);});
  zoomOutButton.addEventListener('click', (event) => {handleZoom(1);});

  // click and drag handlers to rearrange the order of waveform signals
  labels.addEventListener('mousedown', dragStart);
  document.addEventListener('mouseup', dragEnd);

  function arrayMove(array, fromIndex, toIndex) {
    var element = array[fromIndex];
    array.splice(fromIndex, 1);
    array.splice(toIndex, 0, element);
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
    draggableItem.classList.add('is-draggable');

    document.addEventListener('mousemove', dragMove);

    draggableItemIndex = labelsList.indexOf(draggableItem);
    idleItems          = labelsList.filter((item) => {return item.classList.contains('is-idle');});
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

    arrayMove(displayedSignals, draggableItemIndex, draggableItemNewIndex);
    arrayMove(labelsList      , draggableItemIndex, draggableItemNewIndex);

    draggableItem.style   = null;
    draggableItem.classList.remove('is-draggable');
    draggableItem.classList.add('is-idle');

    updatePending    = true;
    labels.innerHTML = labelsList.map((item) => {return item.outerHTML;}).join('');
    clusterizeContent.render();

    labelsList            = [];
    idleItems             = [];
    draggableItemIndex    = null;
    draggableItemNewIndex = null;
    pointerStartX         = null;
    pointerStartY         = null;
    draggableItem         = null;
  }

  // Handle messages from the extension
  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.command) {
      case 'create-ruler': {
        vscode.postMessage({ command: 'creating ruler from the js file' });
        console.log("creating ruler");
        waveformDataSet   = message.waveformDataSet;
        document.title    = waveformDataSet.filename;
        chunkTime         = waveformDataSet.chunkSize;
        var chunkCount    = Math.ceil(waveformDataSet.timeEnd / waveformDataSet.chunkSize);
        dataCache.columns = new Array(chunkCount);

        for (var i = 0; i < chunkCount; i++) {
          contentData.push(createBaseChunk(i));
        }

        clusterizeContent  = new Clusterize({
          columnCount:     chunkCount,
          columnWidth:     chunkTime,
          columns:         contentData,
          scrollId:        'scrollArea',
          contentId:       'contentArea',
          columnsInBlock:  4,
          blocksInCluster: 4,
          callbacks: {
            clusterWillChange: function() {},
            clusterChanged:    function(startIndex, endIndex) {uncacheChunks(startIndex, endIndex);},
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

        var childElement = createLabel(message.signalId, message.waveformData.name);
        labels.innerHTML = labels.innerHTML + childElement;

        console.log(displayedSignals);
        console.log(waveformData);

        addWaveformToCache([message.signalId]);

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
          document.getElementById('label-' + message.signalId).remove();
          updatePending    = true;
          clusterizeContent.render();
        }

      break;
      }
    }
  });
  });
})();