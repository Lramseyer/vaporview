import { NetlistData } from './vaporview';
import { Viewport } from './viewport';

// green  var(--vscode-debugTokenExpression-number)
// orange var(--vscode-debugTokenExpression-string)
// blue   var(--vscode-debugView-valueChangedHighlight)
// purple var(--vscode-debugTokenExpression-name)

const characterWidth = 7.69;
export interface WaveformRenderer {
  id: string;
  draw(valueChangeChunk: any, netlistData: NetlistData, viewport: Viewport): string;
}

// This function actually creates the individual bus elements, and has can
// potentially called thousands of times during a render
function busElement(time: number, deltaTime: number, displayValue: string, spansChunk: boolean, textWidth: number, leftOverflow: number, rightOverflow: number, viewportSpecs: any, justifydirection: string) {
  let pElement           = '';
  let justifyContent     = 'justify-content: ' + justifydirection;
  let textOffset         = 0;
  const totalWidth       = deltaTime * viewportSpecs.zoomRatio; 
  let flexWidthOverflow  = 0;
  //const characterWidth   = 7.69;

  if (totalWidth > textWidth) {
    justifyContent = 'justify-content: center';
  }
  //else {
    //let slice = charCount - Math.max(0, (Math.floor(totalWidth / characterWidth) - 1));
    //displayValue = '*' + displayValue.slice(slice);
  //}

  // If the element spans the chunk boundary, we need to center the text
  if (spansChunk) {
    justifyContent  = 'justify-content: center';
    if (totalWidth < textWidth) {
      textOffset = ((totalWidth - textWidth) / 2) - 5;
    }
    textOffset       += ((leftOverflow + rightOverflow) / 2) * viewportSpecs.zoomRatio;
    flexWidthOverflow = rightOverflow - leftOverflow;
  }

  const flexWidth    = deltaTime - flexWidthOverflow;
  const elementWidth = flexWidth * viewportSpecs.zoomRatio;

  // If the element is too wide to fit in the viewer, we need to display
  // the value in multiple places so it's always in sight
  if (totalWidth > viewportSpecs.viewerWidth) {
    // count the number of text elements that will be displayed 1 viewer width or 1 text width + 20 px (whichever is greater) in this state
    const renderInterval = Math.max(viewportSpecs.viewerWidth, textWidth + 20);
    const textCount      = 1 + Math.floor((totalWidth - textWidth) / renderInterval);
    // figure out which ones are in the chunk and where they are relative to the chunk boundary
    const firstOffset    = Math.min(time * viewportSpecs.zoomRatio, 0) + ((totalWidth - ((textCount - 1) * renderInterval)) / 2);
    const lowerBound     = -0.5 * (textWidth + elementWidth);
    const upperBound     =  0.5 * (textWidth + elementWidth);
    let textPosition     = firstOffset - (0.5 * elementWidth);
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

  const divTag  = `<div class="bus-waveform-value" style="flex:${flexWidth};${justifyContent}">`;
  return `${divTag}${pElement}</div>`;
}

function busValue(time: number, deltaTime: number, displayValue: string, viewportSpecs: any, justifydirection: string, spansChunk: boolean) {
  let textTime = displayValue.length * characterWidth * viewportSpecs.pixelTime;
  let padding  = 4 * viewportSpecs.pixelTime;
  let text = displayValue;
  let adjestedDeltaTime = deltaTime;
  let adjustedTime = time;
  let xValue;
  let center = true;

  if (spansChunk) {
    adjustedTime = Math.max(time, viewportSpecs.timeScrollLeft);
    adjestedDeltaTime = Math.min(time + deltaTime, viewportSpecs.timeScrollRight) - adjustedTime;
  }

  let characterWidthLimit = adjestedDeltaTime - (2 * padding);

  if (textTime > characterWidthLimit) {
    center = false;
    const charCount = Math.floor(characterWidthLimit / (characterWidth * viewportSpecs.pixelTime)) - 1;
    if (charCount < 1) {return ["", -100];}
    if (justifydirection === "right") {
      xValue = adjustedTime + adjestedDeltaTime - padding;
      text = '…' + displayValue.slice(-charCount);
    } else {
      xValue = adjustedTime + padding;
      text = displayValue.slice(0, charCount) + '…';
    }
  } else {
    xValue = adjustedTime + (adjestedDeltaTime / 2);
  }

  return [text, xValue, center];
}


export const multiBitWaveformRenderer: WaveformRenderer = {
  id: "multiBit",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {

    const canvasElement  = netlistData.canvas;
    if (!canvasElement) {return;}
    const ctx            = canvasElement.getContext('2d');
    if (!ctx) {return;}

    const transitionData = valueChangeChunk.valueChanges;
    const initialState   = valueChangeChunk.initialState;
    const postState      = valueChangeChunk.postState;
    const signalWidth    = netlistData.signalWidth;
    const parseValue     = netlistData.valueFormat.formatString;
    const valueIs9State  = netlistData.valueFormat.is9State;
    const justifydirection = netlistData.valueFormat.rightJustify ? "right" : "left";

    let elementWidth;
    let is4State        = false;
    let value           = initialState[1];
    let time            = initialState[0];
    let xPosition       = 0;
    let yPosition       = 0;
    let points          = [[time, 0]];
    const endPoints     = [[time, 0]];
    let xzPoints: any   = [];
    //const xzValues: string[]        = [];
    let textElements: any[]    = [];
    let spansChunk      = true;
    let moveCursor      = false;
    let drawBackgroundStrokes = false;
    const minTextWidth  = 12 * viewportSpecs.pixelTime;
    const minDrawWidth  = viewportSpecs.pixelTime;
    let leftOverflow    = Math.min(initialState[0], 0);
    const rightOverflow = Math.max(postState[0] - viewportSpecs.columnTime, 0);
    const drawColor        = netlistData.color;
    const xzColor          = "var(--vscode-debugTokenExpression-error)";

    for (let i = 0; i < transitionData.length; i++) {

      elementWidth = transitionData[i][0] - time;

      // If the element is too small to draw, we need to skip it
      if (elementWidth > minDrawWidth) {

        if (moveCursor) {
          points.push([time, 0]);
          endPoints.push([time, 0]);
          moveCursor = false;
        }

        is4State     = valueIs9State(value);
        xPosition    = (elementWidth / 2) + time;
        yPosition    =  elementWidth * 2;
        if (is4State) {
          xzPoints.push([time, 0], [xPosition, yPosition], [transitionData[i][0], 0], [xPosition, -yPosition]);
        } else {
          points.push([xPosition, yPosition]);
          endPoints.push([xPosition, -yPosition]);
        }

        // Don't even bother rendering text if the element is too small. Since 
        // there's an upper limit to the number of larger elements that will be 
        // displayed, we can spend a little more time rendering them and making them
        // readable in all cases.
        // We group the empty text elements that are too small to render together to
        // reduce the number of DOM operations
        if (elementWidth > minTextWidth) {
          const parsedValue = parseValue(value, signalWidth, !is4State);
          spansChunk = spansChunk || (transitionData[i][0] > viewportSpecs.timeScrollRight);
          textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, justifydirection, spansChunk));
        }

        points.push([transitionData[i][0], 0]);
        endPoints.push([transitionData[i][0], 0]);
      } else {
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
        points.push([time, 0]);
        endPoints.push([time, 0]);
        moveCursor = false;
      }

      xPosition    = (elementWidth / 2) + time;
      is4State     = valueIs9State(value);
      if (is4State) {
        xzPoints.push([time, 0], [xPosition, elementWidth * 2], [postState[0], 0], [xPosition, -elementWidth * 2]);
      } else {
        points.push([xPosition, elementWidth * 2]);
        points.push([postState[0], 0]);
        endPoints.push([xPosition, -elementWidth * 2]);
      }
    }

    if (elementWidth > minTextWidth) {
      const parsedValue = parseValue(value, signalWidth, !is4State);
      textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, justifydirection, spansChunk));
    }

    ctx.clearRect(0, 0, viewportSpecs.viewerWidth, 20);
    ctx.save();
    ctx.translate(0, 10);

    // No Draw Line
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(viewportSpecs.viewerWidth, 0);
    ctx.strokeStyle = 'green';
    ctx.stroke();

    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(viewportSpecs.viewerWidth, 0);
    ctx.strokeStyle = 'green';
    ctx.stroke();
    ctx.moveTo(0, 0);

    // Draw diamonds
    ctx.restore();
    ctx.save();
    ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, 10);
    //ctx.globalAlpha = 1;
    ctx.fillStyle = 'green';
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, viewportSpecs.zoomRatio, 0, 0);
    //ctx.transform(1/viewportSpecs.zoomRatio, 0, 0, 1, 0, 0);
    ctx.beginPath();
    points.forEach(([x, y]) => {ctx.lineTo(x, y);});
    endPoints.reverse().forEach(([x, y]) => {ctx.lineTo(x, y);});
    ctx.fill();


    // Draw non-2-state values
    //ctx.fillStyle = 'red';
    //xzPoints.forEach(set => {
    //  ctx.beginPath();
    //  ctx.moveTo(set[0][0], set[0][1]);
    //  ctx.lineTo(set[1][0], set[1][1]);
    //  ctx.lineTo(set[2][0], set[2][1]);
    //  ctx.lineTo(set[3][0], set[3][1]);
    //  ctx.fill();
    //});
    ctx.restore();

    // Draw Text
    ctx.save();
    ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, 10);
    ctx.font = '12px Menlo';
    ctx.fillStyle = 'black';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    textElements.forEach(([text, xValue, center]) => {
      if (center) {ctx.fillText(text, xValue * viewportSpecs.zoomRatio, 0)};
    });
    ctx.textAlign = justifydirection;
    textElements.forEach(([text, xValue, center]) => {
      if (!center) {ctx.fillText(text, xValue * viewportSpecs.zoomRatio, 0)};
    });

    ctx.restore();

    return 'result';

    //const polyline    = points + endPoints.reverse().join(' ');
    //const svgHeight   = 20;
    //const gAttributes = `stroke="none" transform="scale(${viewportSpecs.zoomRatio})"`;
    //const polylineAttributes = `fill="${drawColor}"`;
    //let backgroundStrokes = "";
    //if (drawBackgroundStrokes) {
    //  backgroundStrokes += `<polyline points="0,0 ${viewportSpecs.columnTime},0" stroke="${drawColor}" stroke-width="3px" stroke-opacity="40%" vector-effect="non-scaling-stroke"/>`;
    //  backgroundStrokes += `<polyline points="0,0 ${viewportSpecs.columnTime},0" stroke="${drawColor}" stroke-width="1px" stroke-opacity="80%" vector-effect="non-scaling-stroke"/>`;
    //}
    //let result = '';
    //result += `<svg height="${svgHeight}" width="${viewportSpecs.columnWidth}" viewbox="0 -10 ${viewportSpecs.columnWidth} ${svgHeight}" class="bus-waveform-svg">`;
    //result += `<g ${gAttributes}>${backgroundStrokes}`;
    //result += `<path ${polylineAttributes} d="${polyline}"/>`;
    //result += `<path d="${xzPoints}" fill="${xzColor}"/></g></svg>`;
    //result += textElements;
    //return result;

    //const resultFragment = document.createDocumentFragment();
    //resultFragment.replaceChildren(...domParser.parseFromString(result, 'text/html').body.children);
    //return resultFragment;
  },
};

