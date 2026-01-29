import { dataManager, viewport, CollapseState, NetlistId, RowId, viewerState, updateDisplayedSignalsFlat, events, ActionType, getRowHeightCssClass, WAVE_HEIGHT, sendWebviewContext } from "./vaporview";
import { EnumValueFormat, formatBinary, formatHex, formatString, ValueFormat } from "./value_format";
import { WaveformRenderer, setRenderBounds } from "./renderer";
import { WaveformData } from "./data_manager";
import { vscode, labelsPanel } from "./vaporview";
import { LabelsPanels } from "./labels";

export enum NameType {
  fullPath = 'fullPath',
  signalName = 'signalName',
  custom = 'custom',
}

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function getColorFromColorIndex(colorIndex: number) {
  if (colorIndex < 4) {
    return viewport.colorKey[colorIndex];
  } else {
    return dataManager.customColorKey[colorIndex - 4];
  }
}

function mouseOverHandler(event: MouseEvent, signalItem: VariableItem, checkBounds: boolean) {
  if (!event.target) {return;}

  let redraw        = false;
  let valueIndex    = -1;

  if (checkBounds) {
    const elementX    = event.pageX - viewport.scrollAreaBounds.left;
    signalItem.valueLinkBounds.forEach(([min, max], i) => {
      if (elementX >= min && elementX <= max) {
        valueIndex = i;
      }
    })
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
  public getNearestTransition(time: number) {return null}
  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {return [this.rowId];}
  public rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number {return 1;}
  public findParentGroupId(rowId: RowId): number | null {return null;}
  public formatValue(value: any): string {return "";}
  public renderWaveform() {return;}
  public handleValueLink(time: number, snapToTime: number) {return;}
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

  getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[];
  rowIdCount(ignoreCollapsed: boolean, stopIndex: number): number
  findParentGroupId(rowId: RowId): number | null;

  getValueAtTime(time: number | null): string[];
  getAllEdges(valueList: string[]): number[];
  getNextEdge(time: number, direction: number, valueList: string[]): number | null;
  getNearestTransition(time: number | null): [number, string] | null;

  renderWaveform(): void;
  handleValueLink(time: number, snapToTime: number): void;
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
    let result = `<div class="value-display-item ${selectorClass} ${height}" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}></div>`;
    return result;
  }

  public createViewportElement(rowId: number) {
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal-separator",
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    }).replace(/\s/g, '%x20')}`;
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}
}

export class VariableItem extends SignalItem implements RowItem {

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
    public scopePath: string,
    public signalWidth: number,
    public variableType: string,
    public encoding: string,
    public renderType: WaveformRenderer,
    public enumType: string,
  ) {
    super();

    this.customName = this.signalName;
    if (this.encoding === "String") {
      this.valueFormat = formatString;
      this.colorIndex  = 1;
    } else if (this.encoding === "Real") {
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
      const scopePath = htmlSafe(this.scopePath + '.');
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
    const scopePath     = htmlSafe(this.scopePath + '.');
    const fullPath      = htmlAttributeSafe(scopePath + signalName);
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
    const canvasHeight = (this.rowHeight * WAVE_HEIGHT) - 8;
    if (this.ctx) {
      viewport.resizeCanvas(canvas, this.ctx, viewport.viewerWidth, canvasHeight);
    }
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.appendChild(canvas);
    waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public isAnalogSignal() {return this.renderType.id === 'linear' || this.renderType.id === 'linearSigned' ||
                            this.renderType.id === 'stepped' || this.renderType.id === 'steppedSigned';}

  public setSignalContextAttribute() {
    const renderType = this.renderType.id;
    const isAnalog = this.isAnalogSignal();
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal",
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      commandValid: this.valueLinkCommand !== "",
      netlistId: this.netlistId,
      rowId: this.rowId,
      isAnalog: isAnalog,
      enum: this.enumType !== "",
    }).replace(/\s/g, '%x20')}`;
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
    this.renderType.draw(valueChangeChunk, this, viewport);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number | null) {
    return dataManager.getValueAtTime(this.signalId, time);
  }

  public getNearestTransition(time: number | null) {
    return dataManager.getNearestTransition(this.signalId, time);
  }

  public setColorFromColorIndex() {
    this.color = getColorFromColorIndex(this.colorIndex);
  }

  public getAllEdges(valueList: string[]): number[] {
    return dataManager.getAllEdges(valueList, this.signalId, this.signalWidth);
  }

  public getNextEdge(time: number, direction: number, valueList: string[]): number | null {
    return dataManager.getNextEdge(this.signalId, time, direction, valueList);
  }

  public resize() {
    if (!this.canvas || !this.ctx) {return;}
    const canvasHeight = (this.rowHeight * WAVE_HEIGHT) - 8;
    viewport.resizeCanvas(this.canvas, this.ctx, viewport.viewerWidth, canvasHeight);
  }

  handleValueLinkMouseOver(event: MouseEvent) {
    mouseOverHandler(event, this, true);
  }

  handleValueLinkMouseExit(event: MouseEvent) {
    mouseOverHandler(event, this, false);
  }

  handleValueLink(time: number, snapToTime: number): boolean {

    if (this.valueLinkCommand === "") {return false;}
    if (this.renderType.id !== 'multiBit') {return false;}
    if (this.valueLinkIndex < 0) {return false;}
    if (time !== snapToTime) {return false;}

    const command        = this.valueLinkCommand;
    const signalId       = this.signalId;
    const index          = dataManager.getNearestTransitionIndex(signalId, time) - 1;
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

    vscode.postMessage({ command: 'executeCommand', commandName: command, args: [event] });
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
    let icon = this.collapseState === CollapseState.Expanded ? 
      'codicon-chevron-down' : 'codicon-chevron-right';
    return `<div class='codicon ${icon}'></div><p>${this.label}</p>`;
  }

  public createLabelElement() {

    let childElements = '';
    let icon = 'codicon-chevron-right';
    let groupClass = 'collapsed-group';
    if (this.collapseState === CollapseState.Expanded) {
      this.children.forEach((childRowId) => {
        const signalItem = dataManager.rowItems[childRowId];
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
        const signalItem = dataManager.rowItems[childRowId];
        result += signalItem.createValueDisplayElement();
      });
    }
    return result;
  }

  public createViewportElement(rowId: number) {
    const waveformContainer = document.createElement('div');
    waveformContainer.setAttribute('id', 'waveform-' + rowId);
    waveformContainer.classList.add('waveform-container');
    waveformContainer.setAttribute("data-vscode-context", this.vscodeContext);
    this.viewportElement = waveformContainer;
  }

  public setSignalContextAttribute() {
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal-group",
      groupId: this.groupId,
      rowId: this.rowId,
      preventDefaultContextMenuItems: true,
    }).replace(/\s/g, '%x20')}`;
  }

  getLabelText(): string {return this.label;}
  setLabelText(newLabel: string) {this.label = newLabel;}

  public getFlattenedRowIdList(ignoreCollapsed: boolean, ignoreRowId: number): number[] {
    let result: number[] = [this.rowId];
    if (!ignoreCollapsed || this.collapseState === CollapseState.Expanded) {
      this.children.forEach((rowId) => {
        if (rowId === ignoreRowId) {return;} // Skip the ignored rowId
        const signalItem = dataManager.rowItems[rowId];
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
        const signalItem = dataManager.rowItems[rowId];
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
      const signalItem = dataManager.rowItems[childRowId];
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
      const childRowItem = dataManager.rowItems[rowId];
      if (!childRowItem) {return;}
      childRows = childRows.concat(childRowItem.getFlattenedRowIdList(true, -1));
    });
    childRows.forEach((rowId) => {
      if (rowId === this.rowId) {return;} // Skip the group row itself
      const viewportRow = document.getElementById(`waveform-${rowId}`);
      if (!viewportRow) {return;}
      viewportRow.style.display = style;
      const signalItem = dataManager.rowItems[rowId];
      if (signalItem instanceof VariableItem) {
        signalItem.wasRendered = false; // Reset rendering state for child signals
      }
      viewport.updateBackgroundCanvas(true);
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