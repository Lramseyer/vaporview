//import { NetlistData } from './vaporview';
import { NetlistVariable, type CustomVariable } from './signal_item';
import { dataManager, viewport, styles } from './vaporview';
import type { WaveformData } from './data_manager';

export interface WaveformRenderer {
  id: string;
  draw(valueChangeChunk: any, netlistData: NetlistVariable | CustomVariable): void;
}

export function setRenderBounds(netlistData: NetlistVariable | CustomVariable, waveformData: WaveformData) {

  // find the closest timestamp to timeScrollLeft
  const valueChanges = waveformData.valueChangeData;
  const startIndex   = Math.max(dataManager.binarySearch(valueChanges, viewport.timeScrollLeft - (2 * viewport.pixelTime)), 1);
  const endIndex     = dataManager.binarySearch(valueChanges, viewport.timeScrollRight);
  const initialState = valueChanges[startIndex - 1];
  let   postState    = valueChanges[endIndex];

  if (endIndex >= valueChanges.length) {
    postState = [viewport.timeStop, ''];
  }

  const renderBounds = {
    valueChanges: valueChanges,
    formattedValues: [] as string[],
    formatCached: false,
    startIndex: startIndex,
    endIndex: endIndex,
    initialState: initialState,
    postState: postState,
  };

  if (waveformData.formattedValues[netlistData.valueFormat.id] !== undefined) {
    const formatInfo = waveformData.formattedValues[netlistData.valueFormat.id];
    if (formatInfo.formatCached) {
      renderBounds.formatCached = true;
      renderBounds.formattedValues = formatInfo.values;
    }
  } else if (waveformData.signalWidth > 1) {
    if (netlistData instanceof NetlistVariable) {
      console.log(`No cached format found for signalId ${netlistData.signalId} with format ${netlistData.valueFormat.id}`);
    } else {
      console.log(`No cached format found for customSignalId ${netlistData.customSignalId} with format ${netlistData.valueFormat.id}`);
    }
  }

  return renderBounds;
}

export class MultiBitWaveformRenderer implements WaveformRenderer {

  public id: string = "multiBit";
  constructor() {}

  // This function actually creates the individual bus elements, and has can
  // potentially called thousands of times during a render
  private busValue(time: number, deltaTime: number, displayValue: string, justifyDirection: boolean) {
    const textTime            = displayValue.length * styles.characterWidth * viewport.pixelTime;
    const padding             = 4 * viewport.pixelTime;
    const adjustedTime        = Math.max(time, viewport.timeScrollLeft);
    const adjustedDeltaTime   = Math.min(time + deltaTime, viewport.timeScrollRight) - adjustedTime;
    const characterWidthLimit = adjustedDeltaTime - (2 * padding);
    const centerText          = (textTime <= characterWidthLimit);
    let text                  = displayValue;
    let xValue;

    if (centerText) {
      xValue = adjustedTime + (adjustedDeltaTime / 2);
    } else {
      const charCount = Math.floor(characterWidthLimit / (styles.characterWidth * viewport.pixelTime)) - 1;
      if (charCount < 0) {return ["", -100];}
      if (justifyDirection) {
        xValue = adjustedTime + adjustedDeltaTime - padding;
        text = '…' + displayValue.slice(displayValue.length - charCount);
      } else {
        xValue = adjustedTime + padding;
        text = displayValue.slice(0, charCount) + '…';
      }
    }

    const adjustedXValue = (xValue * viewport.zoomRatio) - viewport.pseudoScrollLeft;
    return [text, adjustedXValue, centerText];
  }

  private outlineBusValue(ctx: CanvasRenderingContext2D, drawColor: string, canvasHeight: number) {
    ctx.restore();
    ctx.save();
    ctx.clip();
    ctx.clearRect(0, 0, viewport.viewerWidth, canvasHeight);
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
    ctx.lineTo(viewport.viewerWidth, 0.5);
    ctx.moveTo(0, canvasHeight - 0.5);
    ctx.lineTo(viewport.viewerWidth, canvasHeight - 0.5);
    ctx.stroke();
    ctx.restore();
    ctx.save();
  }

  private busValueNoDraw(ctx: CanvasRenderingContext2D, alpha: number, lineWidth: number, viewerWidth: number) {
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(viewerWidth, 0);
    ctx.stroke();
  }

