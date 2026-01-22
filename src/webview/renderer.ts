//import { NetlistData } from './vaporview';
import { VariableItem } from './signal_item';
import { Viewport } from './viewport';
import { WAVE_HEIGHT } from './vaporview';

export interface WaveformRenderer {
  id: string;
  draw(valueChangeChunk: any, netlistData: VariableItem, viewport: Viewport): void;
}

// This function actually creates the individual bus elements, and has can
// potentially called thousands of times during a render
function busValue(time: number, deltaTime: number, displayValue: string, viewportSpecs: any, justifyDirection: boolean) {
  const textTime            = displayValue.length * viewportSpecs.characterWidth * viewportSpecs.pixelTime;
  const padding             = 4 * viewportSpecs.pixelTime;
  const adjustedTime        = Math.max(time, viewportSpecs.timeScrollLeft);
  const adjustedDeltaTime   = Math.min(time + deltaTime, viewportSpecs.timeScrollRight) - adjustedTime;
  const characterWidthLimit = adjustedDeltaTime - (2 * padding);
  const centerText          = (textTime <= characterWidthLimit);
  let text                  = displayValue;
  let xValue;

  if (centerText) {
    xValue = adjustedTime + (adjustedDeltaTime / 2);
  } else {
    const charCount = Math.floor(characterWidthLimit / (viewportSpecs.characterWidth * viewportSpecs.pixelTime)) - 1;
    if (charCount < 0) {return ["", -100];}
    if (justifyDirection) {
      xValue = adjustedTime + adjustedDeltaTime - padding;
      text = '…' + displayValue.slice(displayValue.length - charCount);
    } else {
      xValue = adjustedTime + padding;
      text = displayValue.slice(0, charCount) + '…';
    }
  }

  const adjustedXValue = (xValue * viewportSpecs.zoomRatio) - viewportSpecs.pseudoScrollLeft;
  return [text, adjustedXValue, centerText];
}

function outlineBusValue(ctx: CanvasRenderingContext2D, drawColor: string, viewportSpecs: any, canvasHeight: number) {
  ctx.restore();
  ctx.save();
  ctx.clip();
  ctx.clearRect(0, 0, viewportSpecs.viewerWidth, canvasHeight);
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = drawColor;
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = drawColor;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.moveTo(0, 0.5);
  ctx.lineTo(viewportSpecs.viewerWidth, 0.5);
  ctx.moveTo(0, canvasHeight - 0.5);
  ctx.lineTo(viewportSpecs.viewerWidth, canvasHeight - 0.5);
  ctx.stroke();
  ctx.restore();
  ctx.save();
}

function busValueNoDraw(ctx: CanvasRenderingContext2D, alpha: number, lineWidth: number, viewerWidth: number) {
  ctx.globalAlpha = alpha;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(viewerWidth, 0);
  ctx.stroke();
}

