import { NetlistData, SignalId, NetlistId, WaveformData, ValueChange, EventHandler, viewerState, ActionType, vscode, viewport } from './vaporview';
import { formatBinary, formatHex, ValueFormat, formatString, valueFormatList } from './value_format';
import { WaveformRenderer, multiBitWaveformRenderer, binaryWaveformRenderer } from './renderer';

export class WaveformDataManager {
  requested: SignalId[] = [];
  queued:    SignalId[] = [];
  requestActive: boolean = false;

  valueChangeData: WaveformData[] = [];
  netlistData: NetlistData[]      = [];
  valueChangeDataTemp: any        = [];

  contentArea: HTMLElement = document.getElementById('contentArea')!;

  waveDromClock = {
    netlistId: null,
    edge: '1',
  };

  constructor(private events: EventHandler) {
    this.contentArea = document.getElementById('contentArea')!;

    if (this.contentArea === null) {throw new Error("Could not find contentArea");}
  }

  unload() {
    this.valueChangeData     = [];
    this.netlistData         = [];
    this.valueChangeDataTemp = {};
    this.waveDromClock       = {netlistId: null, edge: ""};
  }

  // This is a simple queue to handle the fetching of waveform data
  // It's overkill for everything except large FST waveform dumps with lots of
  // Value Change Blocks. Batch fetching is much faster than individual fetches,
  // so this queue will ensure that fetches are grouped while waiting for any
  // previous fetches to complete.
  request(signalIdList: SignalId[]) {
    this.queued = this.queued.concat(signalIdList);
    this.fetch();
  }

  receive(signalId: SignalId) {
    this.requested = this.requested.filter((id) => id !== signalId);
    if (this.requested.length === 0) {
      this.requestActive = false;
      this.fetch();
    }
  }

  private fetch() {
    if (this.requestActive) {return;}
    if (this.queued.length === 0) {return;}

    this.requestActive = true;
    this.requested     = this.queued;
    this.queued        = [];

    vscode.postMessage({
      command: 'fetchTransitionData',
      signalIdList: this.requested,
    });
  }

  addVariable(signalList: any) {
    // Handle rendering a signal, e.g., render the signal based on message content
    //console.log(message);

    let updateFlag      = false;
    let selectedSignal  = viewerState.selectedSignal;

    const signalIdList: any   = [];
    const netlistIdList: any = [];
    signalList.forEach((signal: any) => {

      const netlistId      = signal.netlistId;
      const signalId       = signal.signalId;

      let valueFormat;
      let color = "var(--vscode-debugTokenExpression-number)";
      if (signal.encoding === "String") {
        valueFormat = formatString;
        color = "var(--vscode-debugTokenExpression-string)";
        //color = "var(--vscode-debugTokenExpression-name)";
      } else if (signal.encoding === "Real") {
        valueFormat = formatString;
      } else {
        valueFormat = signal.signalWidth === 1 ? formatBinary : formatHex;
      }

      this.netlistData[netlistId] = {
        signalId:     signalId,
        signalWidth:  signal.signalWidth,
        signalName:   signal.signalName,
        modulePath:   signal.modulePath,
        variableType: signal.type,
        encoding:     signal.encoding,
        vscodeContext: "",
        valueFormat:  valueFormat,
        renderType:   signal.signalWidth === 1 ? binaryWaveformRenderer : multiBitWaveformRenderer,
        textWidth:    0,
        color:        color,
      };
      this.netlistData[netlistId].textWidth = this.netlistData[netlistId].valueFormat.getTextWidth(this.netlistData[netlistId].signalWidth);
      this.netlistData[netlistId].vscodeContext = this.setSignalContextAttribute(netlistId);
      netlistIdList.push(netlistId);

      if (this.valueChangeData[signalId] !== undefined) {
        selectedSignal = netlistId;
        updateFlag     = true;
      } else if (this.valueChangeDataTemp[signalId] !== undefined) {
        this.valueChangeDataTemp[signalId].netlistIdList.push(netlistId);
      } else if (this.valueChangeDataTemp[signalId] === undefined) {
        signalIdList.push(signalId);
        this.valueChangeDataTemp[signalId] = {
          netlistIdList: [netlistId],
          totalChunks: 0,
        };
      }
    });

    this.request(signalIdList);

    viewerState.displayedSignals = viewerState.displayedSignals.concat(netlistIdList);
    this.events.dispatch(ActionType.AddVariable, netlistIdList, updateFlag);
    this.events.dispatch(ActionType.SignalSelect, selectedSignal);
  }