function drawMultiBit(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
  const transitionData = valueChangeChunk.valueChanges;
  const initialState   = valueChangeChunk.initialState;
  const postState      = valueChangeChunk.postState;
  const signalWidth    = netlistData.signalWidth;
  const parseValue     = netlistData.valueFormat.formatString;
  const valueIs9State  = netlistData.valueFormat.is9State;
  const justifydirection = netlistData.valueFormat.rightJustify ? "right" : "left";

  let elementWidth;
  let is4State        = false;
  let value           = initialState[1];
  let time            = initialState[0];
  let emptyDivWidth   = 0;
  let xPosition       = 0;
  let yPosition       = 0;
  let points          = 'M ' + time + ' 0';
  const endPoints       = ['M ' + time + ' 0'];
  let xzPoints        = '';
  //const xzValues: string[]        = [];
  let textElements: string    = '';
  let spansChunk      = true;
  let moveCursor      = false;
  let drawBackgroundStrokes = false;
  const minTextWidth  = 12 / viewportSpecs.zoomRatio;
  const minDrawWidth  = 1 / viewportSpecs.zoomRatio;
  let leftOverflow    = Math.min(initialState[0], 0);
  const rightOverflow = Math.max(postState[0] - viewportSpecs.columnTime, 0);
  const drawColor        = netlistData.color;
  const xzColor          = "var(--vscode-debugTokenExpression-error)";

  for (let i = 0; i < transitionData.length; i++) {

    elementWidth = transitionData[i][0] - time;

    // If the element is too small to draw, we need to skip it
    if (elementWidth > minDrawWidth) {

      if (moveCursor) {
        points += ' L ' + time + ' 0';
        endPoints.push(' L ' + time + ' 0');
        moveCursor = false;
      }

      is4State     = valueIs9State(value);
      xPosition    = (elementWidth / 2) + time;
      yPosition    =  elementWidth * 2;
      if (is4State) {
        xzPoints += `M ${time} 0 L ${xPosition} ${yPosition} L ${transitionData[i][0]} 0 L ${xPosition} -${yPosition}`;
      } else {
        points +=   ' L ' + xPosition + ' ' + yPosition;
        endPoints.push(' L ' + xPosition + ' -' + yPosition);
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
        const parsedValue = parseValue(value, signalWidth, !is4State);
        textElements += busElement(time, elementWidth, parsedValue, spansChunk, parsedValue.length * characterWidth, leftOverflow, 0, viewportSpecs, justifydirection);
      } else {
        emptyDivWidth += elementWidth + leftOverflow;
      }

      points      += ' L ' + transitionData[i][0] + ' 0';
      endPoints.push(' L ' + transitionData[i][0] + ' 0');
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
      points +=      ' L ' + time + ' 0';
      endPoints.push(' L ' + time + ' 0');
      moveCursor = false;
    }

    xPosition    = (elementWidth / 2) + time;
    is4State     = valueIs9State(value);
    if (is4State) {
      xzPoints += `M ${time} 0 L ${xPosition} ${elementWidth * 2} L ${postState[0]} 0 L ${xPosition} -${elementWidth * 2}`;
    } else {
      points      += ' L ' + xPosition + ' ' + elementWidth * 2;
      points      += ' L ' + postState[0] + ' 0';
      endPoints.push(' L ' + xPosition + ' -' + elementWidth * 2);
    }
  }

  if (elementWidth > minTextWidth) {
    if (emptyDivWidth > 0) {
      textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
    }
    emptyDivWidth = 0;
    const parsedValue = parseValue(value, signalWidth, !is4State);
    textElements += busElement(time, elementWidth, parsedValue, true, parsedValue.length * characterWidth, leftOverflow, rightOverflow, viewportSpecs, justifydirection);
  } else {
    emptyDivWidth += elementWidth + leftOverflow - rightOverflow;
    textElements += `<div class="bus-waveform-value" style="flex:${emptyDivWidth};"></div>`;
  }

  const polyline    = points + endPoints.reverse().join(' ');
  const svgHeight   = 20;
  const gAttributes = `stroke="none" transform="scale(${viewportSpecs.zoomRatio})"`;
  const polylineAttributes = `fill="${drawColor}"`;
  let backgroundStrokes = "";
  if (drawBackgroundStrokes) {
    backgroundStrokes += `<polyline points="0,0 ${viewportSpecs.columnTime},0" stroke="${drawColor}" stroke-width="3px" stroke-opacity="40%" vector-effect="non-scaling-stroke"/>`;
    backgroundStrokes += `<polyline points="0,0 ${viewportSpecs.columnTime},0" stroke="${drawColor}" stroke-width="1px" stroke-opacity="80%" vector-effect="non-scaling-stroke"/>`;
  }
  let result = '';
  result += `<svg height="${svgHeight}" width="${viewportSpecs.columnWidth}" viewbox="0 -10 ${viewportSpecs.columnWidth} ${svgHeight}" class="bus-waveform-svg">`;
  result += `<g ${gAttributes}>${backgroundStrokes}`;
  result += `<path ${polylineAttributes} d="${polyline}"/>`;
  result += `<path d="${xzPoints}" fill="${xzColor}"/></g></svg>`;
  result += textElements;
  return result;

  //const resultFragment = document.createDocumentFragment();
  //resultFragment.replaceChildren(...domParser.parseFromString(result, 'text/html').body.children);
  //return resultFragment;
};

