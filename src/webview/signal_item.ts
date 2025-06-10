import { dataManager, viewport, CollapseState } from "./vaporview";
import { formatBinary, formatHex, formatString, ValueFormat } from "./value_format";
import { WaveformRenderer } from "./renderer";
import { customColorKey } from "./data_manager";

export function htmlSafe(string: string) {
  return string.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function htmlAttributeSafe(string: string) {
  return string.replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export abstract class SignalItem {

  public labelElement: HTMLElement | null = null
  public valueDisplayElement: HTMLElement | null = null
  public viewportElement: HTMLElement | null = null
  public vscodeContext: string = "";
  public wasRendered: boolean = false;

  public abstract createLabelElement(isSelected: boolean)
  public abstract createValueDisplayElement(value: any, isSelected: boolean)
  public abstract getValueAtTime(time: number): string[]
  public getNearestTransition(time: number) {return null}
  public renderWaveform() {return;}
  public abstract resize()
}

export class VariableItem extends SignalItem {

  public valueFormat: ValueFormat;
  public valueLinkCommand: string = "";
  public valueLinkBounds: [number, number][] = [];
  public valueLinkIndex: number = -1;
  public colorIndex: number = 0;
  public color: string = "";
  public formattedValues: string[] = [];
  public formatValid: boolean = false;
  public wasRendered: boolean = false;
  public canvas: HTMLCanvasElement | null = null
  public ctx: CanvasRenderingContext2D | null = null

  constructor(
    public netlistId: number,
    public signalId: number,
    public signalName: string,
    public scopePath: string,
    public signalWidth: number,
    public variableType: string,
    public encoding: string,
    public renderType: WaveformRenderer,
  ) {
    super();

    if (this.encoding === "String") {
      this.valueFormat = formatString;
      this.colorIndex  = 1;
    } else if (this.encoding === "Real") {
      this.valueFormat = formatString;
    } else {
      this.valueFormat = this.signalWidth === 1 ? formatBinary : formatHex;
    }
    this.setSignalContextAttribute();
    this.setColorFromColorIndex();
  }

  public createLabelElement(isSelected: boolean) {

    const rowId         = dataManager.netlistIdTable[this.netlistId];
    const selectorClass = isSelected ? 'is-selected' : '';
    const signalName    = htmlSafe(this.signalName);
    const scopePath     = htmlSafe(this.scopePath + '.');
    const fullPath      = htmlAttributeSafe(scopePath + signalName);
    const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label is-idle ${selectorClass}" id="label-${rowId}" title="${tooltip}" data-vscode-context=${this.vscodeContext}>
              <div class='codicon codicon-grabber'></div>
              <p style="opacity:50%">${scopePath}</p><p>${signalName}</p>
            </div>`;
    }

  public createValueDisplayElement(value: any, isSelected: boolean) {
    if (value === undefined) {value = [];}

    const rowId         = dataManager.netlistIdTable[this.netlistId];
    const selectorClass = isSelected ? 'is-selected' : 'is-idle';
    const joinString    = '<p style="color:var(--vscode-foreground)">-></p>';
    const parseValue    = this.valueFormat.formatString;
    const valueIs9State = this.valueFormat.is9State;
    const pElement      = value.map((v: string) => {
      const is9State     = valueIs9State(v);
      const colorStyle   = is9State ? 'var(--vscode-debugTokenExpression-error)' : this.color;
      const displayValue = parseValue(v, this.signalWidth, !is9State);
      return `<p style="color:${colorStyle}">${displayValue}</p>`;
    }).join(joinString);

    return `<div class="waveform-label ${selectorClass}" id="value-${rowId}" data-vscode-context=${this.vscodeContext}>${pElement}</div>`;
  }

  public setSignalContextAttribute() {
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal",
      scopePath: this.scopePath,
      signalName: this.signalName,
      type: this.variableType,
      width: this.signalWidth,
      preventDefaultContextMenuItems: true,
      commandValid: this.valueLinkCommand !== "",
      netlistId: this.netlistId,
    }).replace(/\s/g, '%x20')}`;
  }

  public renderWaveform() {
    const signalId = this.signalId;
    const data     = dataManager.valueChangeData[signalId];

    if (!data) {return;}
    if (!this.ctx) {return;}

    // find the closest timestampt to timeScrollLeft
    const valueChanges = data.transitionData;
    const startIndex   = Math.max(dataManager.binarySearch(valueChanges, viewport.timeScrollLeft - (2 * viewport.pixelTime)), 1);
    const endIndex     = dataManager.binarySearch(valueChanges, viewport.timeScrollRight);
    const initialState = valueChanges[startIndex - 1];
    let   postState    = valueChanges[endIndex];

    if (endIndex >= valueChanges.length) {
      postState = [viewport.viewerWidth * viewport.pixelTime, ''];
    }

    const valueChangeChunk = {
      valueChanges: valueChanges,
      startIndex: startIndex,
      endIndex: endIndex,
      initialState: initialState,
      postState: postState,
      encoding: this.encoding,
      signalWidth: this.signalWidth,
      min: data.min,
      max: data.max,
    };
  
    // I should probably move this functionally into the data manager
    if (this.encoding !== "Real") {
      if (this.renderType.id === 'steppedSigned' || this.renderType.id === 'linearSigned') {
        valueChangeChunk.min = Math.max(-Math.pow(2, this.signalWidth - 1), -128);
        valueChangeChunk.max = Math.min(Math.pow(2, this.signalWidth - 1) - 1, 127);
      } else {
        valueChangeChunk.min = 0;
        valueChangeChunk.max = Math.min(Math.pow(2, this.signalWidth) - 1, 255);
      }
    }

    this.renderType.draw(valueChangeChunk, this, viewport);
    this.wasRendered = true;
  }

  public getValueAtTime(time: number) {
  
    const result: string[] = [];
    const signalId = this.signalId;
    const data     = dataManager.valueChangeData[signalId];
  
    if (!data) {return result;}
  
    const transitionData  = data.transitionData;
    const transitionIndex = dataManager.getNearestTransitionIndex(signalId, time);

    if (transitionIndex === -1) {return result;}
    if (transitionIndex > 0) {
      result.push(transitionData[transitionIndex - 1][1]);
    }
  
    if (transitionData[transitionIndex][0] === time) {
      result.push(transitionData[transitionIndex][1]);
    }
  
    return result;
  }

  public getNearestTransition(time: number) {

    const signalId = this.signalId;
    const result = null;
    if (time === null) {return result;}

    const data  = dataManager.valueChangeData[signalId].transitionData;
    const index = dataManager.getNearestTransitionIndex(signalId, time);
    
    if (index === -1) {return result;}
    if (data[index][0] === time) {
      return data[index];
    }
  
    const timeBefore = time - data[index - 1][0];
    const timeAfter  = data[index][0] - time;
  
    if (timeBefore < timeAfter) {
      return data[index - 1];
    } else {
      return data[index];
    }
  }

  public setColorFromColorIndex() {
    const colorIndex = this.colorIndex;
    if (colorIndex < 4) {
      this.color = viewport.colorKey[colorIndex];
    } else {
      this.color = customColorKey[colorIndex - 4];
    }
  }

  public async cacheValueFormat() {
    return new Promise<void>((resolve) => {
      const valueChangeData = dataManager.valueChangeData[this.signalId];
      if (valueChangeData === undefined)            {resolve(); return;}
      if (this.renderType.id !== "multiBit") {resolve(); return;}
      if (this.formatValid)                  {resolve(); return;}

      this.formattedValues = valueChangeData.transitionData.map(([, value]) => {
        const is9State = this.valueFormat.is9State(value);
        return this.valueFormat.formatString(value, this.signalWidth, !is9State);
      });
      this.formatValid = true;
      resolve();
      return;
    });
  }

  public resize() {
    if (!this.canvas || !this.ctx) {return;}
    viewport.resizeCanvas(this.canvas, this.ctx, viewport.viewerWidth, 20);
  }
}

export class SignalGroup extends SignalItem {

  public collapseState: CollapseState = CollapseState.Expanded;
  public children: SignalItem[] = [];

  constructor(
    public rowId: number,
    public label: string
  ) {super();}

  public createLabelElement(isSelected: boolean) {

    const selectorClass = isSelected ? 'is-selected' : '';
    //const tooltip       = "Name: " + fullPath + "\nType: " + this.variableType + "\nWidth: " + this.signalWidth + "\nEncoding: " + this.encoding;
    return `<div class="waveform-label is-idle ${selectorClass}" id="label-${this.rowId}" data-vscode-context=${this.vscodeContext}>
              <div class='codicon codicon-grabber'></div>
              <p>${this.label}</p>
            </div>`;
    }

  public createValueDisplayElement(value: any, isSelected: boolean) {

    const selectorClass = isSelected ? 'is-selected' : 'is-idle';
    return `<div class="waveform-label ${selectorClass}" id="value-${this.rowId}" data-vscode-context=${this.vscodeContext}></div>`;
  }

  public setSignalContextAttribute() {
    this.vscodeContext = `${JSON.stringify({
      webviewSection: "signal-group",
      preventDefaultContextMenuItems: true,
      rowId: this.rowId,
    }).replace(/\s/g, '%x20')}`;
  }

  public expand() {
    this.collapseState = CollapseState.Expanded;
    
  }

  //public renderWaveform() {this.wasRendered = true;}
  public getValueAtTime(time: number): string[] {return [""];}
  public setColorFromColorIndex() {return;}
  public async cacheValueFormat() {return new Promise<void>((resolve) => {return;});}
  public resize() {return;}
}