  udpateWaveformChunk(message: any) {

    const signalId = message.signalId;
    if (this.valueChangeDataTemp[signalId].totalChunks === 0) {
      this.valueChangeDataTemp[signalId].totalChunks = message.totalChunks;
      this.valueChangeDataTemp[signalId].chunkLoaded = new Array(message.totalChunks).fill(false);
      this.valueChangeDataTemp[signalId].chunkData   = new Array(message.totalChunks).fill("");
    }

    this.valueChangeDataTemp[signalId].chunkData[message.chunkNum]   = message.transitionDataChunk;
    this.valueChangeDataTemp[signalId].chunkLoaded[message.chunkNum] = true;
    const allChunksLoaded = this.valueChangeDataTemp[signalId].chunkLoaded.every((chunk: any) => {return chunk;});

    if (!allChunksLoaded) {return;}

    //console.log('all chunks loaded');

    this.receive(signalId);

    const netlistIdList = this.valueChangeDataTemp[signalId].netlistIdList;
    const netlistId     = netlistIdList[0];
    if (netlistId ===  undefined) {console.log('netlistId not found for signalId ' + signalId); return;}
    const signalWidth  = this.netlistData[netlistId].signalWidth;
    const nullValue = "x".repeat(signalWidth);
    const transitionData = JSON.parse(this.valueChangeDataTemp[signalId].chunkData.join(""));
    if (transitionData[0][0] !== 0) {
      transitionData.unshift([0, nullValue]);
    }
    if (transitionData[transitionData.length - 1][0] !== viewport.timeStop) {
      transitionData.push([viewport.timeStop, nullValue]);
    }
    this.valueChangeData[signalId] = {
      transitionData: transitionData,
      signalWidth:    signalWidth,
      chunkStart:     [],
    };

    // Create ChunkStart array
    this.valueChangeData[signalId].chunkStart = new Array(viewport.chunkCount).fill(transitionData.length);
    let chunkIndex = 0;
    for (let i = 0; i < transitionData.length; i++) {
      while (transitionData[i][0] >= viewport.chunkTime * chunkIndex) {
        this.valueChangeData[signalId].chunkStart[chunkIndex] = i;
        chunkIndex++;
      }
    }
    this.valueChangeData[signalId].chunkStart[0] = 1;
    this.valueChangeDataTemp[signalId] = undefined;

    this.contentArea.style.height = (40 + (28 * viewerState.displayedSignals.length)) + "px";

    netlistIdList.forEach((netlistId: NetlistId) => {
      this.events.dispatch(ActionType.RedrawVariable, netlistId);
    });
  }

  setDisplayFormat(message: any) {

    const netlistId = message.netlistId;
    if (message.netlistId === undefined) {return;}
    if (this.netlistData[netlistId] === undefined) {return;}

    if (message.numberFormat !== undefined) {
      let valueFormat = valueFormatList.find((format) => format.id === message.numberFormat);
      if (valueFormat === undefined) {valueFormat = formatBinary;}
      this.netlistData[netlistId].valueFormat   = valueFormat;
      this.netlistData[netlistId].textWidth     = valueFormat.getTextWidth(this.netlistData[netlistId].signalWidth);
    }

    if (message.color !== undefined) {
      this.netlistData[netlistId].color = message.color;
    }

    //if (message.renderType !== undefined) {
    //  this.netlistData[netlistId].renderType = message.renderType;
    //}

    this.netlistData[netlistId].vscodeContext = this.setSignalContextAttribute(netlistId);
    this.events.dispatch(ActionType.RedrawVariable, netlistId);
  }