export const multiBitWaveformRenderer: WaveformRenderer = {
  id: "multiBit",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: Viewport) {

    const ctx            = netlistData.ctx;
    if (!ctx) {return;}

    const transitionData = valueChangeChunk.valueChanges;
    const formattedValues = valueChangeChunk.formattedValues;
    const formatCached   = valueChangeChunk.formatCached;
    const initialState   = valueChangeChunk.initialState;
    const postState      = valueChangeChunk.postState;
    const startIndex     = valueChangeChunk.startIndex;
    const endIndex       = valueChangeChunk.endIndex;

    const signalWidth    = netlistData.signalWidth;
    const parseValue     = netlistData.valueFormat.formatString;
    const valueIs9State  = netlistData.valueFormat.is9State;
    const rightJustify   = netlistData.valueFormat.rightJustify;
    const justifyDirection = rightJustify ? "right" : "left";
    const rowHeight      = netlistData.rowHeight * WAVE_HEIGHT;
    const canvasHeight   = rowHeight - 8;
    const halfCanvasHeight = canvasHeight / 2;

    let elementWidth;
    let is4State        = false;
    let value           = initialState[1];
    let time            = initialState[0];
    let xPosition       = 0;
    let yPosition       = 0;
    const adjustedTime  = time - viewportSpecs.timeScrollLeft;
    let points          = [[adjustedTime, 0]];
    const endPoints     = [[adjustedTime, 0]];
    let xzPoints: any[] = [];
    //const xzValues: string[] = [];
    let textElements: any[] = [];
    let moveCursor      = false;
    let drawBackgroundStrokes = false;
    const minTextWidth  = 12 * viewportSpecs.pixelTime;
    const minDrawWidth  = viewportSpecs.pixelTime / viewportSpecs.pixelRatio;
    const drawColor     = netlistData.color;
    const xzColor       = viewportSpecs.xzColor;
    const fillShape     = viewportSpecs.fillMultiBitValues;
    //const minYPosition  = halfCanvasHeight / viewportSpecs.zoomRatio;
    let lastDrawTime    = 0;
    let parsedValue;
    //const noDrawRanges: any[] = [];

    for (let i = startIndex; i < endIndex; i++) {

      elementWidth = transitionData[i][0] - time;

      // If the element is too small to draw, we need to skip it
      if (elementWidth > minDrawWidth) {

        const adjustedTime = time - viewportSpecs.timeScrollLeft;
        const adjustedTimeEnd = adjustedTime + elementWidth;

        if (moveCursor) {
          points.push([adjustedTime, 0]);
          endPoints.push([adjustedTime, 0]);
          moveCursor = false;
          //noDrawRanges.push([lastDrawTime, adjustedTime]);
        }

        is4State  = valueIs9State(value);
        xPosition = (elementWidth / 2) + adjustedTime;
        yPosition =  elementWidth * 2;
        //yPosition =  Math.max(elementWidth * 2, minYPosition);
        if (is4State) {
          xzPoints.push([[adjustedTime, 0], [xPosition, yPosition], [adjustedTimeEnd, 0], [xPosition, -yPosition]]);
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
          if (formatCached) {
            parsedValue = formattedValues[i - 1];
          } else {
            parsedValue = parseValue(value, signalWidth, !is4State);
          }
          //spansChunk = spansChunk || (transitionData[i][0] > viewportSpecs.timeScrollRight);
          textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, rightJustify));
        }

        points.push([adjustedTimeEnd, 0]);
        endPoints.push([adjustedTimeEnd, 0]);
        lastDrawTime = adjustedTimeEnd;
      } else {
        drawBackgroundStrokes = true;
        moveCursor = true;
      }

      time  = transitionData[i][0];
      value = transitionData[i][1];
      //spansChunk   = false;
    }

    elementWidth = postState[0] - time;

    if (elementWidth > minDrawWidth) {

      const adjustedTime = time - viewportSpecs.timeScrollLeft;
      const adjustedTimeEnd = postState[0] + - viewportSpecs.timeScrollLeft;

      if (moveCursor) {
        points.push([adjustedTime, 0]);
        endPoints.push([adjustedTime, 0]);
        moveCursor = false;
        //noDrawRanges.push([lastDrawTime, adjustedTime]);
      }

      xPosition = (elementWidth / 2) + adjustedTime;
      is4State  = valueIs9State(value);
      if (is4State) {
        xzPoints.push([[adjustedTime, 0], [xPosition, elementWidth * 2], [adjustedTimeEnd, 0], [xPosition, -elementWidth * 2]]);
      } else {
        points.push([xPosition, elementWidth * 2]);
        points.push([adjustedTimeEnd, 0]);
        endPoints.push([xPosition, -elementWidth * 2]);
      }
    }

    if (elementWidth > minTextWidth) {
      if (formatCached) {
        parsedValue = formattedValues[endIndex - 1];
      } else {
        parsedValue = parseValue(value, signalWidth, !is4State);
      }
      textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, rightJustify));
    }

    ctx.clearRect(0, 0, viewportSpecs.viewerWidth * viewportSpecs.pixelRatio, canvasHeight * viewportSpecs.pixelRatio);
    ctx.save();
    ctx.translate(0, halfCanvasHeight);

    // No Draw Line
    ctx.strokeStyle = drawColor;
    if (fillShape) {
      busValueNoDraw(ctx, 0.4, 3, viewportSpecs.viewerWidth);
      busValueNoDraw(ctx, 0.8, 1, viewportSpecs.viewerWidth);
    } else {
      busValueNoDraw(ctx, 0.5, 6, viewportSpecs.viewerWidth);
      busValueNoDraw(ctx, 1, 5, viewportSpecs.viewerWidth);
    }
    ctx.moveTo(0, 0);

    // Draw diamonds
    ctx.restore();
    ctx.save();
    ctx.translate(0.5, halfCanvasHeight);
    ctx.globalAlpha = 1;
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, viewportSpecs.zoomRatio, 0, 0);
    ctx.beginPath();
    ctx.moveTo(-viewportSpecs.pixelTime * 2, 0); // This seems to fix a Windows render glitch, but cause another one
    points.forEach(([x, y]) => {ctx.lineTo(x, y);});
    endPoints.reverse().forEach(([x, y]) => {ctx.lineTo(x, y);});

    if (fillShape) {
      ctx.fillStyle = drawColor;
      ctx.fill();
    } else {
      outlineBusValue(ctx, drawColor, viewportSpecs, canvasHeight);
      ctx.translate(0.5, halfCanvasHeight);
      ctx.transform(viewportSpecs.zoomRatio, 0, 0, viewportSpecs.zoomRatio, 0, 0);
    }

    //const gradient = ctx.createLinearGradient(0, 2 * minYPosition, 0, -2 * minYPosition);
    //gradient.addColorStop(0, "rgba(0, 0, 0, 0)");
    //gradient.addColorStop(0.5, drawColor);
    //gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
    //ctx.fillStyle = gradient;
    //ctx.beginPath();
    //noDrawRanges.forEach(([start, end]) => {
    //  ctx.moveTo(start, minYPosition);
    //  ctx.lineTo(end, minYPosition);
    //  ctx.lineTo(end, -minYPosition);
    //  ctx.lineTo(start, -minYPosition);
    //});
    //ctx.fill();

    // Draw non-2-state values
    ctx.beginPath();
    xzPoints.forEach(set => {
      ctx.moveTo(set[0][0], set[0][1]);
      ctx.lineTo(set[1][0], set[1][1]);
      ctx.lineTo(set[2][0], set[2][1]);
      ctx.lineTo(set[3][0], set[3][1]);
      ctx.lineTo(set[0][0], set[0][1]);
    });

    if (fillShape) {
      ctx.fillStyle = xzColor;
      ctx.fill();
      ctx.restore();
    } else {
      outlineBusValue(ctx, xzColor, viewportSpecs, canvasHeight);
    }

    // Draw Text
    const textY = halfCanvasHeight + 1;
    const fontWeight = fillShape ? 'bold ' : '';
    ctx.save();
    ctx.translate(0.5, 0);
    
    ctx.font = fontWeight + viewportSpecs.fontStyle;
    ctx.fillStyle = fillShape ? viewportSpecs.backgroundColor : viewportSpecs.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    textElements.forEach(([text, xValue, center], i) => {
      if (center) {
        ctx.fillText(text, xValue, textY)
        if (i === netlistData.valueLinkIndex) {ctx.fillText("_".repeat(text.length), xValue, textY);}
      };
    });
    ctx.textAlign = justifyDirection;
    textElements.forEach(([text, xValue, center], i) => {
      if (!center) {
        ctx.fillText(text, xValue, textY);
        if (i === netlistData.valueLinkIndex) {ctx.fillText("_".repeat(text.length), xValue, textY);}
      }
    });

    // Render Signal Link Underline
    netlistData.valueLinkBounds = [];
    if (netlistData.valueLinkCommand !== "") {
      const leftOffset = justifyDirection === "left" ? 0 : 1;
      const rightOffset = justifyDirection === "left" ? -1 : 0;
      textElements.forEach(([text, xValue, center]) => {
        const x = (xValue * viewportSpecs.zoomRatio) - viewportSpecs.pseudoScrollLeft;
        const textWidth = text.length * viewportSpecs.characterWidth;
        if (!center) {
          netlistData.valueLinkBounds.push([x + (leftOffset * textWidth), x + (rightOffset * textWidth)]);
        } else {
          const centerOffset = textWidth / 2;
          netlistData.valueLinkBounds.push([x - centerOffset, x + centerOffset]);
        }
      });
    }

    ctx.restore();
  },
};