  public draw(valueChangeChunk: any, netlistData: NetlistVariable | CustomVariable) {
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
    const rowHeight      = netlistData.rowHeight * styles.rowHeight;
    const canvasHeight   = rowHeight - 8;
    const halfCanvasHeight = canvasHeight / 2;

    let elementWidth;
    let is4State        = false;
    let value           = initialState[1];
    let time            = initialState[0];
    let xPosition       = 0;
    let yPosition       = 0;
    const adjustedTime  = time - viewport.timeScrollLeft;
    const points        = [[adjustedTime, 0]];
    const endPoints     = [[adjustedTime, 0]];
    const xzPoints: any[] = [];
    //const xzValues: string[] = [];
    const textElements: any[] = [];
    let moveCursor      = false;
    let drawBackgroundStrokes = false;
    const minTextWidth  = 12 * viewport.pixelTime;
    const minDrawWidth  = viewport.pixelTime / viewport.pixelRatio;
    const drawColor     = netlistData.color;
    const xzColor       = styles.xzColor;
    const fillShape     = styles.fillMultiBitValues;
    //const minYPosition  = halfCanvasHeight / viewport.zoomRatio;
    let lastDrawTime    = 0;
    let parsedValue;
    //const noDrawRanges: any[] = [];

    for (let i = startIndex; i < endIndex; i++) {

      elementWidth = transitionData[i][0] - time;

      // If the element is too small to draw, we need to skip it
      if (elementWidth > minDrawWidth) {

        const adjustedTime = time - viewport.timeScrollLeft;
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
          //spansChunk = spansChunk || (transitionData[i][0] > viewport.timeScrollRight);
          textElements.push(this.busValue(time, elementWidth, parsedValue, rightJustify));
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

      const adjustedTime = time - viewport.timeScrollLeft;
      const adjustedTimeEnd = postState[0] + - viewport.timeScrollLeft;

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
      textElements.push(this.busValue(time, elementWidth, parsedValue, rightJustify));
    }

    ctx.clearRect(0, 0, viewport.viewerWidth * viewport.pixelRatio, canvasHeight * viewport.pixelRatio);
    ctx.save();
    ctx.translate(0, halfCanvasHeight);

    // No Draw Line
    ctx.strokeStyle = drawColor;
    if (fillShape) {
      this.busValueNoDraw(ctx, 0.4, 3, viewport.viewerWidth);
      this.busValueNoDraw(ctx, 0.8, 1, viewport.viewerWidth);
    } else {
      this.busValueNoDraw(ctx, 0.5, 6, viewport.viewerWidth);
      this.busValueNoDraw(ctx, 1, 5, viewport.viewerWidth);
    }
    ctx.moveTo(0, 0);

    // Draw diamonds
    ctx.restore();
    ctx.save();
    ctx.translate(0.5, halfCanvasHeight);
    ctx.globalAlpha = 1;
    ctx.transform(viewport.zoomRatio, 0, 0, viewport.zoomRatio, 0, 0);
    ctx.beginPath();
    ctx.moveTo(-viewport.pixelTime * 2, 0); // This seems to fix a Windows render glitch, but cause another one
    points.forEach(([x, y]) => {ctx.lineTo(x, y);});
    endPoints.reverse().forEach(([x, y]) => {ctx.lineTo(x, y);});

    if (fillShape) {
      ctx.fillStyle = drawColor;
      ctx.fill();
    } else {
      this.outlineBusValue(ctx, drawColor, canvasHeight);
      ctx.translate(0.5, halfCanvasHeight);
      ctx.transform(viewport.zoomRatio, 0, 0, viewport.zoomRatio, 0, 0);
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
      this.outlineBusValue(ctx, xzColor, canvasHeight);
    }

    // Draw Text
    const textY = halfCanvasHeight + 1;
    const fontWeight = fillShape ? 'bold ' : '';
    ctx.save();
    ctx.translate(0.5, 0);
    
    ctx.font = fontWeight + styles.fontStyle;
    ctx.fillStyle = fillShape ? styles.backgroundColor : styles.textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    textElements.forEach(([text, xValue, center], i) => {
      if (center) {
        ctx.fillText(text, xValue, textY);
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
        const x = (xValue * viewport.zoomRatio) - viewport.pseudoScrollLeft;
        const textWidth = text.length * styles.characterWidth;
        if (!center) {
          netlistData.valueLinkBounds.push([x + (leftOffset * textWidth), x + (rightOffset * textWidth)]);
        } else {
          const centerOffset = textWidth / 2;
          netlistData.valueLinkBounds.push([x - centerOffset, x + centerOffset]);
        }
      });
    }

    ctx.restore();
  }
};

export class BinaryWaveformRenderer implements WaveformRenderer {
  public id: string = "binary";
  constructor() {}

  public draw(valueChangeChunk: any, netlistData: NetlistVariable | CustomVariable) {

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
    const xzPath: any[]    = [];
    const minDrawWidth     = viewport.pixelTime / viewport.pixelRatio;
    const drawColor        = netlistData.color;
    const xzColor          = styles.xzColor;
    const viewerWidthTime  = viewport.viewerWidthTime;
    const timeScrollLeft   = viewport.timeScrollLeft;
    const timeScrollRight  = viewport.timeScrollRight - timeScrollLeft;
    const valueIs9State    = netlistData.valueFormat.is9State;
    const rowHeight        = netlistData.rowHeight * styles.rowHeight;
    const canvasHeight     = rowHeight - 8;

    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
    }
    const startScreenX  = -10 * viewport.pixelTime
    const accumulatedPath = [[startScreenX, 0], [startScreenX, initialValue2state]];
    let value2state     = 0;
    // No Draw Code
    let lastDrawTime    = 0;
    let lastNoDrawTime: any = null;
    let noDrawFlag      = false;
    const noDrawPath: any[] = [];
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
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), initialValue2state]);
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), 1]);
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), 0]);

    const waveHeight = canvasHeight - 4;
    const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;

    ctx.clearRect(0, 0, viewport.viewerWidth, canvasHeight);
    ctx.save();
    ctx.strokeStyle = drawColor;
    ctx.fillStyle   = drawColor;
    //ctx.translate(0.5 - viewport.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewport.zoomRatio, 0, 0, -waveHeight, 0, 0);
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
    //ctx.translate(0.5 - viewport.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewport.zoomRatio, 0, 0, -waveHeight, 0, 0);
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
    //ctx.translate(0.5 - viewport.pseudoScrollLeft, waveOffset + 0.5);
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewport.zoomRatio, 0, 0, -waveHeight, 0, 0);
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
}