  setSignalContextAttribute(netlistId: NetlistId) {
    const width        = this.netlistData[netlistId].signalWidth;
    const modulePath   = this.netlistData[netlistId].modulePath;
    const signalName   = this.netlistData[netlistId].signalName;
    //const attribute    = `data-vscode-context=${JSON.stringify({
      const attribute    = `${JSON.stringify({
      webviewSection: "signal",
      modulePath: modulePath,
      signalName: signalName,
      width: width,
      preventDefaultContextMenuItems: true,
      netlistId: netlistId,
    }).replace(/\s/g, '%x20')}`;
    return attribute;
  }

  getNearestTransitionIndex(signalId: SignalId, time: number) {

    if (time === null) {return -1;}
  
    let endIndex;
    const data        = this.valueChangeData[signalId];
    const chunk       = Math.floor(time / viewport.chunkTime);
    const startIndex  = Math.max(0, data.chunkStart[chunk] - 1);
    if (chunk === viewport.chunkCount - 1) {
      endIndex    = data.transitionData.length;
    } else {
      endIndex    = data.chunkStart[chunk + 1] + 1;
    }
    const searchIndex = data.transitionData.slice(startIndex, endIndex).findIndex(([t, v]) => {return t >= time;});
    const transitionIndex = startIndex + searchIndex;
  
    if (searchIndex === -1) {
      console.log('search found a -1 index');
      return -1;
    }
  
    return transitionIndex;
  }

  getValueAtTime(netlistId: NetlistId, time: number) {

    const result: string[] = [];
    const signalId = this.netlistData[netlistId].signalId;
    const data     = this.valueChangeData[signalId];
  
    if (!data) {return result;}
  
    const transitionData  = data.transitionData;
    const transitionIndex = this.getNearestTransitionIndex(signalId, time);
  
    if (transitionIndex === -1) {return result;}
    if (transitionIndex > 0) {
      result.push(transitionData[transitionIndex - 1][1]);
    }
  
    if (transitionData[transitionIndex][0] === time) {
      result.push(transitionData[transitionIndex][1]);
    }
  
    return result;
  }

