/**
 * WebGL-based waveform renderer
 * 
 * This provides the same interface as the Canvas 2D renderers in renderer.ts
 * but uses WebGL for better performance on Windows.
 * 
 * Architecture:
 * - Single WebGL canvas for all waveform geometry (lines, fills)
 * - Canvas 2D overlay for text (WebGL text is complex)
 * - Batched rendering for performance
 */

import { VariableItem } from './signal_item';
import { Viewport } from './viewport';
import { WAVE_HEIGHT } from './vaporview';

// ============================================================================
// Shader Sources
// ============================================================================

const VERTEX_SHADER_SOURCE = `
  attribute vec2 a_position;
  uniform vec2 u_resolution;
  uniform vec2 u_translation;
  uniform vec2 u_scale;
  uniform float u_pixelRatio;
  
  void main() {
    // Add 0.5 pixel offset (in device pixels) to align lines with pixel centers (prevents blurry lines)
    // Divide by pixelRatio since we're working in CSS pixel coordinates
    float halfPixel = 0.5 / u_pixelRatio;
    vec2 position = (a_position * u_scale + u_translation + vec2(halfPixel, halfPixel)) / u_resolution;
    vec2 clipSpace = position * 2.0 - 1.0;
    gl_Position = vec4(clipSpace * vec2(1, -1), 0, 1);
  }
`;

const FRAGMENT_SHADER_SOURCE = `
  precision mediump float;
  uniform vec4 u_color;
  
  void main() {
    gl_FragColor = u_color;
  }
`;

// ============================================================================
// WebGL Context Manager (Singleton)
// ============================================================================

export class WebGLContextManager {
  private static instance: WebGLContextManager | null = null;
  
  public gl: WebGL2RenderingContext | WebGLRenderingContext;
  public canvas: HTMLCanvasElement;
  public textCanvas: HTMLCanvasElement;
  public textCtx: CanvasRenderingContext2D;
  public pixelRatio: number;
  
  private program: WebGLProgram;
  private positionBuffer: WebGLBuffer;
  private positionLocation: number;
  private resolutionLocation: WebGLUniformLocation;
  private translationLocation: WebGLUniformLocation;
  private scaleLocation: WebGLUniformLocation;
  private colorLocation: WebGLUniformLocation;
  private pixelRatioLocation: WebGLUniformLocation;
  
  // Store CSS dimensions for coordinate calculations
  private cssWidth: number;
  private cssHeight: number;
  