export const binaryWaveformRenderer: WaveformRenderer = {
  id: "binary",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: Viewport) {

    const ctx            = netlistData.ctx;
    if (!ctx) {return;}
    const transitionData = valueChangeChunk.valueChanges;
    const initialState   = valueChangeChunk.initialState;
    const postState      = valueChangeChunk.postState;
    const startIndex     = valueChangeChunk.startIndex;
    const endIndex       = valueChangeChunk.endIndex;

    let initialValue       = initialState[1];
    let initialValue2state = parseInt(initialValue);
    let initialTime        = initialState[0];
    let initialTimeOrStart = Math.max(initialState[0], -10);
    let xzPath: any[]      = [];
    const minDrawWidth     = viewportSpecs.pixelTime / viewportSpecs.pixelRatio;
    const drawColor        = netlistData.color;
    const xzColor          = viewportSpecs.xzColor;
    const viewerWidthTime  = viewportSpecs.viewerWidthTime;
    const timeScrollLeft   = viewportSpecs.timeScrollLeft;
    const timeScrollRight  = viewportSpecs.timeScrollRight - timeScrollLeft;
    const valueIs9State    = netlistData.valueFormat.is9State;
    const rowHeight        = netlistData.rowHeight * WAVE_HEIGHT;
    const canvasHeight     = rowHeight - 8;

    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
    }
    const startScreenX  = -10 * viewportSpecs.pixelTime
    let accumulatedPath = [[startScreenX, 0], [startScreenX, initialValue2state]];
    let value2state     = 0;
    // No Draw Code
    let lastDrawTime    = 0;
    let lastNoDrawTime: any = null;
    let noDrawFlag      = false;
    let noDrawPath: any[] = [];
    let lastDrawValue   = initialValue2state;
    let lastNoDrawValue: any = null;

    for (let i = startIndex; i < endIndex; i++) {
      const time  = transitionData[i][0];
      const value = transitionData[i][1];

      if (time - initialTime < minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
        lastNoDrawValue = value;
      } else {

        if (noDrawFlag) {
          initialValue2state = parseInt(initialValue);
          if (valueIs9State(initialValue)) {initialValue2state = 0;}

          const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
          const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
          noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime, 0]);
          accumulatedPath.push([adjustedLastDrawTime, 0]);
          accumulatedPath.push([adjustedLastNoDrawTime, 0]);
          accumulatedPath.push([adjustedLastNoDrawTime, initialValue2state]);
          noDrawFlag = false;
        }

        const timeLeft = time - timeScrollLeft;
        if (valueIs9State(initialValue)) {
          xzPath.push([initialTimeOrStart - timeScrollLeft, timeLeft]);
        }

        value2state = parseInt(value);
        if (valueIs9State(value)) {value2state =  0;}

        // Draw the current transition to the main path
        accumulatedPath.push([timeLeft, initialValue2state]);
        accumulatedPath.push([timeLeft, value2state]);

        lastDrawValue      = value2state;
        lastDrawTime       = time;
        initialValue2state = value2state;
      }

      initialValue       = value;
      initialTimeOrStart = time;
      initialTime        = time;
    }

    initialValue2state = parseInt(initialValue);
    if (valueIs9State(initialValue)) {initialValue2state = 0;}

    if (postState[0] - initialTime < minDrawWidth) {

        const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
        noDrawPath.push([adjustedLastDrawTime, timeScrollRight, 1]);
        accumulatedPath.push([adjustedLastDrawTime, 0]);
        accumulatedPath.push([timeScrollRight, 0]);

    } else {

      if (noDrawFlag) {

        const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
        const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
        noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime, 2]);
        accumulatedPath.push([adjustedLastDrawTime, 0]);
        accumulatedPath.push([adjustedLastNoDrawTime, 0]);
        accumulatedPath.push([adjustedLastNoDrawTime, initialValue2state]);
      }

      if (valueIs9State(initialValue))  {

        if (initialTimeOrStart >= 0) {
          xzPath.push([initialTimeOrStart - timeScrollLeft, timeScrollRight]);
        } else {
          xzPath.push([initialTimeOrStart - timeScrollLeft, timeScrollRight]);
        }
      }
    }

    // Guarantee a 1 -> 0 transition offscreen, otherwise we get rendering artifacts
    accumulatedPath.push([timeScrollRight + (15 * viewportSpecs.pixelTime), initialValue2state]);
    accumulatedPath.push([timeScrollRight + (15 * viewportSpecs.pixelTime), 1]);
    accumulatedPath.push([timeScrollRight + (15 * viewportSpecs.pixelTime), 0]);

    const waveHeight = canvasHeight - 4;
    const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;

    ctx.clearRect(0, 0, viewportSpecs.viewerWidth, canvasHeight);
    ctx.save();
    ctx.strokeStyle = drawColor;
    ctx.fillStyle   = drawColor;
    //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, -waveHeight, 0, 0);
    ctx.beginPath();
    accumulatedPath.forEach(([x, y]) => {ctx.lineTo(x, y);});
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = drawColor;
    ctx.stroke();

    // NoDraw Elements
    ctx.save();
    //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, -waveHeight, 0, 0);
    ctx.beginPath();
    noDrawPath.forEach(([startTime, endTime]) => {
      ctx.moveTo(startTime, 0);
      ctx.lineTo(endTime, 0);
      ctx.lineTo(endTime, 1);
      ctx.lineTo(startTime, 1);
      ctx.lineTo(startTime, 0);
    });
    ctx.restore();
    ctx.strokeStyle = drawColor;
    ctx.fillStyle = drawColor;
    ctx.lineWidth = 1;
    ctx.fill();
    ctx.stroke();

    // Non-2-state values
    ctx.save();
    //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewportSpecs.zoomRatio, 0, 0, -waveHeight, 0, 0);
    ctx.beginPath();
    xzPath.forEach(([startTime, EndTime]) => {
      ctx.moveTo(startTime, 0);
      ctx.lineTo(EndTime, 0);
      ctx.lineTo(EndTime, 1);
      ctx.lineTo(startTime, 1);
      ctx.lineTo(startTime, 0);
    });
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = xzColor;
    ctx.stroke();
  }
};

