import { type NetlistId, type RowId, type ValueChange, EnumData, EnumEntry, NameType, VariableEncoding, CollapseState, type BitRangeSource, type SignalSeparatorContext, type NetlistVariableContext, CustomVariableContext, SignalGroupContext, SavedRowItem, SavedSignalSeparator, SavedNetlistVariable, SavedCustomVariable, SavedSignalGroup } from '../common/types';

import { dataManager, viewport, viewerState, updateDisplayedSignalsFlat, events, ActionType, getRowHeightCssClass, rowHandler, vscodeWrapper, styles } from "./vaporview";
import { EnumValueFormat, formatBinary, formatHex, formatString, type ValueFormat } from "./value_format";
import { type WaveformRenderer, setRenderBounds } from "./renderer";
import type { WaveformData } from "./data_manager";
import { labelsPanel } from "./vaporview";
import { createInstancePath } from '../common/functions';

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function isAnalogSignal(renderType: WaveformRenderer) {
  return renderType.id === 'linear' || renderType.id === 'linearSigned' ||
         renderType.id === 'stepped' || renderType.id === 'steppedSigned';
}

function getColorFromColorIndex(colorIndex: number) {
  if (colorIndex < 4) {
    return styles.colorKey[colorIndex];
  } else {
    return styles.customColorKey[colorIndex - 4];
  }
}

function mouseOverHandler(event: MouseEvent, signalItem: NetlistVariable, checkBounds: boolean) {
  if (!event.target) {return;}

  let redraw        = false;
  let valueIndex    = -1;

  if (checkBounds) {
    const elementX    = event.pageX - viewport.scrollAreaBounds.left;
    signalItem.valueLinkBounds.forEach(([min, max], i) => {
      if (elementX >= min && elementX <= max) {
        valueIndex = i;
      }
    });
  }

  // store a pointer to the netlistData object for a keydown event handler
  if (valueIndex >= 0) {
    viewport.valueLinkObject = signalItem;
  } else {
    viewport.valueLinkObject = null;
  }

  // Check to change cursor to a pointer
  if (valueIndex >= 0 && (event.ctrlKey || event.metaKey)) {
    signalItem.canvas?.classList.add('waveform-link');
  } else {
    signalItem.canvas?.classList.remove('waveform-link');
  }

  if (valueIndex !== signalItem.valueLinkIndex) {redraw = true;}
  signalItem.valueLinkIndex = valueIndex;

  if (redraw) {
    signalItem.wasRendered = false;
    signalItem.renderWaveform();
  }
}

export type VariableItem = NetlistVariable | CustomVariable;

export abstract class SignalItem {

  public labelElement: HTMLElement | null = null
  public valueDisplayElement: HTMLElement | null = null
  public viewportElement: HTMLElement | null = null
  public vscodeContext: string = "";
  public wasRendered: boolean = false;
  public rowHeight: number = 1;
  public isSelected: boolean = false;
  public abstract readonly rowId: RowId;

  public abstract createLabelElement(): string
  public abstract createValueDisplayElement(): string
  public getValueAtTime(time: number | null): string[] {return [""];}
  public getNearestTransition(time: number | null): ValueChange | null {return null;}
  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {return [this.rowId];}
  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {return 1;}
  public findParentGroupId(rowId: RowId): number | null {return null;}
  public formatValue(value: any): string {return "";}
  public getWaveformData(): WaveformData | undefined {return undefined;}
  public renderWaveform() {return;}
  public handleValueLink(time: number, snapToTime: number) {return false;}
  public getAllEdges(valueList: string[]): number[] {return [];}
  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {return null;}
  public resize() {return;}
  public dispose() {return;}
}

export interface RowItem {
  labelElement: HTMLElement | null;
  valueDisplayElement: HTMLElement | null;
  viewportElement: HTMLElement | null;
  vscodeContext: string;
  wasRendered: boolean;
  rowHeight: number;
  isSelected: boolean;
  netlistId?: NetlistId;

  createLabelElement(): string;
  createValueDisplayElement(): string;
  createViewportElement(rowId: number): void;
  setSignalContextAttribute(): void;
  createWaveformRowContent(): string;
  getLabelText(): string;
  setLabelText(newLabel: string): void;
  getSaveData(): SavedRowItem;

  getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[];
  rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number
  findParentGroupId(rowId: RowId): number | null;

  getValueAtTime(time: number | null): string[];
  getAllEdges(valueList: string[]): number[];
  getNextEdge(time: number, direction: number, valueList: string[]): number | null;
  getNearestTransition(time: number | null): [number, string] | null;
  getWaveformData(): WaveformData | undefined;

  renderWaveform(): void;
  handleValueLink(time: number, snapToTime: number): boolean;
  resize(): void;

  dispose(): void;
}

export class SignalSeparator extends SignalItem implements RowItem {

  constructor(
    public rowId: number,
    public label: string,
  ) {
    super();
    this.setSignalContextAttribute();
  }

  public createWaveformRowContent() {return `<p>${this.label}</p>`;}

  public createLabelElement() {
    const height            = getRowHeightCssClass(this.rowHeight);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label waveform-separator is-idle" id="label-${this.rowId}" data-vscode-context=${this.vscodeContext}>
              <div class="waveform-row ${selectorClass} ${height}">${this.createWaveformRowContent()}</div>
            </div>`;
    }

  public createValueDisplayElement() {

    const height            = getRowHeightCssClass(this.rowHeight);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass     = isSelectedClass + ' ' + lastSelectedClass;
    const result = `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}></div>`;
    return result;
  }

  public createViewportElement(rowId: number) {
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    //waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    const context: SignalSeparatorContext = {
      webviewSection: "signal-separator",
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    }
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedSignalSeparator {
    return {
      dataType: "signal-separator",
      label: this.label,
      rowHeight: this.rowHeight,
    }
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}
}

export class NetlistVariable extends SignalItem implements RowItem {

  public valueFormat: ValueFormat;
  public valueLinkCommand: string = "";
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = 0;
  public color: string = "";
  public rowHeight: number = 1;
  public wasRendered: boolean = false;
  public canvas: HTMLCanvasElement | null = null
  public ctx: CanvasRenderingContext2D | null = null
  public verticalScale: number = 1;
  public nameType: NameType = NameType.fullPath;
  public customName: string = "";
  public min: number = 0;
  public max: number = 0;

  constructor(
    public readonly rowId: RowId,
    public readonly netlistId: number,
    public signalId: number,
    public signalName: string,
    public scopePath: string[],
    public signalWidth: number,
    public variableType: string,
    public encoding: VariableEncoding,
    public renderType: WaveformRenderer,
    public enumType: string,
  ) {
    super();

    this.customName = this.signalName;
    if (this.encoding === VariableEncoding.String) {
      this.valueFormat = formatString;
      this.colorIndex  = 1;
    } else if (this.encoding === VariableEncoding.Real) {
      this.valueFormat = formatString;
    } else if (this.enumType !== "") {
      this.valueFormat = new EnumValueFormat(this.enumType);
    } else {
      this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    }
    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createWaveformRowContent(): string {
    let result = "";
    const signalName  = htmlSafe(this.signalName);
    if (this.nameType === NameType.fullPath) {
      const scopePath = htmlSafe(this.scopePath.join('.') + '.');
      result += `<p style="opacity:50%">${scopePath}</p><p>${signalName}</p>`
    } else if (this.nameType === NameType.signalName) {
      result += `<p>${signalName}</p>`;
    } else if (this.nameType === NameType.custom) {
      result += `<p>${htmlSafe(this.customName)}</p>`;
    }

    return result;
  }

  public createLabelElement() {

    const height        = getRowHeightCssClass(this.rowHeight);
    const signalName    = htmlSafe(this.signalName);
    const instancePath  = htmlSafe(createInstancePath(this.scopePath, signalName));
    const fullPath      = htmlAttributeSafe(instancePath);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label is-idle" id="label-${this.rowId}" title="${tooltip}" data-vscode-context=${this.vscodeContext}>
              <div class='waveform-row ${selectorClass} ${height}'>${this.createWaveformRowContent()}</div>
            </div>`;
    }

  public createValueDisplayElement() {
    let   value = labelsPanel.valueAtMarker[this.rowId];
    if (value === undefined) {value = [];}
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const height        = getRowHeightCssClass(this.rowHeight);
    const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
    const parseValue    = this.valueFormat.formatString;
    const valueIs9State = this.valueFormat.is9State;
    const pElement      = value.map((v: string) => {
      const is9State     = valueIs9State(v);
      const colorStyle   = is9State ? 'var(--vscode-debugTokenExpression-error)' : this.color;
      const displayValue = parseValue(v, this.signalWidth, !is9State);
      return `<p style="color:${colorStyle}">${displayValue}</p>`;
    }).join(joinString);

    return `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}>${pElement}</div>`;
  }

  public createViewportElement(rowId: number) {

    const canvas = document.createElement('canvas');
    canvas.setAttribute('id', 'waveform-canvas-' + rowId);
    canvas.classList.add('waveform-canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const canvasHeight = (this.rowHeight * styles.rowHeight) - 8;
    if (this.ctx) {
      viewport.resizeCanvas(canvas, this.ctx, viewport.viewerWidth, canvasHeight);
    }
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.appendChild(canvas);
    //waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = isAnalogSignal(this.renderType);
    const context: NetlistVariableContext = {
      webviewSection: "signal",
      scopePath: this.scopePath.join('.'),
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      commandValid: this.valueLinkCommand !== "",
      netlistId: this.netlistId,
      rowId: this.rowId,
      isAnalog: isAnalog,
      enum: this.enumType !== "",
    }
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedNetlistVariable {
    return {
      dataType:         "netlist-variable",
      netlistId:        this.netlistId,
      name:             createInstancePath(this.scopePath, this.signalName),
      numberFormat:     this.valueFormat.id,
      colorIndex:       this.colorIndex,
      rowHeight:        this.rowHeight,
      verticalScale:    this.verticalScale,
      nameType:         this.nameType,
      customName:       this.customName,
      renderType:       this.renderType.id,
      valueLinkCommand: this.valueLinkCommand
    }
  }

  public getLabelText(): string {
    if (this.nameType === NameType.custom) {
      return this.customName;
    } else if (this.nameType === NameType.signalName) {
      return this.signalName;
    } else {
      return [this.scopePath, this.signalName].join('.');
    }
  }

  public setLabelText(newLabel: string) {
    this.customName = newLabel;
    this.nameType = NameType.custom;
  }

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    if (ignoreRowId === this.rowId) {return [];}
    return [this.rowId];
  }

  public renderWaveform() {

    const data = dataManager.valueChangeData[this.signalId];

    if (!data) {return;}
    if (!this.ctx) {return;}

    const valueChangeChunk = setRenderBounds(this, data);
    this.renderType.draw(valueChangeChunk, this);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number | null) {
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getValueAtTime(data, time);
  }

  public getNearestTransition(time: number | null): ValueChange | null {
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getNearestTransition(data, time);
  }

  public getWaveformData(): WaveformData | undefined {
    return dataManager.valueChangeData[this.signalId];
  }

  public setColorFromColorIndex() {
    this.color = getColorFromColorIndex(this.colorIndex);
  }

  public getAllEdges(valueList: string[]): number[] {
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getAllEdges(valueList, data, this.signalWidth);
  }

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    const data = dataManager.valueChangeData[this.signalId];
    return dataManager.getNextEdge(data, time, direction, valueList);
  }

  public resize() {
    if (!this.canvas || !this.ctx) {return;}
    const canvasHeight = (this.rowHeight * styles.rowHeight) - 8;
    viewport.resizeCanvas(this.canvas, this.ctx, viewport.viewerWidth, canvasHeight);
  }

  handleValueLinkMouseOver(event: MouseEvent) {
    mouseOverHandler(event, this, true);
  }

  handleValueLinkMouseExit(event: MouseEvent) {
    mouseOverHandler(event, this, false);
  }

  handleValueLink(time: number, snapToTime: number): boolean {

    const data = dataManager.valueChangeData[this.signalId];

    if (!data) {return false;}
    if (this.valueLinkCommand === "") {return false;}
    if (this.renderType.id !== 'multiBit') {return false;}
    if (this.valueLinkIndex < 0) {return false;}
    if (time !== snapToTime) {return false;}

    const command        = this.valueLinkCommand;
    const signalId       = this.signalId;
    const index          = dataManager.getNearestTransitionIndex(data, time) - 1;
    const valueChange    = dataManager.valueChangeData[signalId].valueChangeData[index];
    const timeValue      = valueChange[0];
    const value          = valueChange[1];
    const formattedValue = this.valueFormat.formatString(value, this.signalWidth, !this.valueFormat.is9State(value));

    const event = {
      netlistId: this.netlistId,
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      encoding: this.encoding,
      numberFormat: this.valueFormat.id,
      value: value,
      formattedValue: formattedValue,
      time: timeValue,
    }

    vscodeWrapper.executeCommand(command, [event]);
    return true;
  }

  public dispose() {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
  }
}

