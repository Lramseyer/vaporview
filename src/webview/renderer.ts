import type { ValueChange } from '../common/types';
import { NetlistVariable, type CustomVariable } from './signal_item';
import { dataManager, viewport, styles, config } from './vaporview';
import type { WaveformData } from './data_manager';

export interface RenderBounds {
  valueChanges: ValueChange[];
  formattedValues: string[];
  formatCached: boolean;
  startIndex: number;
  endIndex: number;
  initialState: ValueChange;
  postState: ValueChange;
}

export interface WaveformRenderer {
  id: string;
  draw(valueChangeChunk: RenderBounds, netlistData: NetlistVariable | CustomVariable): void;
}

type Coordinate = [number, number];
type MultiBitShape = Coordinate[];

function clipCanvas(ctx: CanvasRenderingContext2D, signalItem: NetlistVariable | CustomVariable, canvasHeight: number,  viewerWidth: number) {
  const topBounds    = signalItem.topBounds;
  if (topBounds === null) {return;}
  const windowTop    = topBounds + styles.rowPadding - viewport.pseudoScrollTop;

  ctx.rect(0, windowTop, viewerWidth, canvasHeight);
  ctx.clip();
  ctx.translate(0, windowTop);
  ctx.clearRect(0, 0, viewerWidth, canvasHeight);
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
      // console.log(`No cached format found for signalId ${netlistData.signalId} with format ${netlistData.valueFormat.id}`);
    } else {
      // console.log(`No cached format found for customSignalId ${netlistData.customSignalId} with format ${netlistData.valueFormat.id}`);
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
      if (charCount < 0) {return ["", -100, false] as [string, number, boolean];}
      if (justifyDirection) {
        xValue = adjustedTime + adjustedDeltaTime - padding;
        text = '…' + displayValue.slice(displayValue.length - charCount);
      } else {
        xValue = adjustedTime + padding;
        text = displayValue.slice(0, charCount) + '…';
      }
    }

    const adjustedXValue = (xValue * viewport.zoomRatio) - viewport.pseudoScrollLeft;
    return [text, adjustedXValue, centerText] as [string, number, boolean];
  }

  private createShape(left: number, right: number, width: number, cornerOffset: number, yMultiplier: number, maxYposition: number, fixedHeight: boolean): MultiBitShape {
    const xPosition   = (width / 2) + left;
    const yPosition   = fixedHeight ? maxYposition : Math.min(width * yMultiplier, maxYposition);
    const cornerLeft  = Math.min(left + cornerOffset, xPosition);
    const cornerRight = Math.max(right - cornerOffset, xPosition);
    return [[left, 0], [cornerLeft, yPosition], [cornerRight, yPosition], [right, 0], [cornerRight, -yPosition], [cornerLeft, -yPosition]];
  }

  private drawShape(ctx: CanvasRenderingContext2D, shape: MultiBitShape) {
    ctx.moveTo(shape[0][0], shape[0][1]);
    ctx.lineTo(shape[1][0], shape[1][1]);
    ctx.lineTo(shape[2][0], shape[2][1]);
    ctx.lineTo(shape[3][0], shape[3][1]);
    ctx.lineTo(shape[4][0], shape[4][1]);
    ctx.lineTo(shape[5][0], shape[5][1]);
    ctx.lineTo(shape[0][0], shape[0][1]);
  }

  public draw(valueChangeChunk: RenderBounds, netlistData: NetlistVariable | CustomVariable) {
    const ctx            = viewport.waveformsCanvas;
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
    const canvasHeight   = rowHeight - (styles.rowPadding * 2);
    const halfCanvasHeight = canvasHeight / 2;

    let elementWidth;
    let is4State        = false;
    let value           = initialState[1];
    let time            = initialState[0];

    const binShapes: MultiBitShape[] = [];
    const xzShapes: MultiBitShape[]  = [];
    const textElements: [string, number, boolean][] = [];
    let moveCursor      = false;
    const minTextWidth  = 12 * viewport.pixelTime;
    const minDrawWidth  = viewport.pixelTime / viewport.pixelRatio;
    const drawColor     = netlistData.color;
    const xzColor       = styles.xzColor;
    const fillShape     = config.fillMultiBitValues;
    const fixedHeight   = config.multiBitFixedHeight;
    const maxYPosition  = (halfCanvasHeight - 0.5) / viewport.zoomRatio;
    const yMultiplier   = 2 * netlistData.rowHeight;
    const cornerOffset  = ((halfCanvasHeight - 0.5) / (2 * yMultiplier)) / viewport.zoomRatio;
    let lastDrawTime    = 0;
    let parsedValue;
    const noDrawRanges: number[][] = [];

    for (let i = startIndex; i < endIndex; i++) {

      elementWidth = transitionData[i][0] - time;

      // If the element is too small to draw, we need to skip it
      if (elementWidth > minDrawWidth) {

        const adjustedTime = time - viewport.timeScrollLeft;
        const adjustedTimeEnd = adjustedTime + elementWidth;

        if (moveCursor) {
          moveCursor = false;
          noDrawRanges.push([lastDrawTime, adjustedTime]);
        }

        is4State  = valueIs9State(value);
        const shape = this.createShape(adjustedTime, adjustedTimeEnd, elementWidth, cornerOffset, yMultiplier, maxYPosition, fixedHeight);
        if (is4State) {
          xzShapes.push(shape);
        } else {
          binShapes.push(shape);
        }

        // Don't even bother rendering text if the element is too small. Since 
        // there's an upper limit to the number of larger elements that will be 
        // displayed, we can spend a little more time rendering them and making them
        // readable in all cases.
        if (elementWidth > minTextWidth) {
          if (formatCached) {
            parsedValue = formattedValues[i - 1];
          } else {
            parsedValue = parseValue(value, signalWidth, !is4State);
          }
          textElements.push(this.busValue(time, elementWidth, parsedValue, rightJustify));
        }

        lastDrawTime = adjustedTimeEnd;
      } else {
        moveCursor = true;
      }

      time  = transitionData[i][0];
      value = transitionData[i][1];
    }

    elementWidth = postState[0] - time;

    if (elementWidth > minDrawWidth) {

      const adjustedTime = time - viewport.timeScrollLeft;
      const adjustedTimeEnd = postState[0] - viewport.timeScrollLeft;

      if (moveCursor) {
        moveCursor = false;
        noDrawRanges.push([lastDrawTime, adjustedTime]);
      }

      is4State  = valueIs9State(value);
      const shape = this.createShape(adjustedTime, adjustedTimeEnd, elementWidth, cornerOffset, yMultiplier, maxYPosition, fixedHeight);
      if (is4State) {
        xzShapes.push(shape);
      } else {
        binShapes.push(shape);
      }
    } else {
      if (moveCursor) {
        const adjustedTimeEnd = viewport.timeScrollRight - viewport.timeScrollLeft;
        noDrawRanges.push([lastDrawTime, adjustedTimeEnd]);
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

    ctx.save();
    clipCanvas(ctx, netlistData, canvasHeight, viewport.viewerWidth);
    ctx.save();

    // Draw diamonds - both binary and 9 state
    for (const i in [0,1]) {
      const shapes = [binShapes, xzShapes][i];
      const color  = [drawColor, xzColor][i];

      ctx.translate(0.5, halfCanvasHeight);
      ctx.transform(viewport.zoomRatio, 0, 0, viewport.zoomRatio, 0, 0);

      ctx.beginPath();
      ctx.moveTo(-viewport.pixelTime * 2, 0); // This seems to fix a Windows render glitch, but cause another one
      shapes.forEach(s => this.drawShape(ctx, s));

      ctx.globalAlpha = fillShape ? 1 : 0.1;
      ctx.fillStyle   = color;
      ctx.shadowColor = color;
      ctx.shadowBlur  = styles.glowBlur;
      ctx.fill();
      ctx.restore();
      ctx.save();
      if (fixedHeight || !fillShape) {
        ctx.lineWidth   = 1;
        ctx.strokeStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur  = styles.glowBlur;
        ctx.stroke();
      }

      ctx.restore();
      ctx.save();
    }

    ctx.translate(0.5, halfCanvasHeight);
    ctx.transform(viewport.zoomRatio, 0, 0, viewport.zoomRatio, 0, 0);

    // for fixed height, we draw boxes,
    ctx.fillStyle   = drawColor;
    ctx.shadowColor = drawColor;
    ctx.shadowBlur  = styles.glowBlur;
    ctx.beginPath();
    if (fixedHeight) {
      noDrawRanges.forEach(([start, end]) => {
        ctx.moveTo(start,  maxYPosition);
        ctx.lineTo(end,    maxYPosition);
        ctx.lineTo(end,   -maxYPosition);
        ctx.lineTo(start, -maxYPosition);
      });
      ctx.fill();
      ctx.restore();
      ctx.save();
    } else {
      noDrawRanges.forEach(([start, end]) => {
        ctx.moveTo(start, 0);
        ctx.lineTo(end,   0);
      });
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = drawColor;
      ctx.globalAlpha = fillShape ? 0.4 : 0.5;
      ctx.lineWidth   = fillShape ? 3   : 6;
      ctx.stroke();
      ctx.globalAlpha = fillShape ? 0.8 : 1;
      ctx.lineWidth   = fillShape ? 1   : 5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(0,0);

    // Draw Text
    const textY = halfCanvasHeight + 1;
    const fontWeight = fillShape ? 'bold ' : '';
    const textColor  = fillShape ? styles.backgroundColor : styles.textColor;
    ctx.restore();
    ctx.save();
    ctx.translate(0.5, 0);

    ctx.font          = fontWeight + styles.fontStyle;
    ctx.fillStyle     = textColor;
    // Glow the bus text in the trace color, but keep the glyphs readable by
    // not blooming the (often dark) filled-shape text color.
    ctx.shadowColor   = fillShape ? drawColor : textColor;
    ctx.shadowBlur    = styles.textGlowBlur;
    ctx.textBaseline  = 'middle';
    ctx.imageSmoothingEnabled = false;
    ctx.textRendering = 'optimizeLegibility';
    textElements.forEach(([text, xValue, center], i) => {
      ctx.textAlign = center ? 'center' : justifyDirection;
      ctx.fillText(text, xValue, textY);
      if (i === netlistData.valueLinkIndex) {ctx.fillText("_".repeat(text.length), xValue, textY);}
    });

    // Render Signal Link Underline
    netlistData.valueLinkBounds = [];
    if (netlistData.valueLinkEnable) {
      const leftOffset  = justifyDirection === "left" ?  0 : 1;
      const rightOffset = justifyDirection === "left" ? -1 : 0;
      textElements.forEach(([text, xValue, center]) => {
        //const x = (xValue * viewport.zoomRatio) - viewport.pseudoScrollLeft;
        const textWidth = text.length * styles.characterWidth;
        if (!center) {
          netlistData.valueLinkBounds.push([xValue + (leftOffset * textWidth), xValue + (rightOffset * textWidth)]);
        } else {
          const centerOffset = textWidth / 2;
          netlistData.valueLinkBounds.push([xValue - centerOffset, xValue + centerOffset]);
        }
      });
    }

    ctx.restore();
    ctx.restore();
    ctx.restore();
    ctx.shadowBlur = 0;
  }
}

export class BinaryWaveformRenderer implements WaveformRenderer {
  public id: string = "binary";
  constructor() {}

  public draw(valueChangeChunk: RenderBounds, netlistData: NetlistVariable | CustomVariable) {

    const ctx            = viewport.waveformsCanvas;
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
    const xzPath: number[][] = [];
    const minDrawWidth     = viewport.pixelTime / viewport.pixelRatio;
    const drawColor        = netlistData.color;
    const xzColor          = styles.xzColor;
    const viewerWidthTime  = viewport.viewerWidthTime;
    const timeScrollLeft   = viewport.timeScrollLeft;
    const timeScrollRight  = viewport.timeScrollRight - timeScrollLeft;
    const valueIs9State    = netlistData.valueFormat.is9State;
    const rowHeight        = netlistData.rowHeight * styles.rowHeight;
    const canvasHeight     = rowHeight - (styles.rowPadding * 2);

    let drawLine           = true;
    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
      drawLine = false;
    }
    const startScreenX    = -10 * viewport.pixelTime;
    const accumulatedPath: [number, number, boolean][] = [[startScreenX, 0, true], [startScreenX, initialValue2state, true]];
    let value2state       = 0;
    // No Draw Code
    let lastDrawTime             = 0;
    let lastNoDrawTime: number   = 0;
    let noDrawFlag               = false;
    const noDrawPath: number[][] = [];
    let lastDrawValue            = initialValue2state;
    //let lastNoDrawValue: string = initialValue;

    for (let i = startIndex; i < endIndex; i++) {
      const time  = transitionData[i][0];
      const value = transitionData[i][1];

      if (time - initialTime < minDrawWidth) {
        noDrawFlag     = true;
        lastNoDrawTime = time;
        //lastNoDrawValue = value;
      } else {

        if (noDrawFlag) {
          initialValue2state = parseInt(initialValue);
          if (valueIs9State(initialValue)) {
            initialValue2state = 0;
            drawLine = false;
          }

          const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
          const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
          noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime, 0]);
          accumulatedPath.push([adjustedLastDrawTime,   0, true]);
          accumulatedPath.push([adjustedLastNoDrawTime, 0, true]);
          accumulatedPath.push([adjustedLastNoDrawTime, initialValue2state, true]);
          noDrawFlag = false;
        }

        const timeLeft = time - timeScrollLeft;
        if (valueIs9State(initialValue)) {
          xzPath.push([initialTimeOrStart - timeScrollLeft, timeLeft]);
          drawLine = false;
        }

        // Draw the current transition to the main path
        accumulatedPath.push([timeLeft, initialValue2state, drawLine]);

        // Check for 9 state, or previous 9 state values
        value2state = parseInt(value);
        if (valueIs9State(value)) {
          value2state = 0;
          accumulatedPath.push([timeLeft, 0.5, drawLine]);
          drawLine = false;
        } else {
          if (!drawLine) {
            accumulatedPath.push([timeLeft, 0.5, drawLine]);
          }
          drawLine = true;
        }

        accumulatedPath.push([timeLeft, value2state, drawLine]);

        lastDrawValue      = value2state;
        lastDrawTime       = time;
        initialValue2state = value2state;
      }

      initialValue       = value;
      initialTimeOrStart = time;
      initialTime        = time;
    }

    initialValue2state = parseInt(initialValue);
    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
      drawLine = false;
    }

    if (postState[0] - initialTime < minDrawWidth) {

        const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
        noDrawPath.push([adjustedLastDrawTime, timeScrollRight, 1]);
        accumulatedPath.push([adjustedLastDrawTime, 0, true]);
        accumulatedPath.push([timeScrollRight, 0, true]);

    } else {

      if (noDrawFlag) {

        const adjustedLastDrawTime = lastDrawTime - timeScrollLeft;
        const adjustedLastNoDrawTime = lastNoDrawTime - timeScrollLeft;
        noDrawPath.push([adjustedLastDrawTime, adjustedLastNoDrawTime, 2]);
        accumulatedPath.push([adjustedLastDrawTime, 0, true]);
        accumulatedPath.push([adjustedLastNoDrawTime, 0, true]);
        accumulatedPath.push([adjustedLastNoDrawTime, initialValue2state, true]);
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
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), initialValue2state, drawLine]);
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), 1, true]);
    accumulatedPath.push([timeScrollRight + (15 * viewport.pixelTime), 0, true]);

    const waveHeight = canvasHeight - styles.rowPadding;
    const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;

    ctx.save();
    clipCanvas(ctx, netlistData, canvasHeight, viewport.viewerWidth);
    ctx.save();
    ctx.strokeStyle = drawColor;
    ctx.fillStyle   = drawColor;
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewport.zoomRatio, 0, 0, -waveHeight, 0, 0);
    ctx.beginPath();
    accumulatedPath.forEach(([x, y, lt]) => {ctx.lineTo(x, y);});
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.beginPath();
    accumulatedPath.forEach(([x, y, lt]) => {
      if (lt) {ctx.lineTo(x, y);}
      else    {ctx.moveTo(x, y);}
    });
    ctx.globalAlpha = 1;
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = drawColor;
    ctx.shadowColor = drawColor;
    ctx.shadowBlur  = styles.glowBlur;
    ctx.stroke();

    // NoDraw Elements
    ctx.save();
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
    ctx.shadowColor = drawColor;
    ctx.shadowBlur  = styles.glowBlur;
    ctx.fill();
    ctx.stroke();

    // Non-2-state values
    ctx.save();
    ctx.translate(0.5, waveOffset + 0.5);
    ctx.transform(viewport.zoomRatio, 0, 0, -waveHeight, 0, 0);
    ctx.beginPath();
    xzPath.forEach(([startTime, EndTime]) => {
      ctx.moveTo(startTime, 0);
      ctx.lineTo(EndTime, 0);
      ctx.lineTo(EndTime, 0.5);
      ctx.lineTo(startTime, 0.5);
      ctx.lineTo(startTime, 0);
    });
    ctx.fillStyle   = xzColor;
    ctx.globalAlpha = 0.1;
    ctx.fill();
    ctx.beginPath();
    xzPath.forEach(([startTime, EndTime]) => {
      ctx.moveTo(startTime, 0.5);
      ctx.lineTo(EndTime, 0.5);
    });
    ctx.restore();
    ctx.lineWidth = 1;
    ctx.strokeStyle = xzColor;
    ctx.shadowColor = xzColor;
    ctx.shadowBlur  = styles.glowBlur;
    ctx.stroke();
    ctx.shadowBlur  = 0;
    ctx.restore();
    // This seems to fix a weird renderer bug where multi-bit lines show up
    ctx.beginPath();
    ctx.moveTo(0,0);
  }
}