function createSvgWaveform(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: any, stepped: boolean, evalCoordinates: (v: string) => number) {

  const ctx            = netlistData.ctx;
  if (!ctx) {return;}

  const transitionData   = valueChangeChunk.valueChanges;
  const initialState     = valueChangeChunk.initialState;
  const postState        = valueChangeChunk.postState;
  const startIndex     = valueChangeChunk.startIndex;
  const endIndex       = valueChangeChunk.endIndex;
  const min              = valueChangeChunk.min;
  const max              = valueChangeChunk.max;
  let initialValue       = initialState[1];
  let initialValue2state = initialValue;
  let initialTime        = initialState[0];
  let initialTimeOrStart = Math.max(initialState[0], -10);
  const minDrawWidth  = viewportSpecs.pixelTime / (viewportSpecs.pixelRatio * 4);
  const timeScrollLeft   = viewportSpecs.timeScrollLeft;
  const timeScrollRight  = viewportSpecs.timeScrollRight - timeScrollLeft;
  let xzPath: any[]      = [];
  const valueIs9State    = netlistData.valueFormat.is9State;

  const rowHeight      = netlistData.rowHeight * WAVE_HEIGHT;
  const canvasHeight   = rowHeight - 8;
  const verticalScale  = netlistData.verticalScale;
  const halfCanvasHeight = canvasHeight / 2;

  if (valueIs9State(initialValue)) {
    initialValue2state = "0";
  }

  let accumulatedPath: any[] = [[-10 * viewportSpecs.pixelTime, 0]];
  accumulatedPath.push([initialTime - timeScrollLeft, evalCoordinates(initialValue2state)]);

  let value2state    = "0";
  // No Draw Code
  let lastDrawTime   = 0;
  let lastNoDrawTime: any = null;
  let noDrawFlag     = false;
  let noDrawPath: any[]     = [];
  let lastDrawValue  = initialValue2state;
  let lastNoDrawValue: any = null;

  for (let i = startIndex; i < endIndex; i++) {
    const time  = transitionData[i][0];
    const value = transitionData[i][1];

    if (time - initialTime < minDrawWidth) {
      noDrawFlag     = true;
      lastNoDrawTime = time;
      lastNoDrawValue = value;
    } else {

      if (noDrawFlag) {
        initialValue2state = initialValue;
        if (valueIs9State(initialValue)) {initialValue2state = 0;}

        const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
        const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
        noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime]);
        accumulatedPath.push([adjustedLastDrawTime, 0]);
        accumulatedPath.push([adjustedLastNoDrawTime, 0]);
        accumulatedPath.push([adjustedLastNoDrawTime, evalCoordinates(initialValue2state)]);
        noDrawFlag = false;
      }

      const timeLeft = time - timeScrollLeft;
      if (valueIs9State(initialValue)) {
        xzPath.push([initialTimeOrStart - timeScrollLeft, time]);
      }

      value2state = value;
      if (valueIs9State(value)) {value2state =  "0";}

      // Draw the current transition to the main path
      if (stepped) {
        accumulatedPath.push([timeLeft, evalCoordinates(initialValue2state)]);
      }
      accumulatedPath.push([timeLeft, evalCoordinates(value2state)]);

      lastDrawValue      = value2state;
      lastDrawTime       = time;
      initialValue2state = value2state;
    }
    initialValue       = value;
    initialTimeOrStart = time;
    initialTime        = time;
  }

  initialValue2state = initialValue;
  if (valueIs9State(initialValue)) {initialValue2state = '0';}

  if (postState[0] - initialTime < minDrawWidth) {
    const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
    noDrawPath.push([adjustedLastDrawTime, timeScrollRight]);
    accumulatedPath.push([adjustedLastDrawTime, 0]);
    accumulatedPath.push([timeScrollRight, 0]);
  } else {

    if (noDrawFlag) {
      const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
      const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
      noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime]);
      accumulatedPath.push([adjustedLastDrawTime, 0]);
      accumulatedPath.push([adjustedLastNoDrawTime, 0]);
      accumulatedPath.push([adjustedLastNoDrawTime, evalCoordinates(initialValue2state)]);
    }

    if (valueIs9State(initialValue))  {
      xzPath.push([initialTimeOrStart - timeScrollLeft, timeScrollRight]);
    }
  }

  if (stepped) {
    accumulatedPath.push([timeScrollRight + (15 * viewportSpecs.pixelTime), evalCoordinates(initialValue2state)]);
  } else {
    accumulatedPath.push([postState[0] - timeScrollLeft, evalCoordinates(postState[1])]);
  }

  accumulatedPath.push([postState[0], 0]);

  const drawColor  = netlistData.color;
  const xzColor    = viewportSpecs.xzColor;
  const waveHeight = canvasHeight - 4;
  const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;
  const yScale     = waveHeight * verticalScale / (max - min);
  const translateY = 0.5 + (max / (max - min)) * waveOffset;

  ctx.clearRect(0, 0, viewportSpecs.viewerWidth, canvasHeight);
  ctx.save();
  ctx.strokeStyle = drawColor;
  ctx.fillStyle   = drawColor;
  //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewportSpecs.zoomRatio, 0, 0, -yScale, 0, 0);
  ctx.beginPath();
  accumulatedPath.forEach(([x, y]) => {ctx.lineTo(x, y);});
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = drawColor;
  ctx.stroke();

  // NoDraw Elements
  ctx.save();
  //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewportSpecs.zoomRatio, 0, 0, -yScale, 0, 0);
  ctx.beginPath();
  noDrawPath.forEach(([startTime, endTime]) => {
    ctx.moveTo(startTime, min);
    ctx.lineTo(endTime, min);
    ctx.lineTo(endTime, max);
    ctx.lineTo(startTime, max);
    ctx.lineTo(startTime, min);
  });
  ctx.restore();
  ctx.strokeStyle = drawColor;
  ctx.fillStyle = drawColor;
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();

  // Non-2-state values
  ctx.save();
  //ctx.translate(0.5 - viewportSpecs.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewportSpecs.zoomRatio, 0, 0, -yScale, 0, 0);
  ctx.beginPath();
  xzPath.forEach(([startTime, EndTime]) => {
    ctx.moveTo(startTime, min);
    ctx.lineTo(EndTime, min);
    ctx.lineTo(EndTime, max);
    ctx.lineTo(startTime, max);
    ctx.lineTo(startTime, min);
  });
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.strokeStyle = xzColor;
  ctx.stroke();
}