  private constructor(container: HTMLElement, width: number, height: number) {
    this.pixelRatio = window.devicePixelRatio || 1;
    this.cssWidth = width;
    this.cssHeight = height;
    
    // Create WebGL canvas (scaled for HiDPI)
    this.canvas = document.createElement('canvas');
    this.canvas.width = width * this.pixelRatio;
    this.canvas.height = height * this.pixelRatio;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '0';
    this.canvas.style.top = '0';
    this.canvas.style.pointerEvents = 'none';
    container.appendChild(this.canvas);
    
    // Create text overlay canvas (scaled for HiDPI)
    this.textCanvas = document.createElement('canvas');
    this.textCanvas.width = width * this.pixelRatio;
    this.textCanvas.height = height * this.pixelRatio;
    this.textCanvas.style.width = width + 'px';
    this.textCanvas.style.height = height + 'px';
    this.textCanvas.style.position = 'absolute';
    this.textCanvas.style.left = '0';
    this.textCanvas.style.top = '0';
    this.textCanvas.style.pointerEvents = 'none';
    container.appendChild(this.textCanvas);
    
    this.textCtx = this.textCanvas.getContext('2d', { alpha: true })!;
    // Scale the 2D context to match pixel ratio
    this.textCtx.scale(this.pixelRatio, this.pixelRatio);
    
    // Get WebGL context
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      desynchronized: true,
      powerPreference: 'high-performance',
    }) || this.canvas.getContext('webgl', {
      alpha: true,
      antialias: true,
      desynchronized: true,
      powerPreference: 'high-performance',
    });
    
    if (!gl) {
      throw new Error('WebGL not supported');
    }
    
    this.gl = gl;
    this.program = this.createProgram();
    this.positionBuffer = gl.createBuffer()!;
    
    // Get locations
    this.positionLocation = gl.getAttribLocation(this.program, 'a_position');
    this.resolutionLocation = gl.getUniformLocation(this.program, 'u_resolution')!;
    this.translationLocation = gl.getUniformLocation(this.program, 'u_translation')!;
    this.scaleLocation = gl.getUniformLocation(this.program, 'u_scale')!;
    this.colorLocation = gl.getUniformLocation(this.program, 'u_color')!;
    this.pixelRatioLocation = gl.getUniformLocation(this.program, 'u_pixelRatio')!;
    
    // Setup
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.enableVertexAttribArray(this.positionLocation);
    gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
    
    // Enable blending for alpha
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
  
  static initialize(container: HTMLElement, width: number, height: number): WebGLContextManager {
    if (!WebGLContextManager.instance) {
      WebGLContextManager.instance = new WebGLContextManager(container, width, height);
    }
    return WebGLContextManager.instance;
  }
  
  static getInstance(): WebGLContextManager | null {
    return WebGLContextManager.instance;
  }
  
  private createShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Shader compile error: ' + info);
    }
    
    return shader;
  }
  
  private createProgram(): WebGLProgram {
    const gl = this.gl;
    const vertexShader = this.createShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      throw new Error('Program link error: ' + info);
    }
    
    return program;
  }
  
  resize(width: number, height: number) {
    this.pixelRatio = window.devicePixelRatio || 1;
    this.cssWidth = width;
    this.cssHeight = height;
    
    // Scale canvas for HiDPI
    this.canvas.width = width * this.pixelRatio;
    this.canvas.height = height * this.pixelRatio;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    
    this.textCanvas.width = width * this.pixelRatio;
    this.textCanvas.height = height * this.pixelRatio;
    this.textCanvas.style.width = width + 'px';
    this.textCanvas.style.height = height + 'px';
    
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    
    // Reset and scale text context (scale is reset when canvas size changes)
    this.textCtx.scale(this.pixelRatio, this.pixelRatio);
  }
  
  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    // Clear using actual canvas dimensions
    this.textCtx.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }
  
  setTransform(translateX: number, translateY: number, scaleX: number, scaleY: number) {
    const gl = this.gl;
    // Use CSS dimensions for coordinate calculations (WebGL handles pixel ratio via canvas size)
    gl.uniform2f(this.resolutionLocation, this.cssWidth, this.cssHeight);
    gl.uniform2f(this.translationLocation, translateX, translateY);
    gl.uniform2f(this.scaleLocation, scaleX, scaleY);
    gl.uniform1f(this.pixelRatioLocation, this.pixelRatio);
  }
  
  setColor(r: number, g: number, b: number, a: number) {
    this.gl.uniform4f(this.colorLocation, r, g, b, a);
  }
  
  setColorFromHex(hex: string, alpha: number = 1.0) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    this.setColor(r, g, b, alpha);
  }
  
  setColorFromCSS(cssColor: string, alpha: number = 1.0) {
    // Handle various CSS color formats
    if (cssColor.startsWith('#')) {
      this.setColorFromHex(cssColor, alpha);
    } else if (cssColor.startsWith('rgb')) {
      const match = cssColor.match(/[\d.]+/g);
      if (match && match.length >= 3) {
        const r = parseFloat(match[0]) / 255;
        const g = parseFloat(match[1]) / 255;
        const b = parseFloat(match[2]) / 255;
        const a = match.length > 3 ? parseFloat(match[3]) : 1.0;
        this.setColor(r, g, b, a * alpha);
      }
    } else {
      // Fallback - create a temp canvas to parse the color
      const ctx = this.textCtx;
      ctx.fillStyle = cssColor;
      const computed = ctx.fillStyle;
      if (computed.startsWith('#')) {
        this.setColorFromHex(computed, alpha);
      }
    }
  }
  
  drawLineStrip(points: number[]) {
    const gl = this.gl;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINE_STRIP, 0, points.length / 2);
  }
  
  drawLines(points: number[]) {
    const gl = this.gl;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(points), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, points.length / 2);
  }
  
  drawTriangles(vertices: number[]) {
    const gl = this.gl;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
  }
  
  drawTriangleFan(vertices: number[]) {
    const gl = this.gl;
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, vertices.length / 2);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function parseColor(cssColor: string): [number, number, number] {
  if (cssColor.startsWith('#')) {
    return [
      parseInt(cssColor.slice(1, 3), 16) / 255,
      parseInt(cssColor.slice(3, 5), 16) / 255,
      parseInt(cssColor.slice(5, 7), 16) / 255,
    ];
  }
  // Default fallback
  return [1, 1, 1];
}