export const binaryWaveformRenderer: WaveformRenderer = {
  id: "binary",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {

    var style = window.getComputedStyle(document.body);

    const canvasElement  = netlistData.canvas;
    if (!canvasElement) {return;}
    const ctx            = canvasElement.getContext('2d');
    if (!ctx) {return;}

    const transitionData = valueChangeChunk.valueChanges;
    const initialState   = valueChangeChunk.initialState;
    const postState      = valueChangeChunk.postState;

    let initialValue       = initialState[1];
    let initialValue2state = parseInt(initialValue);
    let initialTime        = initialState[0];
    let initialTimeOrStart = Math.max(initialState[0], -10);
    const minDrawWidth     = 1 / viewportSpecs.zoomRatio;
    let xzPath:any         = [];
    //const drawColor        = style.getPropertyValue(netlistData.color);
    const drawColor        = 'green';
    const xzColor          = style.getPropertyValue("var(--vscode-debugTokenExpression-error)");
    const viewerWidthTime   = viewportSpecs.viewerWidthTime;
    const timeScrollLeft    = viewportSpecs.timeScrollLeft;
    const timeScrollRight   = viewportSpecs.timeScrollRight;
    const valueIs9State    = netlistData.valueFormat.is9State;

    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
    }
    let accumulatedPath    = [[0, initialValue2state]];

    let value2state    = 0;
    // No Draw Code
    let lastDrawTime   = 0;
    let lastNoDrawTime: any = null;
    let noDrawFlag     = false;
    let noDrawPath: any     = [];
    let lastDrawValue  = initialValue2state;
    let lastnoDrawValue: any = null;

    transitionData.forEach(([time, value]) => {

      if (time - initialTime < minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
        lastnoDrawValue = value;
      } else {

        if (noDrawFlag) {
          initialValue2state = parseInt(initialValue);
          if (valueIs9State(initialValue)) {initialValue2state = 0;}

          noDrawPath.push([lastDrawTime, 0, lastNoDrawTime - lastDrawTime, 1]);
          accumulatedPath.push([lastDrawTime, 0]);
          accumulatedPath.push([lastNoDrawTime, 0]);
          accumulatedPath.push([lastNoDrawTime, initialValue2state]);
          noDrawFlag = false;
        }

        if (valueIs9State(initialValue)) {
          xzPath.push([initialTimeOrStart, 0, time - initialTimeOrStart, 1]);
          //if (initialTimeOrStart >= 0) {
          //  xzPath += `L ${initialTimeOrStart} 0 `;
          //}
        }

        value2state = parseInt(value);
        if (valueIs9State(value)) {value2state =  0;}

        // Draw the current transition to the main path
        accumulatedPath.push([time, initialValue2state]);
        accumulatedPath.push([time, value2state]);

        lastDrawValue      = value2state;
        lastDrawTime       = time;
        initialValue2state = value2state;
      }

      initialValue       = value;
      initialTimeOrStart = time;
      initialTime        = time;
    });

    initialValue2state = parseInt(initialValue);
    if (valueIs9State(initialValue)) {initialValue2state = 0;}

    if (postState[0] - initialTime < minDrawWidth) {

        noDrawPath.push([lastDrawTime, 0, viewerWidthTime - lastDrawTime, 1]);
        accumulatedPath.push([lastDrawTime, 0]);
        accumulatedPath.push([timeScrollRight, 0]);


    } else {

      if (noDrawFlag) {

        noDrawPath.push([lastDrawTime, 0, lastNoDrawTime - lastDrawTime, 1]);
        accumulatedPath.push([lastDrawTime, 0]);
        accumulatedPath.push([lastNoDrawTime, 0]);
        accumulatedPath.push([lastNoDrawTime, initialValue2state]);
      }

      if (valueIs9State(initialValue))  {

        if (initialTimeOrStart >= 0) {
          xzPath.push([initialTimeOrStart, 0, timeScrollRight, 1]);
        } else {
          xzPath.push([initialTimeOrStart, 0, timeScrollRight, 1]);
        }
      }
    }

    //accumulatedPath += " L " + columnTime + " " + initialValue2state;
    accumulatedPath.push([timeScrollRight, initialValue2state]);

    //console.log(accumulatedPath);
    //console.log(drawColor);

    // Polylines
    //const polyline     = `<path d="M ` + accumulatedPath + `" stroke="${drawColor}"/>`;
    //const noDraw       = `<path d="${noDrawPath}" stroke="${drawColor}" fill="${drawColor}"/>`;
    //const shadedArea   = `<path d="M 0 0 L ${accumulatedPath} L ${columnTime} 0" stroke="none" fill="${drawColor}" fill-opacity="0.1"/>`;
    //const xzPolylines  = xzPath ? `<path d="${xzPath}" stroke="${xzColor}"/>` : '';


    const svgHeight  = 20;
    const waveHeight = 16;
    const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;

    ctx.clearRect(0, 0, viewportSpecs.viewerWidth, svgHeight);
    ctx.save();
    ctx.strokeStyle = drawColor;
    ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, waveOffset + 0.5);
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, -waveHeight, 0, 0);
    //ctx.transform(1/viewportSpecs.zoomRatio, 0, 0, 1, 0, 0);
    ctx.beginPath();
    accumulatedPath.forEach(([x, y]) => {ctx.lineTo(x, y);});
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = drawColor;
    ctx.stroke();


    // SVG element
    //const gAttributes = `fill="none" transform="translate(0.5 ${waveOffset}.5) scale(${viewportSpecs.zoomRatio} -${waveHeight})"`;
    //let result = '';
    //result += `<svg height="${svgHeight}" width="${viewportSpecs.columnWidth}" viewbox="0 0 ${viewportSpecs.columnWidth} ${svgHeight}" class="binary-waveform-svg">`;
    //result += `<g ${gAttributes}>`;
    ////result += polyline + shadedArea + noDraw + xzPolylines;
    //result += `</g></svg>`;
    //return result;
  }

};