  getNearestTransition(netlistId: NetlistId, time: number) {

    const signalId = this.netlistData[netlistId].signalId;
    const result = null;
    if (time === null) {return result;}

    const data  = this.valueChangeData[signalId].transitionData;
    const index = this.getNearestTransitionIndex(signalId, time);
    
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

  copyWaveDrom() {

    // Maximum number of transitions to display
    // Maybe I should make this a user setting in the future...
    const MAX_TRANSITIONS = 32;
  
    // Marker and alt marker need to be set
    if (viewerState.markerTime === null ||viewerState. altMarkerTime === null) {
      //vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
      return;
    }

    const timeWindow   = [viewerState.markerTime, viewerState.altMarkerTime].sort((a, b) => a - b);
    const chunkWindow  = [Math.floor(timeWindow[0] / viewport.chunkTime), Math.ceil(timeWindow[1] / viewport.chunkTime)];
    let allTransitions: any = [];
  
    // Populate the waveDrom names with the selected signals
    const waveDromData: any = {};
    viewerState.displayedSignals.forEach((netlistId) => {
      const netlistItem: any     = this.netlistData[netlistId];
      const signalName      = netlistItem.modulePath + "." + netlistItem.signalName;
      const signalId        = netlistItem.signalId;
      const transitionData  = this.valueChangeData[signalId].transitionData;
      const chunkStart      = this.valueChangeData[signalId].chunkStart;
      const signalDataChunk = transitionData.slice(Math.max(0, chunkStart[chunkWindow[0]] - 1), chunkStart[chunkWindow[1]]);
      let   initialState = "x";
      const json: any       = {name: signalName, wave: ""};
      const signalDataTrimmed: any[] = [];
      if (netlistItem.signalWidth > 1) {json.data = [];}
  
      signalDataChunk.forEach((transition: any) => {
        if (transition[0] <= timeWindow[0]) {initialState = transition[1];}
        if (transition[0] >= timeWindow[0] && transition[0] <= timeWindow[1]) {signalDataTrimmed.push(transition);}
      });
  
      waveDromData[netlistId] = {json: json, signalData: signalDataTrimmed, signalWidth: netlistItem.signalWidth, initialState: initialState};
      const taggedTransitions: any = signalDataTrimmed.map(t => [t[0], t[1], netlistId]);
      allTransitions = allTransitions.concat(taggedTransitions);
    });
  
    let currentTime = timeWindow[0];
    let transitionCount = 0;
  
    if (this.waveDromClock.netlistId === null) {
  
      allTransitions = allTransitions.sort((a: ValueChange, b: ValueChange) => a[0] - b[0]);
  
      for (let index = 0; index < allTransitions.length; index++) {
        const time      = allTransitions[index][0];
        const state     = allTransitions[index][1];
        const netlistId = allTransitions[index][2];
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        if (time !== currentTime) {
          currentTime = time;
          transitionCount++;
          viewerState.displayedSignals.forEach((n) => {
            const signal = waveDromData[n];
            const parseValue = this.netlistData[n].valueFormat.formatString;
            const valueIs9State = this.netlistData[n].valueFormat.is9State;
            if (signal.initialState === null) {signal.json.wave += '.';}
            else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(signal.initialState);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(signal.initialState, signal.signalWidth, !is4State));
              } else {
                signal.json.wave += signal.initialState;
              }
            }
            signal.initialState = null;
          });
        }
        waveDromData[netlistId].initialState = state;
      }
    } else {
      const clockEdges = waveDromData[this.waveDromClock.netlistId].signalData.filter((t: ValueChange) => t[1] === this.waveDromClock.edge);
      const edge       = this.waveDromClock.edge === '1' ? "p" : "n";
      let nextEdge = Infinity;
      for (let index = 0; index < clockEdges.length; index++) {
        const currentTime = clockEdges[index][0];
        if (index === clockEdges.length - 1) {nextEdge = timeWindow[1];}
        else {nextEdge    = clockEdges[index + 1][0];}
        if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
        viewerState.displayedSignals.forEach((n) => {
          const signal = waveDromData[n];
          const signalData = signal.signalData;
          const parseValue = this.netlistData[n].valueFormat.formatString;
          const valueIs9State = this.netlistData[n].valueFormat.is9State;
          if (n === this.waveDromClock.netlistId) {signal.json.wave += edge;}
          else {
            let transition = signalData.find((t: ValueChange) => t[0] >= currentTime && t[0] < nextEdge);
            if (!transition && index === 0) {transition = [currentTime, signal.initialState];}
            if (!transition && index > 0) {
              signal.json.wave += '.';
            } else {
              if (signal.signalWidth > 1) {
                const is4State = valueIs9State(transition[1]);
                signal.json.wave += is4State ? "9" : "7";
                signal.json.data.push(parseValue(transition[1], signal.signalWidth, !is4State));
              } else {
                signal.json.wave += transition[1];
              }
            }
            signal.initialState = undefined;
          }
        });
        transitionCount++;
      }
    }
  
    //console.log(waveDromData);
  
    // write the waveDrom JSON to the clipboard
    let result = '{"signal": [\n';
    viewerState.displayedSignals.forEach((netlistId) => {
      const signalData = waveDromData[netlistId].json;
      result += '  ' + JSON.stringify(signalData) + ',\n';
    });
    result += ']}';
  
    vscode.postMessage({
      command: 'copyWaveDrom',
      waveDromJson: result,
      maxTransitionsFlag: transitionCount >= MAX_TRANSITIONS,
      maxTransitions: MAX_TRANSITIONS
    });
  }
}