// Triangulate a polygon (simple fan triangulation for convex polygons)
function triangulatePolygon(points: number[][]): number[] {
  if (points.length < 3) return [];
  
  const vertices: number[] = [];
  const center = points[0];
  
  for (let i = 1; i < points.length - 1; i++) {
    vertices.push(center[0], center[1]);
    vertices.push(points[i][0], points[i][1]);
    vertices.push(points[i + 1][0], points[i + 1][1]);
  }
  
  return vertices;
}

// Triangulate a diamond shape
function triangulateDiamond(left: number, centerY: number, halfWidth: number, halfHeight: number): number[] {
  const cx = left + halfWidth;
  const top = centerY - halfHeight;
  const bottom = centerY + halfHeight;
  const right = left + halfWidth * 2;
  
  return [
    // Top triangle
    left, centerY,
    cx, top,
    right, centerY,
    // Bottom triangle
    left, centerY,
    right, centerY,
    cx, bottom,
  ];
}

// Triangulate a rectangle
function triangulateRect(x: number, y: number, width: number, height: number): number[] {
  return [
    x, y,
    x + width, y,
    x, y + height,
    x, y + height,
    x + width, y,
    x + width, y + height,
  ];
}

// ============================================================================
// Bus Value Text Helper (same as renderer.ts)
// ============================================================================