export class CustomVariable extends SignalItem implements RowItem {

  public valueFormat: ValueFormat;
  public valueLinkCommand: string = "";
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = 0;
  public color: string = "";
  public rowHeight: number = 1;
  public wasRendered: boolean = false;
  public canvas: HTMLCanvasElement | null = null
  public ctx: CanvasRenderingContext2D | null = null
  public verticalScale: number = 1;
  public nameType: NameType = NameType.fullPath;
  public customName: string = "";
  public min: number = 0;
  public max: number = 0;
  public variableType: string = "custom";
  public encoding: VariableEncoding = VariableEncoding.BitVector;
  public enumType: string = "";

  constructor(
    public rowId: number,
    public source: BitRangeSource[],
    public customSignalId: number,
    public signalName: string,
    public signalWidth: number,
    public renderType: WaveformRenderer,
  ) {
    super();
    this.customName = this.signalName;
    this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createWaveformRowContent(): string {

    if (this.nameType === NameType.custom) {
      return `<p>${htmlSafe(this.customName)}</p>`;
    } else {
      return `<p>${htmlSafe(this.signalName)}</p>`;
    }
  }

  public createLabelElement() {

    const height        = getRowHeightCssClass(this.rowHeight);
    const signalName    = htmlSafe(this.signalName);
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    const tooltip       = "Name: " + signalName + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label is-idle" id="label-${this.rowId}" title="${tooltip}" data-vscode-context=${this.vscodeContext}>
              <div class='waveform-row ${selectorClass} ${height}'>${this.createWaveformRowContent()}</div>
            </div>`;
    }

    public createValueDisplayElement() {

      let   value = labelsPanel.valueAtMarker[this.rowId];
      if (value === undefined) {value = [];}
      const isSelectedClass   = this.isSelected ? 'is-selected' : '';
      const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
      const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
      const height        = getRowHeightCssClass(this.rowHeight);
      const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
      const parseValue    = this.valueFormat.formatString;
      const valueIs9State = this.valueFormat.is9State;
      const pElement      = value.map((v: string) => {
        const is9State     = valueIs9State(v);
        const colorStyle   = is9State ? 'var(--vscode-debugTokenExpression-error)' : this.color;
        const displayValue = parseValue(v, this.signalWidth, !is9State);
        return `<p style="color:${colorStyle}">${displayValue}</p>`;
      }).join(joinString);
  
      return `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}>${pElement}</div>`;
    }

  public createViewportElement(rowId: number) {

    const canvas = document.createElement('canvas');
    canvas.setAttribute('id', 'waveform-canvas-' + rowId);
    canvas.classList.add('waveform-canvas');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    const canvasHeight = (this.rowHeight * styles.rowHeight) - 8;
    if (this.ctx) {
      viewport.resizeCanvas(canvas, this.ctx, viewport.viewerWidth, canvasHeight);
    }
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.appendChild(canvas);
    //waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = isAnalogSignal(this.renderType);
    const context: CustomVariableContext = {
      webviewSection: "signal",
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      rowId: this.rowId,
      isAnalog: isAnalog,
    };
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedCustomVariable {
    return {
      dataType:         "custom-variable",
      source:           this.source,
      numberFormat:     this.valueFormat.id,
      colorIndex:       this.colorIndex,
      rowHeight:        this.rowHeight,
      verticalScale:    this.verticalScale,
      nameType:         this.nameType,
      customName:       this.customName,
      renderType:       this.renderType.id,
      valueLinkCommand: this.valueLinkCommand,
    }
  }

  public getLabelText(): string {
    if (this.nameType === NameType.custom) {
      return this.customName;
    } else if (this.nameType === NameType.signalName) {
      return this.signalName;
    } else {
      return this.signalName;
    }
  }

  public setLabelText(newLabel: string) {
    this.customName = newLabel;
    this.nameType = NameType.custom;
  }

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    if (ignoreRowId === this.rowId) {return [];}
    return [this.rowId];
  }

  public renderWaveform() {

    const data = dataManager.customValueChangeData[this.customSignalId];

    if (!data) {return;}
    if (!this.ctx) {return;}
    const valueChangeData = data.valueChangeData;
    if (valueChangeData.length === 0) {return;}

    const valueChangeChunk = setRenderBounds(this, data);
    this.renderType.draw(valueChangeChunk, this);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number | null) {
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getValueAtTime(data, time);
  }

  public getNearestTransition(time: number | null): ValueChange | null {
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getNearestTransition(data, time);
  }

  public getWaveformData(): WaveformData | undefined {
    return dataManager.customValueChangeData[this.customSignalId];
  }

  public setColorFromColorIndex() {
    this.color = getColorFromColorIndex(this.colorIndex);
  }

  public getAllEdges(valueList: string[]): number[] {
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getAllEdges(valueList, data, this.signalWidth);
  }

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    const data = dataManager.customValueChangeData[this.customSignalId];
    return dataManager.getNextEdge(data, time, direction, valueList);
  }

  public resize() {
    if (!this.canvas || !this.ctx) {return;}
    const canvasHeight = (this.rowHeight * styles.rowHeight) - 8;
    viewport.resizeCanvas(this.canvas, this.ctx, viewport.viewerWidth, canvasHeight);
  }

  //handleValueLinkMouseOver(event: MouseEvent) {
  //  mouseOverHandler(event, this, true);
  //}

  //handleValueLinkMouseExit(event: MouseEvent) {
  //  mouseOverHandler(event, this, false);
  //}

  public dispose() {
    this.canvas?.remove();
    this.canvas = null;
    this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
  }

}

export class SignalGroup extends SignalItem implements RowItem {

  public collapseState: CollapseState = CollapseState.Expanded;
  public children: RowId[] = [];

  constructor(
    public rowId: number,
    public label: string,
    public readonly groupId: number
  ) {
    super();
    this.setSignalContextAttribute();
  }

  public createWaveformRowContent() {
    const icon = this.collapseState === CollapseState.Expanded ? 
      'codicon-chevron-down' : 'codicon-chevron-right';
    return `<div class='codicon ${icon}'></div><p>${this.label}</p>`;
  }

  public createLabelElement() {

    let childElements = '';
    let icon = 'codicon-chevron-right';
    let groupClass = 'collapsed-group';
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = rowHandler.rowItems[childRowId];
        childElements += signalItem.createLabelElement();
      });
      icon = 'codicon-chevron-down';
      groupClass = 'expanded-group';
    }
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label waveform-group is-idle ${groupClass}" id="label-${this.rowId}" data-vscode-context=${this.vscodeContext}>
              <div class="waveform-row ${selectorClass} height1x">${this.createWaveformRowContent()}</div>
              <div class="labels-group child-group">${childElements}</div>
            </div>`;
    }