function createAnalogWaveform(valueChangeChunk: RenderBounds, netlistData: NetlistVariable | CustomVariable, stepped: boolean, evalCoordinates: (v: string) => number) {

  const ctx              = viewport.waveformsCanvas;
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
  const minFeatureSize   = viewport.pixelTime / (viewport.pixelRatio * 4);
  const minDrawWidth     = config.disableAnalogRendererOptimizations ? 0 : minFeatureSize;
  const timeScrollLeft   = viewport.timeScrollLeft;
  const timeScrollRight  = viewport.timeScrollRight - timeScrollLeft;
  const xzPath: number[][] = [];
  const valueIs9State    = netlistData.valueFormat.is9State;
  const rowHeight        = netlistData.rowHeight * styles.rowHeight;
  const canvasHeight     = rowHeight - (styles.rowPadding * 2);
  const verticalScale    = netlistData.verticalScale;
  const halfCanvasHeight = canvasHeight / 2;

  if (valueIs9State(initialValue)) {
    initialValue2state = "0";
  }

  const accumulatedPath: number[][] = [[-10 * viewport.pixelTime, 0]];
  accumulatedPath.push([initialTime - timeScrollLeft, evalCoordinates(initialValue2state)]);

  let value2state              = "0";
  // No Draw Code
  let lastDrawTime             = 0;
  let lastNoDrawTime: number   = 0;
  let noDrawFlag               = false;
  const noDrawPath: number[][] = [];
  let lastDrawValue            = initialValue2state;
  //let lastNoDrawValue: string = initialValue;

  for (let i = startIndex; i < endIndex; i++) {
    const time  = transitionData[i][0];
    const value = transitionData[i][1];

    if (time - initialTime < minDrawWidth) {
      noDrawFlag     = true;
      lastNoDrawTime = time;
      //lastNoDrawValue = value;
    } else {

      if (noDrawFlag) {
        initialValue2state = initialValue;
        if (valueIs9State(initialValue)) {initialValue2state = "0";}

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
        xzPath.push([initialTimeOrStart - timeScrollLeft, timeLeft]);
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

  const drawColor  = netlistData.color;
  const xzColor    = styles.xzColor;
  const waveHeight = canvasHeight - styles.rowPadding;
  const waveOffset = waveHeight + (canvasHeight - waveHeight) / 2;
  const yScale     = waveHeight * verticalScale / (max - min);
  const translateY = 0.5 + (max / (max - min)) * waveOffset;

  ctx.save();
  clipCanvas(ctx, netlistData, canvasHeight, viewport.viewerWidth);
  ctx.save();
  ctx.strokeStyle = drawColor;
  ctx.fillStyle   = drawColor;
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
  ctx.shadowColor = drawColor;
  ctx.shadowBlur  = styles.glowBlur;
  ctx.stroke();

  // NoDraw Elements
  ctx.save();
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
  ctx.shadowColor = drawColor;
  ctx.shadowBlur  = styles.glowBlur;
  ctx.fill();
  ctx.stroke();

  // Non-2-state values
  ctx.save();
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
  ctx.shadowColor = xzColor;
  ctx.shadowBlur  = styles.glowBlur;
  ctx.stroke();
  ctx.shadowBlur  = 0;
  ctx.restore();
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

  draw(valueChangeChunk: RenderBounds, netlistData: NetlistVariable | CustomVariable) {
    //const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, false);
    return createAnalogWaveform(valueChangeChunk, netlistData, this.stepped, this.evalCoordinates);
  }
}