const evalBinary16plusSigned = (v: string) => {
  const n = parseInt(v.slice(0,16), 2) || 0;
  return n > 32767 ? n - 65536 : n;
};
const evalBinarySigned = (v: string) => {
  const n = parseInt(v, 2) || 0;
  return v[0] === '1' ? n - (2 ** v.length) : n;
};
const evalBinary16plus = (v: string) => {return parseInt(v.slice(0,16), 2) || 0;};
const evalBinary = (v: string) => {return parseInt(v, 2) || 0;};
const evalReal = (v: string) => {return parseFloat(v) || 0;};

function getEval(type: string, width: number, signed: boolean) {
  if (type === "Real") {return evalReal;}

  if (width > 16) {
    if (signed) {return evalBinary16plusSigned;}
    else {       return evalBinary16plus;}
  } else {
    if (signed) {return evalBinarySigned;}
    else {       return evalBinary;}
  }
}

export const linearWaveformRenderer: WaveformRenderer = {
  id: "linear",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, false, evalCoordinates);
  }
};

export const signedLinearWaveformRenderer: WaveformRenderer = {
  id: "linearSigned",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, true);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, false, evalCoordinates);
  }
};

export const steppedWaveformRenderer: WaveformRenderer = {
  id: "stepped",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, true, evalCoordinates);
  }
};

export const signedSteppedWaveformRenderer: WaveformRenderer = {
  id: "steppedSigned",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: any) {
    const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, true);
    return createSvgWaveform(valueChangeChunk, netlistData, viewportSpecs, true, evalCoordinates);
  }
};