function busValue(time: number, deltaTime: number, displayValue: string, viewportSpecs: any, rightJustify: boolean): [string, number, boolean] {
  const textTime = displayValue.length * viewportSpecs.characterWidth * viewportSpecs.pixelTime;
  const padding = 4 * viewportSpecs.pixelTime;
  const adjustedTime = Math.max(time, viewportSpecs.timeScrollLeft);
  const adjustedDeltaTime = Math.min(time + deltaTime, viewportSpecs.timeScrollRight) - adjustedTime;
  const characterWidthLimit = adjustedDeltaTime - (2 * padding);
  const centerText = (textTime <= characterWidthLimit);
  let text = displayValue;
  let xValue: number;

  if (centerText) {
    xValue = adjustedTime + (adjustedDeltaTime / 2);
  } else {
    const charCount = Math.floor(characterWidthLimit / (viewportSpecs.characterWidth * viewportSpecs.pixelTime)) - 1;
    if (charCount < 0) { return ["", -100, false]; }
    if (rightJustify) {
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

// ============================================================================
// WebGL Waveform Renderer Interface
// ============================================================================

export interface WebGLWaveformRenderer {
  id: string;
  draw(
    valueChangeChunk: any,
    netlistData: VariableItem,
    viewport: Viewport,
    glManager: WebGLContextManager,
    yOffset: number
  ): void;
}

// ============================================================================
// Multi-Bit Waveform Renderer (WebGL)
// ============================================================================

// Helper to add hexagon/diamond vertices to an array
// When narrow: diamond shape (angled edges meet in middle)
// When wide: hexagon with flat top/bottom and angled edges
function addBusShape(
  vertices: number[],
  screenLeft: number,
  screenRight: number,
  cy: number,
  halfHeight: number,
  slopeWidth: number  // horizontal distance for angled edge
) {
  const screenWidth = screenRight - screenLeft;
  const halfWidth = screenWidth / 2;
  const screenCenterX = screenLeft + halfWidth;
  
  const top = cy - halfHeight;
  const bottom = cy + halfHeight;
  
  if (halfWidth <= slopeWidth) {
    // Narrow: draw diamond (angled edges meet in middle)
    // Scale the height proportionally
    const yExtent = (halfWidth / slopeWidth) * halfHeight;
    const diamondTop = cy - yExtent;
    const diamondBottom = cy + yExtent;
    
    // Diamond: 2 triangles
    vertices.push(
      screenLeft, cy,
      screenCenterX, diamondTop,
      screenRight, cy,
      screenLeft, cy,
      screenRight, cy,
      screenCenterX, diamondBottom,
    );
  } else {
    // Wide: draw hexagon with flat top/bottom
    const topLeft = screenLeft + slopeWidth;
    const topRight = screenRight - slopeWidth;
    const bottomLeft = screenLeft + slopeWidth;
    const bottomRight = screenRight - slopeWidth;
    
    // Hexagon: 4 triangles
    // Left triangle
    vertices.push(
      screenLeft, cy,
      topLeft, top,
      bottomLeft, bottom,
    );
    // Top-center rectangle (2 triangles)
    vertices.push(
      topLeft, top,
      topRight, top,
      bottomLeft, bottom,
      topRight, top,
      bottomRight, bottom,
      bottomLeft, bottom,
    );
    // Right triangle
    vertices.push(
      topRight, top,
      screenRight, cy,
      bottomRight, bottom,
    );
  }
}

export const webglMultiBitRenderer: WebGLWaveformRenderer = {
  id: "multiBit",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: Viewport, glManager: WebGLContextManager, yOffset: number) {
    const transitionData = valueChangeChunk.valueChanges;
    const initialState = valueChangeChunk.initialState;
    const postState = valueChangeChunk.postState;
    const startIndex = valueChangeChunk.startIndex;
    const endIndex = valueChangeChunk.endIndex;

    const signalWidth = netlistData.signalWidth;
    const parseValue = netlistData.valueFormat.formatString;
    const valueIs9State = netlistData.valueFormat.is9State;
    const rightJustify = netlistData.valueFormat.rightJustify;
    const rowHeight = netlistData.rowHeight * WAVE_HEIGHT;
    const canvasHeight = rowHeight - 8;
    const halfCanvasHeight = canvasHeight / 2;

    const minTextWidth = 12 * viewportSpecs.pixelTime;
    const minDrawWidth = viewportSpecs.pixelTime / viewportSpecs.pixelRatio;
    const drawColor = netlistData.color;
    const xzColor = viewportSpecs.xzColor;
    const fillShape = viewportSpecs.fillMultiBitValues;
    
    // Slope width: horizontal distance for the angled edge to reach full height
    // This gives a fixed angle for the hexagon edges
    const slopeWidth = halfCanvasHeight * 0.5;  // 2:1 aspect ratio for angled edges

    // Collect geometry
    const normalVertices: number[] = [];
    const xzVertices: number[] = [];
    const textElements: [string, number, boolean][] = [];

    let time = initialState[0];
    let value = initialState[1];

    for (let i = startIndex; i < endIndex; i++) {
      const elementWidth = transitionData[i][0] - time;

      if (elementWidth > minDrawWidth) {
        const adjustedTime = time - viewportSpecs.timeScrollLeft;
        const adjustedTimeEnd = adjustedTime + elementWidth;
        const is4State = valueIs9State(value);

        const targetArray = is4State ? xzVertices : normalVertices;
        const cy = yOffset + halfCanvasHeight;
        
        // Convert time coordinates to screen coordinates
        const screenLeft = adjustedTime * viewportSpecs.zoomRatio;
        const screenRight = adjustedTimeEnd * viewportSpecs.zoomRatio;

        // Add hexagon/diamond shape
        addBusShape(targetArray, screenLeft, screenRight, cy, halfCanvasHeight, slopeWidth);

        // Text
        if (elementWidth > minTextWidth) {
          let parsedValue: string;
          if (netlistData.formatCached) {
            parsedValue = netlistData.formattedValues[i - 1];
          } else {
            parsedValue = parseValue(value, signalWidth, !is4State);
          }
          textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, rightJustify));
        }
      }

      time = transitionData[i][0];
      value = transitionData[i][1];
    }

    // Handle final element
    const elementWidth = postState[0] - time;
    if (elementWidth > minDrawWidth) {
      const adjustedTime = time - viewportSpecs.timeScrollLeft;
      const adjustedTimeEnd = postState[0] - viewportSpecs.timeScrollLeft;
      const is4State = valueIs9State(value);

      const targetArray = is4State ? xzVertices : normalVertices;
      const cy = yOffset + halfCanvasHeight;
      
      const screenLeft = adjustedTime * viewportSpecs.zoomRatio;
      const screenRight = adjustedTimeEnd * viewportSpecs.zoomRatio;

      addBusShape(targetArray, screenLeft, screenRight, cy, halfCanvasHeight, slopeWidth);

      if (elementWidth > minTextWidth) {
        let parsedValue: string;
        if (netlistData.formatCached) {
          parsedValue = netlistData.formattedValues[endIndex - 1];
        } else {
          parsedValue = parseValue(value, signalWidth, !valueIs9State(value));
        }
        textElements.push(busValue(time, elementWidth, parsedValue, viewportSpecs, rightJustify));
      }
    }

    // Draw center line (for no-draw regions)
    glManager.setTransform(0, 0, 1, 1);
    glManager.setColorFromCSS(drawColor, 0.5);
    const cy = yOffset + halfCanvasHeight;
    glManager.drawLines([0, cy, viewportSpecs.viewerWidth, cy]);

    // Draw normal value shapes
    if (normalVertices.length > 0) {
      glManager.setColorFromCSS(drawColor, fillShape ? 1.0 : 0.3);
      glManager.drawTriangles(normalVertices);
    }

    // Draw XZ value shapes
    if (xzVertices.length > 0) {
      glManager.setColorFromCSS(xzColor, fillShape ? 1.0 : 0.3);
      glManager.drawTriangles(xzVertices);
    }

    // Draw text on Canvas 2D overlay
    const textCtx = glManager.textCtx;
    const textY = yOffset + halfCanvasHeight + 1;
    const fontWeight = fillShape ? 'bold ' : '';
    const textColor = fillShape ? viewportSpecs.backgroundColor : viewportSpecs.textColor;
    
    textCtx.save();
    textCtx.font = fontWeight + viewportSpecs.fontStyle;
    textCtx.fillStyle = textColor;
    textCtx.textBaseline = 'middle';
    
    // Centered text
    textCtx.textAlign = 'center';
    textElements.forEach(([text, xValue, center]) => {
      if (center && text) {
        textCtx.fillText(text, xValue, textY);
      }
    });
    
    // Non-centered text
    textCtx.textAlign = rightJustify ? 'right' : 'left';
    textElements.forEach(([text, xValue, center]) => {
      if (!center && text) {
        textCtx.fillText(text, xValue, textY);
      }
    });
    
    textCtx.restore();
  },
};