function createAnalogWaveform(valueChangeChunk: any, netlistData: NetlistVariable | CustomVariable, stepped: boolean, evalCoordinates: (v: string) => number) {

  const ctx              = netlistData.ctx;
  if (!ctx) {return;}
  const transitionData   = valueChangeChunk.valueChanges;
  const initialState     = valueChangeChunk.initialState;
  const postState        = valueChangeChunk.postState;
  const startIndex       = valueChangeChunk.startIndex;
  const endIndex         = valueChangeChunk.endIndex;
  const min              = netlistData.min;
  const max              = netlistData.max;
  let initialValue       = initialState[1];
  let initialValue2state = initialValue;
  let initialTime        = initialState[0];
  let initialTimeOrStart = Math.max(initialState[0], -10);
  const minDrawWidth     = viewport.pixelTime / (viewport.pixelRatio * 4);
  const timeScrollLeft   = viewport.timeScrollLeft;
  const timeScrollRight  = viewport.timeScrollRight - timeScrollLeft;
  const xzPath: any[]    = [];
  const valueIs9State    = netlistData.valueFormat.is9State;
  const rowHeight        = netlistData.rowHeight * styles.rowHeight;
  const canvasHeight     = rowHeight - 8;
  const verticalScale    = netlistData.verticalScale;
  const halfCanvasHeight = canvasHeight / 2;

  if (valueIs9State(initialValue)) {
    initialValue2state = "0";
  }

  const accumulatedPath: any[] = [[-10 * viewport.pixelTime, 0]];
  accumulatedPath.push([initialTime - timeScrollLeft, evalCoordinates(initialValue2state)]);

  let value2state    = "0";
  // No Draw Code
  let lastDrawTime        = 0;
  let lastNoDrawTime: any = null;
  let noDrawFlag          = false;
  const noDrawPath: any[] = [];
  let lastDrawValue       = initialValue2state;
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
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), evalCoordinates(initialValue2state)]);
  } else {
    accumulatedPath.push([postState[0] - timeScrollLeft, evalCoordinates(postState[1])]);
  }

  accumulatedPath.push([postState[0], 0]);

  console.log(accumulatedPath);

  const drawColor  = netlistData.color;
  const xzColor    = styles.xzColor;
  const waveHeight = canvasHeight - 4;
  const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;
  const yScale     = waveHeight * verticalScale / (max - min);
  const translateY = 0.5 + (max / (max - min)) * waveOffset;

  ctx.clearRect(0, 0, viewport.viewerWidth, canvasHeight);
  ctx.save();
  ctx.strokeStyle = drawColor;
  ctx.fillStyle   = drawColor;
  //ctx.translate(0.5 - viewport.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewport.zoomRatio, 0, 0, -yScale, 0, 0);
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
  //ctx.translate(0.5 - viewport.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewport.zoomRatio, 0, 0, -yScale, 0, 0);
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
  //ctx.translate(0.5 - viewport.pseudoScrollLeft, translateY + 0.5);
  ctx.translate(0.5, translateY + 0.5);
  ctx.transform(viewport.zoomRatio, 0, 0, -yScale, 0, 0);
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

export class LinearWaveformRenderer implements WaveformRenderer {
  public id: string = "multiBit";
  private evalCoordinates: (v: string) => number;
  constructor(
    id: string,
    encoding: string,
    width: number,
    signed: boolean,
    private readonly stepped: boolean
  ) {
    this.id = id;
    this.evalCoordinates = this.setEvalCoordinates(encoding, width, signed);
  }

  private setEvalCoordinates(encoding: string, width: number, signed: boolean) {

    if (encoding === "Real") {
      return evalReal;
    }

    if (width > 16) {
      if (signed) {return evalBinary16plusSigned;}
      else {       return evalBinary16plus;}
    } else {
      if (signed) {return evalBinarySigned;}
      else {       return evalBinary;}
    }
  }

  draw(valueChangeChunk: any, netlistData: NetlistVariable | CustomVariable) {
    //const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createAnalogWaveform(valueChangeChunk, netlistData, this.stepped, this.evalCoordinates);
  }
};
