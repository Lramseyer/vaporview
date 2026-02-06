import { vscode, viewerState, dataManager, ValueChange } from "./vaporview";
import { NetlistVariable } from "./signal_item";

// Maximum number of transitions to display
// Maybe I should make dataManager a user setting in the future...
const MAX_TRANSITIONS = 32;

export function copyWaveDrom() {

  // Marker and alt marker need to be set
  if (viewerState.markerTime === null ||viewerState. altMarkerTime === null) {
    //vscode.window.showErrorMessage('Please use the marker and alt marker to set time window for waveform data.');
    return;
  }

  const timeWindow   = [viewerState.markerTime, viewerState.altMarkerTime].sort((a, b) => a - b);
  let allTransitions: any = [];

  // Populate the waveDrom names with the selected signals
  const waveDromData: any = {};
  viewerState.displayedSignalsFlat.forEach((rowId) => {

    const netlistItem: any = dataManager.rowItems[rowId];
    if (netlistItem === undefined || netlistItem instanceof NetlistVariable === false) {return;}
    const netlistId       = netlistItem.netlistId;
    const signalName      = netlistItem.scopePath + "." + netlistItem.signalName;
    const signalId        = netlistItem.signalId;
    const transitionData  = dataManager.valueChangeData[signalId].valueChangeData;
    const lowerBound      = dataManager.binarySearch(transitionData, timeWindow[0]) - 1;
    const upperBound      = dataManager.binarySearch(transitionData, timeWindow[1]) + 2;
    const signalDataChunk = transitionData.slice(lowerBound, upperBound);
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

  if (dataManager.waveDromClock.netlistId === null) {

    allTransitions = allTransitions.sort((a: ValueChange, b: ValueChange) => a[0] - b[0]);

    for (let index = 0; index < allTransitions.length; index++) {
      const time      = allTransitions[index][0];
      const state     = allTransitions[index][1];
      const netlistId = allTransitions[index][2];
      if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
      if (time !== currentTime) {
        currentTime = time;
        transitionCount++;
        viewerState.displayedSignalsFlat.forEach((rowId) => {
          const varItem = dataManager.rowItems[rowId];
          if (varItem instanceof NetlistVariable === false) {return;}
          const n = dataManager.rowItems[rowId].netlistId;
          if (n === undefined) {return;}
          const signal = waveDromData[n];
          const parseValue = varItem.valueFormat.formatString;
          const valueIs9State = varItem.valueFormat.is9State;
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
    const clockEdges = waveDromData[dataManager.waveDromClock.netlistId].signalData.filter((t: ValueChange) => t[1] === dataManager.waveDromClock.edge);
    const edge       = dataManager.waveDromClock.edge === '1' ? "p" : "n";
    let nextEdge = Infinity;
    for (let index = 0; index < clockEdges.length; index++) {
      const currentTime = clockEdges[index][0];
      if (index === clockEdges.length - 1) {nextEdge = timeWindow[1];}
      else {nextEdge    = clockEdges[index + 1][0];}
      if (currentTime >= timeWindow[1] || transitionCount >= MAX_TRANSITIONS) {break;}
      viewerState.displayedSignalsFlat.forEach((rowId) => {

        const varItem = dataManager.rowItems[rowId];
        if (varItem instanceof NetlistVariable === false) {return;}
        const n = varItem.netlistId;
        const signal = waveDromData[n];
        const signalData = signal.signalData;
        const parseValue = varItem.valueFormat.formatString;
        const valueIs9State = varItem.valueFormat.is9State;
        if (n === dataManager.waveDromClock.netlistId) {signal.json.wave += edge;}
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
  viewerState.displayedSignalsFlat.forEach((rowId) => {
    const netlistId = dataManager.rowItems[rowId].netlistId;
    if (netlistId === undefined || waveDromData[netlistId] === undefined) {return;}
    const signalData = waveDromData[netlistId].json;
    result += '  ' + JSON.stringify(signalData) + ',\n';
  });
  result += ']}';

  if (transitionCount >= MAX_TRANSITIONS) {
    vscode.postMessage({
      command: 'showMessage',
      messageType: 'warning',
      message: 'The number of transitions exceeds the maximum limit of ' + MAX_TRANSITIONS,
    });
  }
  vscode.postMessage({command: 'copyToClipboard', text: result});
  vscode.postMessage({command: 'showMessage',  message: 'WaveDrom JSON copied to clipboard.'});
}