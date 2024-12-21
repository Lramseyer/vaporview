import { NetlistData } from './vaporview';

// green  var(--vscode-debugTokenExpression-number)
// orange var(--vscode-debugTokenExpression-string)
// blue   var(--vscode-debugView-valueChangedHighlight)
// purple var(--vscode-debugTokenExpression-name)

export interface WaveformRenderer {
  id: string;
  createSvgFromValueChangeChunk(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any): string;
  busElement?: any
}

export const multiBitWaveformRenderer: WaveformRenderer = {
  id: "Multi Bit",
  
  // This function actually creates the individual bus elements, and has can
  // potentially called thousands of times during a render
  busElement(time: number, deltaTime: number, displayValue: string, spansChunk: boolean, textWidth: number, leftOverflow: number, rightOverflow: number, viewportSpecs: any) {
    let pElement           = '';
    let justifyDirection   = '';
    let textOffset         = 0;
    const totalWidth       = deltaTime * viewportSpecs.zoomRatio; 
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

    const divTag  = `<div class="bus-waveform-value" style="flex:${flexWidth};${justifyDirection}">`;
    return `${divTag}${pElement}</div>`;
  },

  createSvgFromValueChangeChunk(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
    const transitionData = valueChangeChunk.valueChanges;
    const initialState   = valueChangeChunk.initialState;
    const postState      = valueChangeChunk.postState;
    const signalWidth    = netlistData.signalWidth;
    const textWidth      = netlistData.textWidth;
    const parseValue     = netlistData.valueFormat.formatString;
    const valueIs9State  = netlistData.valueFormat.is9State;

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
          textElements += this.busElement(time, elementWidth, parseValue(value, signalWidth, !is4State), spansChunk, textWidth, leftOverflow, 0, viewportSpecs);
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
      textElements += this.busElement(time, elementWidth, parseValue(value, signalWidth, !is4State), true, textWidth, leftOverflow, rightOverflow, viewportSpecs);
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
  },
};

export const binaryWaveformRenderer: WaveformRenderer = {
  id: "Binary",

  createSvgFromValueChangeChunk(valueChangeChunk: any, netlistData: NetlistData, viewportSpecs: any) {
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
    const columnTime       = viewportSpecs.columnTime.toString();
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
};