  public createValueDisplayElement() {

    let   value = labelsPanel.valueAtMarker[this.rowId];
    const isSelectedClass   = this.isSelected ? 'is-selected' : '';
    const lastSelectedClass = viewerState.lastSelectedSignal === this.rowId ? 'last-selected' : '';
    const selectorClass = isSelectedClass + ' ' + lastSelectedClass;
    let result = `<div class="value-display-item ${selectorClass} height1x" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}></div>`;
    if (value === undefined) {value = [];}
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = rowHandler.rowItems[childRowId];
        result += signalItem.createValueDisplayElement();
      });
    }
    return result;
  }

  public createViewportElement(rowId: number) {
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    //waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    const context: SignalGroupContext = {
      webviewSection: "signal-group",
      groupId: this.groupId,
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    }
    this.vscodeContext = `${JSON.stringify(context).replace(/\s/g, '%x20')}`;
  }

  public getSaveData(): SavedSignalGroup {
    const children: SavedRowItem[] = [];
    this.children.forEach((childRowId) => {
      const rowItem = rowHandler.rowItems[childRowId];
      if (!rowItem) {return;}
      children.push(rowItem.getSaveData());
    });
    return {
      dataType: "signal-group",
      groupName: this.label,
      collapseState: this.collapseState,
      children: children,
    }
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    const result: number[] = [this.rowId];
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId) => {
        if (rowId === ignoreRowId) {return;} // Skip the ignored rowId
        const signalItem = rowHandler.rowItems[rowId];
        result.push(...signalItem.getFlattenedRowIdList(ignoreCollapsed, ignoreRowId));
      });
    }
    return result;
  }

  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {
    let total = 1; // Count the group row itself
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId, i) => {
        if (i >= stopIndex) {return;}
        const signalItem = rowHandler.rowItems[rowId];
        total += signalItem.rowIdCount(ignoreCollapsed, Infinity);
      });
    }
    return total;
  }

  public findParentGroupId(rowId: RowId): number | null {
    if (this.children.includes(rowId)) {
      return this.groupId;
    }
    for (const childRowId of this.children) {
      const signalItem = rowHandler.rowItems[childRowId];
      const parentGroupId = signalItem.findParentGroupId(rowId);
      if (parentGroupId !== null) {
        return parentGroupId;
      }
    }
    return null;
  }

  public showHideViewportRows() {
    //const childRows = this.getFlattenedRowIdList(false, -1);
    const style = this.collapseState === CollapseState.Expanded ? 'flex' : 'none';
    let childRows: number[] = [];
    this.children.forEach((rowId) => {
      const childRowItem = rowHandler.rowItems[rowId];
      if (!childRowItem) {return;}
      childRows = childRows.concat(childRowItem.getFlattenedRowIdList(true, -1));
    });
    childRows.forEach((rowId) => {
      if (rowId === this.rowId) {return;} // Skip the group row itself
      const viewportRow = document.getElementById(`waveform-${rowId}`);
      if (!viewportRow) {return;}
      console.log('style', style);
      viewportRow.style.display = style;
      const signalItem = rowHandler.rowItems[rowId];
      if (signalItem instanceof NetlistVariable || signalItem instanceof CustomVariable) {
        signalItem.wasRendered = false; // Reset rendering state for child signals
      }
      viewport.updateBackgroundCanvas(true);
      viewport.updateOverlayCanvas();
    });
    updateDisplayedSignalsFlat();
    viewport.renderAllWaveforms(false);
  }

  public expand() {
    this.collapseState = CollapseState.Expanded;
    labelsPanel.renderLabelsPanels();
    this.showHideViewportRows();
  }

  public collapse() {
    this.collapseState = CollapseState.Collapsed;
    const childRows = this.getFlattenedRowIdList(false, -1);
    const newSelection = viewerState.selectedSignal.filter((rowId) => !childRows.includes(rowId));
    let lastSelected = viewerState.lastSelectedSignal;
    if (viewerState.selectedSignal.length !== newSelection.length) {
      if (lastSelected !== null && childRows.includes(lastSelected)) {
        lastSelected = null;
      }
      events.dispatch(ActionType.SignalSelect, newSelection, lastSelected);
    }
    labelsPanel.renderLabelsPanels();
    this.showHideViewportRows();
  }

  public toggleCollapse() {
    if (this.collapseState === CollapseState.Expanded) {
      this.collapse();
    } else {
      this.expand();
    }
  }

  //public renderWaveform() {this.wasRendered = true;}

  public dispose() {
    //this.canvas?.remove();
    //this.canvas = null;
    //this.ctx = null;
    this.labelElement = null;
    this.valueDisplayElement = null;
    this.viewportElement = null;
    this.label = "";
  }
}