// ============================================================================
// Binary Waveform Renderer (WebGL)
// ============================================================================

export const webglBinaryRenderer: WebGLWaveformRenderer = {
  id: "binary",

  draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: Viewport, glManager: WebGLContextManager, yOffset: number) {
    const transitionData = valueChangeChunk.valueChanges;
    const initialState = valueChangeChunk.initialState;
    const postState = valueChangeChunk.postState;
    const startIndex = valueChangeChunk.startIndex;
    const endIndex = valueChangeChunk.endIndex;

    const minDrawWidth = viewportSpecs.pixelTime / viewportSpecs.pixelRatio;
    const drawColor = netlistData.color;
    const xzColor = viewportSpecs.xzColor;
    const timeScrollLeft = viewportSpecs.timeScrollLeft;
    const timeScrollRight = viewportSpecs.timeScrollRight - timeScrollLeft;
    const valueIs9State = netlistData.valueFormat.is9State;
    const rowHeight = netlistData.rowHeight * WAVE_HEIGHT;
    const canvasHeight = rowHeight - 8;
    const waveHeight = canvasHeight - 4;
    const waveOffset = yOffset + waveHeight + (canvasHeight - waveHeight) / 2;

    let initialValue = initialState[1];
    let initialValue2state = parseInt(initialValue) || 0;
    let initialTime = initialState[0];
    let initialTimeOrStart = Math.max(initialState[0], -10);

    if (valueIs9State(initialValue)) {
      initialValue2state = 0;
    }

    // Build path as line strip points
    const linePoints: number[] = [];
    const fillVertices: number[] = [];
    const xzRects: number[] = [];
    const noDrawRects: number[] = [];

    let lastDrawTime = 0;
    let lastNoDrawTime: number | null = null;
    let noDrawFlag = false;

    // Starting point
    const startX = -10 * viewportSpecs.pixelTime * viewportSpecs.zoomRatio;
    linePoints.push(startX, waveOffset);
    linePoints.push(startX, waveOffset - initialValue2state * waveHeight);

    for (let i = startIndex; i < endIndex; i++) {
      const time = transitionData[i][0];
      const value = transitionData[i][1];

      if (time - initialTime < minDrawWidth) {
        noDrawFlag = true;
        lastNoDrawTime = time;
      } else {
        if (noDrawFlag && lastNoDrawTime !== null) {
          // Add no-draw rectangle
          const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
          const x2 = (lastNoDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
          noDrawRects.push(...triangulateRect(x1, waveOffset - waveHeight, x2 - x1, waveHeight));
          
          initialValue2state = parseInt(initialValue) || 0;
          if (valueIs9State(initialValue)) initialValue2state = 0;
          
          linePoints.push(x1, waveOffset);
          linePoints.push(x2, waveOffset);
          linePoints.push(x2, waveOffset - initialValue2state * waveHeight);
          noDrawFlag = false;
        }

        const timeLeft = (time - timeScrollLeft) * viewportSpecs.zoomRatio;
        
        // XZ region
        if (valueIs9State(initialValue)) {
          const x1 = (initialTimeOrStart - timeScrollLeft) * viewportSpecs.zoomRatio;
          xzRects.push(...triangulateRect(x1, waveOffset - waveHeight, timeLeft - x1, waveHeight));
        }

        let value2state = parseInt(value) || 0;
        if (valueIs9State(value)) value2state = 0;

        // Add transition to line
        linePoints.push(timeLeft, waveOffset - initialValue2state * waveHeight);
        linePoints.push(timeLeft, waveOffset - value2state * waveHeight);

        lastDrawTime = time;
        initialValue2state = value2state;
      }

      initialValue = value;
      initialTimeOrStart = time;
      initialTime = time;
    }

    // Handle final segment
    initialValue2state = parseInt(initialValue) || 0;
    if (valueIs9State(initialValue)) initialValue2state = 0;

    if (postState[0] - initialTime < minDrawWidth) {
      const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
      const x2 = timeScrollRight * viewportSpecs.zoomRatio;
      noDrawRects.push(...triangulateRect(x1, waveOffset - waveHeight, x2 - x1, waveHeight));
      linePoints.push(x1, waveOffset);
      linePoints.push(x2, waveOffset);
    } else {
      if (noDrawFlag && lastNoDrawTime !== null) {
        const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
        const x2 = (lastNoDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
        noDrawRects.push(...triangulateRect(x1, waveOffset - waveHeight, x2 - x1, waveHeight));
        linePoints.push(x1, waveOffset);
        linePoints.push(x2, waveOffset);
        linePoints.push(x2, waveOffset - initialValue2state * waveHeight);
      }

      if (valueIs9State(initialValue)) {
        const x1 = (initialTimeOrStart - timeScrollLeft) * viewportSpecs.zoomRatio;
        const x2 = timeScrollRight * viewportSpecs.zoomRatio;
        xzRects.push(...triangulateRect(x1, waveOffset - waveHeight, x2 - x1, waveHeight));
      }
    }

    // Final point offscreen
    const endX = (timeScrollRight + 15 * viewportSpecs.pixelTime) * viewportSpecs.zoomRatio;
    linePoints.push(endX, waveOffset - initialValue2state * waveHeight);
    linePoints.push(endX, waveOffset - waveHeight);
    linePoints.push(endX, waveOffset);

    // Build fill from line (close the path at bottom)
    for (let i = 0; i < linePoints.length - 2; i += 2) {
      fillVertices.push(
        linePoints[i], linePoints[i + 1],
        linePoints[i + 2], linePoints[i + 3],
        linePoints[i], waveOffset,
        linePoints[i], waveOffset,
        linePoints[i + 2], linePoints[i + 3],
        linePoints[i + 2], waveOffset,
      );
    }

    // Draw fill
    glManager.setTransform(0, 0, 1, 1);
    glManager.setColorFromCSS(drawColor, 0.1);
    glManager.drawTriangles(fillVertices);

    // Draw line
    glManager.setColorFromCSS(drawColor, 1.0);
    glManager.drawLineStrip(linePoints);

    // Draw no-draw regions
    if (noDrawRects.length > 0) {
      glManager.setColorFromCSS(drawColor, 1.0);
      glManager.drawTriangles(noDrawRects);
    }

    // Draw XZ regions
    if (xzRects.length > 0) {
      glManager.setColorFromCSS(xzColor, 0.5);
      glManager.drawTriangles(xzRects);
    }
  },
};

// ============================================================================
// Linear/Stepped Waveform Renderer (WebGL)
// ============================================================================

const evalBinary16plusSigned = (v: string) => {
  const n = parseInt(v.slice(0, 16), 2) || 0;
  return n > 32767 ? n - 65536 : n;
};
const evalBinarySigned = (v: string) => {
  const n = parseInt(v, 2) || 0;
  return v[0] === '1' ? n - (2 ** v.length) : n;
};
const evalBinary16plus = (v: string) => parseInt(v.slice(0, 16), 2) || 0;
const evalBinary = (v: string) => parseInt(v, 2) || 0;
const evalReal = (v: string) => parseFloat(v) || 0;

function getEval(type: string, width: number, signed: boolean): (v: string) => number {
  if (type === "Real") return evalReal;
  if (width > 16) {
    return signed ? evalBinary16plusSigned : evalBinary16plus;
  }
  return signed ? evalBinarySigned : evalBinary;
}

function createWebGLAnalogRenderer(stepped: boolean, signed: boolean): WebGLWaveformRenderer {
  return {
    id: stepped ? (signed ? "steppedSigned" : "stepped") : (signed ? "linearSigned" : "linear"),

    draw(valueChangeChunk: any, netlistData: VariableItem, viewportSpecs: Viewport, glManager: WebGLContextManager, yOffset: number) {
      const evalCoordinates = getEval(valueChangeChunk.encoding, netlistData.signalWidth, signed);
      
      const transitionData = valueChangeChunk.valueChanges;
      const initialState = valueChangeChunk.initialState;
      const postState = valueChangeChunk.postState;
      const startIndex = valueChangeChunk.startIndex;
      const endIndex = valueChangeChunk.endIndex;
      const min = valueChangeChunk.min;
      const max = valueChangeChunk.max;

      const minDrawWidth = viewportSpecs.pixelTime / (viewportSpecs.pixelRatio * 4);
      const timeScrollLeft = viewportSpecs.timeScrollLeft;
      const timeScrollRight = viewportSpecs.timeScrollRight - timeScrollLeft;
      const valueIs9State = netlistData.valueFormat.is9State;

      const rowHeight = netlistData.rowHeight * WAVE_HEIGHT;
      const canvasHeight = rowHeight - 8;
      const verticalScale = netlistData.verticalScale;
      const waveHeight = canvasHeight - 4;
      const waveOffset = yOffset + waveHeight + (canvasHeight - waveHeight) / 2;

      const yScale = waveHeight * verticalScale / (max - min);
      const yTranslate = yOffset + (max / (max - min)) * waveHeight + 2;

      let initialValue = initialState[1];
      let initialValue2state = valueIs9State(initialValue) ? "0" : initialValue;
      let initialTime = initialState[0];
      let initialTimeOrStart = Math.max(initialState[0], -10);

      const linePoints: number[] = [];
      const xzRects: number[] = [];
      const noDrawRects: number[] = [];

      let lastDrawTime = 0;
      let lastNoDrawTime: number | null = null;
      let noDrawFlag = false;

      // Starting point
      const startX = -10 * viewportSpecs.pixelTime * viewportSpecs.zoomRatio;
      const startY = yTranslate - evalCoordinates(initialValue2state) * yScale;
      linePoints.push(startX, yTranslate);
      linePoints.push((initialTime - timeScrollLeft) * viewportSpecs.zoomRatio, startY);

      for (let i = startIndex; i < endIndex; i++) {
        const time = transitionData[i][0];
        const value = transitionData[i][1];

        if (time - initialTime < minDrawWidth) {
          noDrawFlag = true;
          lastNoDrawTime = time;
        } else {
          if (noDrawFlag && lastNoDrawTime !== null) {
            const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
            const x2 = (lastNoDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
            noDrawRects.push(...triangulateRect(x1, yTranslate - max * yScale, x2 - x1, (max - min) * yScale));

            initialValue2state = valueIs9State(initialValue) ? "0" : initialValue;
            const y = yTranslate - evalCoordinates(initialValue2state) * yScale;
            linePoints.push(x1, yTranslate);
            linePoints.push(x2, yTranslate);
            linePoints.push(x2, y);
            noDrawFlag = false;
          }

          const timeLeft = (time - timeScrollLeft) * viewportSpecs.zoomRatio;

          if (valueIs9State(initialValue)) {
            const x1 = (initialTimeOrStart - timeScrollLeft) * viewportSpecs.zoomRatio;
            xzRects.push(...triangulateRect(x1, yTranslate - max * yScale, timeLeft - x1, (max - min) * yScale));
          }

          let value2state = valueIs9State(value) ? "0" : value;
          const prevY = yTranslate - evalCoordinates(initialValue2state) * yScale;
          const newY = yTranslate - evalCoordinates(value2state) * yScale;

          if (stepped) {
            linePoints.push(timeLeft, prevY);
          }
          linePoints.push(timeLeft, newY);

          lastDrawTime = time;
          initialValue2state = value2state;
        }

        initialValue = value;
        initialTimeOrStart = time;
        initialTime = time;
      }

      // Final segment
      initialValue2state = valueIs9State(initialValue) ? "0" : initialValue;

      if (postState[0] - initialTime < minDrawWidth) {
        const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
        const x2 = timeScrollRight * viewportSpecs.zoomRatio;
        noDrawRects.push(...triangulateRect(x1, yTranslate - max * yScale, x2 - x1, (max - min) * yScale));
        linePoints.push(x1, yTranslate);
        linePoints.push(x2, yTranslate);
      } else {
        if (noDrawFlag && lastNoDrawTime !== null) {
          const x1 = (lastDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
          const x2 = (lastNoDrawTime - timeScrollLeft) * viewportSpecs.zoomRatio;
          noDrawRects.push(...triangulateRect(x1, yTranslate - max * yScale, x2 - x1, (max - min) * yScale));
          const y = yTranslate - evalCoordinates(initialValue2state) * yScale;
          linePoints.push(x1, yTranslate);
          linePoints.push(x2, yTranslate);
          linePoints.push(x2, y);
        }

        if (valueIs9State(initialValue)) {
          const x1 = (initialTimeOrStart - timeScrollLeft) * viewportSpecs.zoomRatio;
          const x2 = timeScrollRight * viewportSpecs.zoomRatio;
          xzRects.push(...triangulateRect(x1, yTranslate - max * yScale, x2 - x1, (max - min) * yScale));
        }
      }

      // Final point
      const endX = stepped 
        ? (timeScrollRight + 15 * viewportSpecs.pixelTime) * viewportSpecs.zoomRatio
        : (postState[0] - timeScrollLeft) * viewportSpecs.zoomRatio;
      const endY = stepped
        ? yTranslate - evalCoordinates(initialValue2state) * yScale
        : yTranslate - evalCoordinates(postState[1]) * yScale;
      linePoints.push(endX, endY);
      linePoints.push(endX, yTranslate);

      // Build fill
      const fillVertices: number[] = [];
      for (let i = 0; i < linePoints.length - 2; i += 2) {
        fillVertices.push(
          linePoints[i], linePoints[i + 1],
          linePoints[i + 2], linePoints[i + 3],
          linePoints[i], yTranslate,
          linePoints[i], yTranslate,
          linePoints[i + 2], linePoints[i + 3],
          linePoints[i + 2], yTranslate,
        );
      }

      const drawColor = netlistData.color;
      const xzColor = viewportSpecs.xzColor;

      // Draw fill
      glManager.setTransform(0, 0, 1, 1);
      glManager.setColorFromCSS(drawColor, 0.1);
      glManager.drawTriangles(fillVertices);

      // Draw line
      glManager.setColorFromCSS(drawColor, 1.0);
      glManager.drawLineStrip(linePoints);

      // Draw no-draw regions
      if (noDrawRects.length > 0) {
        glManager.setColorFromCSS(drawColor, 1.0);
        glManager.drawTriangles(noDrawRects);
      }

      // Draw XZ regions
      if (xzRects.length > 0) {
        glManager.setColorFromCSS(xzColor, 0.5);
        glManager.drawTriangles(xzRects);
      }
    },
  };
}

export const webglLinearRenderer = createWebGLAnalogRenderer(false, false);
export const webglLinearSignedRenderer = createWebGLAnalogRenderer(false, true);
export const webglSteppedRenderer = createWebGLAnalogRenderer(true, false);
export const webglSteppedSignedRenderer = createWebGLAnalogRenderer(true, true);

// ============================================================================
// Renderer Map (for easy lookup by id)
// ============================================================================

export const webglRenderers: Record<string, WebGLWaveformRenderer> = {
  multiBit: webglMultiBitRenderer,
  binary: webglBinaryRenderer,
  linear: webglLinearRenderer,
  linearSigned: webglLinearSignedRenderer,
  stepped: webglSteppedRenderer,
  steppedSigned: webglSteppedSignedRenderer,
};