function drawBinary(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
  const canvasElement  = netlistData.canvas;
  if (!canvasElement) {return;}
  const ctx            = canvasElement.getContext('2d');
  const transitionData = valueChangeChunk.valueChanges;
  const initialState   = valueChangeChunk.initialState;
  const postState      = valueChangeChunk.postState;

  let initialValue       = initialState[1];
  let initialValue2state = initialValue;
  let initialTime        = initialState[0];
  let initialTimeOrStart = Math.max(initialState[0], -10);
  const minDrawWidth     = 1 / viewportSpecs.zoomRatio;
  let xzPath = "";
  const drawColor        = netlistData.color;
  const xzColor          = "var(--vscode-debugTokenExpression-error)";
  const columnTime       = viewportSpecs.columnTime;
  const valueIs9State    = netlistData.valueFormat.is9State;

  if (valueIs9State(initialValue)) {
    initialValue2state = "0";
  }
  let accumulatedPath    = " 0 " + initialValue2state;

  let value2state    = "0";
  // No Draw Code
  let lastDrawTime   = 0;
  let lastNoDrawTime: any = null;
  let noDrawFlag     = false;
  let noDrawPath: string     = "";
  let lastDrawValue  = initialValue2state;
  let lastnoDrawValue: any = null;

  transitionData.forEach(([time, value]) => {

    if (time - initialTime < minDrawWidth) {
      noDrawFlag     = true;
      lastNoDrawTime = time;
      lastnoDrawValue = value;
    } else {

      if (noDrawFlag) {
        initialValue2state = initialValue;
        if (valueIs9State(initialValue)) {initialValue2state = "0";}

        noDrawPath +=      " M " + lastDrawTime + " 0 L" + lastDrawTime + " 1 L " + lastNoDrawTime + " 1 L " + lastNoDrawTime + " 0 ";
        accumulatedPath += " L " + lastDrawTime + " 0 ";
        accumulatedPath += " L " + lastNoDrawTime + " 0";
        accumulatedPath += " L " + lastNoDrawTime + " " + initialValue2state;
        noDrawFlag = false;
      }

      if (valueIs9State(initialValue)) {
        xzPath   += `M ${initialTimeOrStart} 0 L ${time} 0 L ${time} 1 L ${initialTimeOrStart} 1 `;
        if (initialTimeOrStart >= 0) {
          xzPath += `L ${initialTimeOrStart} 0 `;
        }
      }

      value2state = value;
      if (valueIs9State(value)) {value2state =  "0";}

      // Draw the current transition to the main path
      accumulatedPath += " L " + time + " " + initialValue2state;
      accumulatedPath += " L " + time + " " + value2state;

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

      noDrawPath += " M " + lastDrawTime + " 0 L " + lastDrawTime + " 1 L " + columnTime + " 1 L " + columnTime + " 0 ";
      accumulatedPath += " L " + lastDrawTime + " 0 ";
      accumulatedPath += " L " + columnTime + " 0 ";

  } else {

    if (noDrawFlag) {

      noDrawPath      += " M " + lastDrawTime + " 0 L " + lastDrawTime + " 1 L " + lastNoDrawTime + " 1 L " + lastNoDrawTime + " 0 ";
      accumulatedPath += " L " + lastDrawTime + " 0 ";
      accumulatedPath += " L " + lastNoDrawTime + " 0 ";
      accumulatedPath += " L " + lastNoDrawTime + " " + initialValue2state;
    }

    if (valueIs9State(initialValue))  {

      if (initialTimeOrStart >= 0) {
        
        xzPath += `M ${columnTime} 1 L ${initialTimeOrStart} 1 L ${initialTimeOrStart} 0 L ${columnTime} 0 `;
      } else {
        xzPath += `M ${initialTimeOrStart} 0 L ${columnTime} 0 M ${initialTimeOrStart} 1 L ${columnTime} 1 `;
      }
    }
  }

  accumulatedPath += " L " + columnTime + " " + initialValue2state;

  // Polylines
  const polyline     = `<path d="M ` + accumulatedPath + `" stroke="${drawColor}"/>`;
  const noDraw       = `<path d="${noDrawPath}" stroke="${drawColor}" fill="${drawColor}"/>`;
  const shadedArea   = `<path d="M 0 0 L ${accumulatedPath} L ${columnTime} 0" stroke="none" fill="${drawColor}" fill-opacity="0.1"/>`;
  const xzPolylines  = xzPath ? `<path d="${xzPath}" stroke="${xzColor}"/>` : '';

  // SVG element
  const svgHeight  = 20;
  const waveHeight = 16;
  const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
  const gAttributes = `fill="none" transform="translate(0.5 ${waveOffset}.5) scale(${viewportSpecs.zoomRatio} -${waveHeight})"`;
  let result = '';
  result += `<svg height="${svgHeight}" width="${viewportSpecs.columnWidth}" viewbox="0 0 ${viewportSpecs.columnWidth} ${svgHeight}" class="binary-waveform-svg">`;
  result += `<g ${gAttributes}>`;
  result += polyline + shadedArea + noDraw + xzPolylines;
  result += `</g></svg>`;
  return result;

  //const resultFragment = document.createDocumentFragment();
  //resultFragment.replaceChildren(...domParser.parseFromString(result, 'text/html').body.childNodes);
  //return resultFragment;
}

function createSvgWaveform(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any, stepped: boolean, evalCoordinates: (v: string) => number) {
  const transitionData   = valueChangeChunk.valueChanges;
  const initialState     = valueChangeChunk.initialState;
  const postState        = valueChangeChunk.postState;
  const min              = valueChangeChunk.min;
  const max              = valueChangeChunk.max;
  let initialValue       = initialState[1];
  let initialValue2state = initialValue;
  let initialTime        = initialState[0];
  let initialTimeOrStart = Math.max(initialState[0], -10);
  const minDrawWidth     = 0.25 / viewportSpecs.zoomRatio;
  let xzPath             = "";
  const drawColor        = netlistData.color;
  const xzColor          = "var(--vscode-debugTokenExpression-error)";
  const columnTime       = viewportSpecs.columnTime.toString();
  const valueIs9State    = netlistData.valueFormat.is9State;

  if (valueIs9State(initialValue)) {
    initialValue2state = "0";
  }

  let accumulatedPath;

  let interpolatedInitialValue;
  let interpolatedPostState;
  if (!stepped) {
    let firstValue;
    let lastValue;
    let firstTime;
    let lastTime;
    if (transitionData.length > 0) {
      firstValue = evalCoordinates(transitionData[0][1]);
      lastValue  = evalCoordinates(transitionData[transitionData.length - 1][1]);
      firstTime  = transitionData[0][0];
      lastTime   = transitionData[transitionData.length - 1][0];
    } else {
      firstValue = evalCoordinates(postState[1]);
      lastValue  = evalCoordinates(initialValue);
      firstTime  = postState[0];
      lastTime   = initialTime;
    }
    interpolatedInitialValue = (((firstValue - evalCoordinates(initialValue)) / (firstTime - initialTime)) * (-1 * initialTime)) + evalCoordinates(initialValue);
    interpolatedPostState    = (((lastValue - evalCoordinates(postState[1])) / (postState[0] - lastTime)) * (postState[0] - viewportSpecs.columnTime)) + evalCoordinates(postState[1]);
    accumulatedPath = " 0 " + interpolatedInitialValue;
  } else {
    accumulatedPath = " 0 " + evalCoordinates(initialValue2state);
  }


  let value2state    = "0";
  // No Draw Code
  let lastDrawTime   = 0;
  let lastNoDrawTime: any = null;
  let noDrawFlag     = false;
  let noDrawPath: string     = "";
  let lastDrawValue  = initialValue2state;
  let lastnoDrawValue: any = null;

  transitionData.forEach(([time, value]) => {

    if (time - initialTime < minDrawWidth) {
      noDrawFlag     = true;
      lastNoDrawTime = time;
      lastnoDrawValue = value;
    } else {

      if (noDrawFlag) {
        initialValue2state = initialValue;
        if (valueIs9State(initialValue)) {initialValue2state = "0";}

        noDrawPath +=      " M " + lastDrawTime + " " + min + " L" + lastDrawTime + " " + max + " L " + lastNoDrawTime + " " + max + " L " + lastNoDrawTime + " " + min + " ";
        accumulatedPath += " L " + lastDrawTime + " 0 ";
        accumulatedPath += " L " + lastNoDrawTime + " 0";
        accumulatedPath += " L " + lastNoDrawTime + " " + evalCoordinates(initialValue2state);
        noDrawFlag = false;
      }

      if (valueIs9State(initialValue)) {
        xzPath   += `M ${initialTimeOrStart} 0 L ${time} 0 L ${time} 1 L ${initialTimeOrStart} 1 `;
        if (initialTimeOrStart >= 0) {
          xzPath += `L ${initialTimeOrStart} 0 `;
        }
      }

      value2state = value;
      if (valueIs9State(value)) {value2state =  "0";}

      // Draw the current transition to the main path
      if (stepped) {
        accumulatedPath += " L " + time + " " + evalCoordinates(initialValue2state);
      }
      accumulatedPath += " L " + time + " " + evalCoordinates(value2state);

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

      noDrawPath += " M " + lastDrawTime + " " + min + " L " + lastDrawTime + " " + max + " L " + columnTime + " " + max + " L " + columnTime + " " + min + " ";
      accumulatedPath += " L " + lastDrawTime + " 0 ";
      accumulatedPath += " L " + columnTime + " 0 ";

  } else {

    if (noDrawFlag) {

      noDrawPath      += " M " + lastDrawTime + " " + min + " L " + lastDrawTime + " " + max + " L " + lastNoDrawTime + " " + max + " L " + lastNoDrawTime + " " + min + " ";
      accumulatedPath += " L " + lastDrawTime + " 0 ";
      accumulatedPath += " L " + lastNoDrawTime + " 0 ";
      accumulatedPath += " L " + lastNoDrawTime + " " + evalCoordinates(initialValue2state);
    }

    if (valueIs9State(initialValue))  {

      if (initialTimeOrStart >= 0) {
        
        xzPath += `M ${columnTime} 1 L ${initialTimeOrStart} 1 L ${initialTimeOrStart} 0 L ${columnTime} 0 `;
      } else {
        xzPath += `M ${initialTimeOrStart} 0 L ${columnTime} 0 M ${initialTimeOrStart} 1 L ${columnTime} 1 `;
      }
    }
  }

  if (stepped) {
    accumulatedPath += " L " + columnTime + " " + evalCoordinates(initialValue2state);
  } else {
    accumulatedPath += " L " + columnTime + " " + interpolatedPostState;
  }

  // Polylines
  const polyline     = `<path d="M ` + accumulatedPath + `" stroke="${drawColor}"/>`;
  const noDraw       = `<path d="${noDrawPath}" stroke="${drawColor}" fill="${drawColor}"/>`;
  const shadedArea   = `<path d="M 0 0 L ${accumulatedPath} L ${columnTime} 0" stroke="none" fill="${drawColor}" fill-opacity="0.1"/>`;
  const xzPolylines  = xzPath ? `<path d="${xzPath}" stroke="${xzColor}"/>` : '';

  // SVG element
  const svgHeight  = 20;
  const waveHeight = 16;
  const yScale     = waveHeight / (max - min);
  const waveOffset = waveHeight + (svgHeight - waveHeight) / 2;
  const translateY = 0.5 + (max / (max - min)) * waveOffset;
  const gAttributes = `fill="none" transform="translate(0.5 ${translateY}) scale(${viewportSpecs.zoomRatio} -${yScale})"`;
  let result = '';
  result += `<svg height="${svgHeight}" width="${viewportSpecs.columnWidth}" viewbox="0 0 ${viewportSpecs.columnWidth} ${svgHeight}" class="binary-waveform-svg">`;
  result += `<g ${gAttributes}>`;
  result += polyline + shadedArea + noDraw + xzPolylines;
  result += `</g></svg>`;
  return result;

  //const resultFragment = document.createDocumentFragment();
  //resultFragment.replaceChildren(...domParser.parseFromString(result, 'text/html').body.childNodes);
  //return resultFragment;
}

const evalBinary8plusSigned = (v: string) => {
  const n = parseInt(v.slice(0,8), 2) || 0;
  return n > 127 ? n - 256 : n;
};
const evalBinarySigned = (v: string) => {
  const n = parseInt(v, 2) || 0;
  return v[0] === '1' ? n - (2 ** v.length) : n;
};
const evalBinary8plus = (v: string) => {return parseInt(v.slice(0,8), 2) || 0;};
const evalBinary = (v: string) => {return parseInt(v, 2) || 0;};
const evalReal = (v: string) => {return parseFloat(v) || 0;};

function getEval(type: string, width: number, signed: boolean) {
  if (type === "Real") {return evalReal;}

  if (width > 8) {
    if (signed) {return evalBinary8plusSigned;}
    else {       return evalBinary8plus;}
  } else {
    if (signed) {return evalBinarySigned;}
    else {       return evalBinary;}
  }
}

export const linearWaveformRenderer: WaveformRenderer = {
  id: "linear",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, false, evalCoordinates);
  }
};

export const signedLinearWaveformRenderer: WaveformRenderer = {
  id: "linearSigned",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, true);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, false, evalCoordinates);
  }
};

export const steppedrWaveformRenderer: WaveformRenderer = {
  id: "stepped",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, true, evalCoordinates);
  }
};

export const signedSteppedrWaveformRenderer: WaveformRenderer = {
  id: "steppedSigned",

  draw(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, true);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, true, evalCoordinates);
  }
};