import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from 'readline';
import { promisify } from 'util';
import { byte } from '@vscode/wasm-component-model';

import {NetlistIdRef, NetlistIdTable, NetlistItem, NetlistTreeDataProvider, WaveformTop} from './extension';

// Simple string hashing algorithm
function hashCode(s: string) {
  const num = s.split("").reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return Math.abs(num).toString(36);
}

function newHashCode(s: string, hashTable: Map<string, NetlistIdRef>) {
  let hash          = '';
  let hashCollision = true;

  while (hash.length === 0 || hashCollision) {
    hash          = hashCode(s + hash).toString();
    hashCollision = hashTable.has(hash);
  }

  return hash;
}

export async function parseVcdNetlist(fd: number, netlistTreeDataProvider: NetlistTreeDataProvider, waveformDataSet: WaveformTop, netlistIdTable: NetlistIdTable) {

  const read = promisify(fs.read);
  // Define a data structure to store the netlist items
  const netlistItems: NetlistItem[] = [];
  const moduleStack:  NetlistItem[] = [];
  const modulePath:   string[]      = [];
  let modulePathString = "";
  let currentScope:   NetlistItem | undefined;
  let currentSignal = "";
  let currentMode: string | undefined = undefined;

  let fileOffset = 0;
  let leftover   = '';
  let byteOffset = 0;
  let lineNum    = 0;
  let moduleCount = 0;
  let signalCount = 0;
  let timeZeroOffset = 0;

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const buffer     = Buffer.alloc(CHUNK_SIZE);
  const metadata   = waveformDataSet.metadata;
  const totalSize  = metadata.fileSize;

  fileOffset = 0;
  byteOffset = 0;
  while (fileOffset < totalSize) {
    const { bytesRead } = await read(fd, buffer, 0, CHUNK_SIZE, fileOffset);
    if (bytesRead === 0) break;

    fileOffset += bytesRead;
    const chunk = leftover + buffer.toString('ascii', 0, bytesRead);
    const lines = chunk.split('\n');
    leftover = lines.pop() || '';

    for (const line of lines) {
      lineNum++;

      // Remove leading and trailing whitespace
      const cleanedLine = line.trim();

      if (cleanedLine.startsWith('$scope')) {
        moduleCount++;
        currentMode   = 'scope';
        currentSignal = "";
        // Extract the current scope
        const scopeData = cleanedLine.split(/\s+/);
        const scopeType = scopeData[1];
        const scopeName = scopeData[2];
        let iconColor = new vscode.ThemeColor('charts.white');
        let iconType  = 'symbol-module';
        if (scopeType === 'module') {
          iconColor   = new vscode.ThemeColor('charts.purple');
          iconType    = 'chip';
        } else if (scopeType === 'function') {
          iconColor   = new vscode.ThemeColor('charts.yellow');
        }
        const netlistId   = newHashCode(modulePathString + "." + scopeName, netlistIdTable);
        const newScope    = new NetlistItem(scopeName, 'module', 0, '', netlistId, '', modulePathString, [], vscode.TreeItemCollapsibleState.Collapsed);
        newScope.iconPath = new vscode.ThemeIcon(iconType, iconColor);
        modulePath.push(scopeName);
        modulePathString = modulePath.join(".");
        if (currentScope) {
          currentScope.children.push(newScope); // Add the new scope as a child of the current scope
        } else {
          netlistItems.push(newScope); // If there's no current scope, add it to the netlistItems
        }
        // Push the new scope onto the moduleStack and set it as the current scope
        moduleStack.push(newScope);
        currentScope = newScope;

      } else if (cleanedLine.startsWith('$upscope')) {
        moduleStack.pop(); // Pop the current scope from the moduleStack
        modulePath.pop();
        currentScope     = moduleStack[moduleStack.length - 1]; // Update th current scope to the parent scope
        modulePathString = modulePath.join(".");
        currentSignal    = "";
      } else if (cleanedLine.startsWith('$var') && currentMode === 'scope') {
        signalCount++;
        // Extract signal information (signal type and name)
        //const varMatch = cleanedLine.match(/\$var\s+(wire|reg|integer|parameter|real)\s+(1|[\d+:]+)\s+(\w+)\s+(\w+(\[\d+)?(:\d+)?\]?)\s\$end/);
        if (currentScope) {
          const varData             = cleanedLine.split(/\s+/);
          const signalType          = varData[1];
          const signalSize          = parseInt(varData[2], 10);
          const signalID            = varData[3];
          const signalNameWithField = varData[4];
          const signalName          = signalNameWithField.split('[')[0];
          const netlistId           = newHashCode(modulePathString + "." + signalNameWithField, netlistIdTable);
          
          if (signalName !== currentSignal) {
            // Create a NetlistItem for the signal and add it to the current scope
            const signalItem = new NetlistItem(signalNameWithField, signalType, signalSize, signalID, netlistId, signalName, modulePathString, [], vscode.TreeItemCollapsibleState.None, vscode.TreeItemCheckboxState.Unchecked);

            // Assign an icon to the signal based on its type
            if ((signalType === 'wire') || (signalType === 'reg')) {
              if (signalSize > 1) {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-array', new vscode.ThemeColor('charts.green'));
              } else {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.pink'));
              }
            } else if (signalType === 'integer') {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('charts.blue'));
            } else if (signalType === 'parameter') {
                signalItem.iconPath = new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.orange'));
            } else if (signalType === 'real') {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-constant', new vscode.ThemeColor('charts.purple'));
            }

            currentScope.children.push(signalItem);
            netlistIdTable.set(netlistId, {netlistItem: signalItem, displayedItem: undefined, signalId: signalID});
          }
          currentSignal    = signalName;
          waveformDataSet.createSignalWaveform(signalID, signalSize);
        }
      // Parse out waveform data
      } else if (cleanedLine.startsWith('$timescale')) {
        currentMode = 'timescale';
      } else if (cleanedLine.startsWith('$end')) {
        currentMode = undefined;
      } else if (cleanedLine.startsWith('#') || cleanedLine.startsWith('$dumpvars')) {
        timeZeroOffset = byteOffset;
        fileOffset     = totalSize;
        break;
      }
      if (currentMode === 'timescale') {
        const timescaleMatch = cleanedLine.match(/(\d+)\s*(\w+)/);
        if (timescaleMatch) {
          waveformDataSet.metadata.timeScale = parseInt(timescaleMatch[1]);
          waveformDataSet.metadata.timeUnit  = timescaleMatch[2];
        }
      }
      byteOffset += line.length + 1;
    }
  }

  metadata.waveformsStartOffset = timeZeroOffset;
  metadata.moduleCount          = moduleCount;
  metadata.signalCount          = signalCount;

  // Update the Netlist view with the parsed netlist data
  netlistTreeDataProvider.setTreeData(netlistItems);

  // debug
  console.log("Module count: " + moduleCount);
  console.log("Signal count: " + signalCount);
  await read(fd, buffer, 0, 256, timeZeroOffset);
  console.log(buffer.toString('ascii', 0, 256));

}

export async function parseVcdWaveforms(fd: number, waveformDataSet: WaveformTop) {
  
    const read = promisify(fs.read);

    // Define variables to track the current state
    let currentTimestamp  = 0;
    let initialState: number | string;
    const signalValues: Map<string, number | string> = new Map(); // Map to track signal values
 
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
    const buffer     = Buffer.alloc(CHUNK_SIZE);
    const metadata   = waveformDataSet.metadata;
    const totalSize  = metadata.fileSize;
    const timeZeroOffset = metadata.waveformsStartOffset;

    let fileOffset = timeZeroOffset;
    let byteOffset = fileOffset;
    let leftover   = '';
    let lineNum    = 0;

    //console.log("Parsing VCD data. File contains " + lineCount + " lines.");
  
    // Find the real minimum time step so that we can establish an apporpriate
    // chunk size We find the optimal chunk time by finding the shortest rolling
    // time step of 128 value changes in a row.
  
    //progress.report({ increment: 10, message: "Parsing Waveforms"});
  
    while (fileOffset < totalSize) {
  
      if (byteOffset + leftover.length !== fileOffset) {
        console.log("Byte offset mismatch: " + byteOffset + " + " + leftover.length + " != " + fileOffset);
      }
  
      const { bytesRead } = await read(fd, buffer, 0, CHUNK_SIZE, fileOffset);
      if (bytesRead === 0) break;
  
      fileOffset += bytesRead;
      const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      leftover = lines.pop() || '';
  
    for (const line of lines) {
      lineNum++;
  
      // Remove leading and trailing whitespace
      const cleanedLine = line.trim();
  
      if (cleanedLine.startsWith('#')) {
        // Extract timestamp
        const timestampMatch = cleanedLine.match(/#(\d+)/);
        if (timestampMatch) {
          currentTimestamp = parseInt(timestampMatch[1]);
          waveformDataSet.timeChain.push(currentTimestamp);
          waveformDataSet.timeOffset.push(byteOffset);
        }
      } else if (cleanedLine.startsWith('b')) {
        // Extract signal value
        const valueMatch = cleanedLine.match(/b([01xzXZ]*)\s+(.+)/);
        if (valueMatch) {
          const signalValue = valueMatch[1];
          const signalId    = valueMatch[2];
  
          if (currentTimestamp !== 0) {
            initialState = signalValues.get(signalId) || "x";
            waveformDataSet.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            waveformDataSet.setInitialState(signalId, signalValue);
          }
          // Update the state of the signal in the map
          signalValues.set(signalId, signalValue);
        }
      } else if (cleanedLine.match(/^[01xzXZ].+$/)) {
        // Extract signal value
        const valueMatch = cleanedLine.match(/([01xzXZ])(.+)/);
        if (valueMatch) {
          const signalValue = valueMatch[1];
          const signalId    = valueMatch[2];
  
          if (currentTimestamp !== 0) {
            initialState = signalValues.get(signalId) || "x";
            waveformDataSet.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            waveformDataSet.setInitialState(signalId, signalValue);
          }
          // Update the state of the signal in the map
          signalValues.set(signalId, signalValue);
        }
      }
      byteOffset += line.length + 1;
    }
    }
  
    // Discern Chunk size
    let minTimeStemp      = 9999999;
    const eventCount = waveformDataSet.timeChain.length;
    console.log("Event count: " + eventCount);
  
    if (eventCount <= 128) {
      minTimeStemp = waveformDataSet.timeChain[eventCount - 1];
    } else {
      for (let i = 128; i < eventCount; i++) {
        const rollingTimeStep = waveformDataSet.timeChain[i] - waveformDataSet.timeChain[i - 128];
        minTimeStemp = Math.min(rollingTimeStep, minTimeStemp);
      }
    }
  
    // Prevent weird zoom ratios causing strange floating point math errors
    minTimeStemp    = 10 ** (Math.round(Math.log10(minTimeStemp / 128)) | 0);
    const chunkTime = minTimeStemp * 128;
    waveformDataSet.metadata.chunkTime   = chunkTime;
    waveformDataSet.metadata.defaultZoom = 512 / chunkTime;
  
    let chunkIndex = 0;
    for (let i = 0; i < eventCount; i++) {
      const time = waveformDataSet.timeChain[i];
      while (time >= chunkTime * chunkIndex) {
        waveformDataSet.timeChainChunkStart.push(i);
        chunkIndex++;
      }
    }
    waveformDataSet.timeChainChunkStart.push(eventCount);
    waveformDataSet.timeOffset.push(totalSize);
  
    //console.log("File Size: " + totalSize);
    //console.log("Event count: " + eventCount);
    //console.log("Chunk time: " + chunkTime);
    //console.log("Minimum time step: " + minTimeStemp);
    //console.log(waveformDataSet.timeChainChunkStart.slice(0, Math.min(10, waveformDataSet.timeChainChunkStart.length)));
    //console.log(waveformDataSet.timeChain.slice(0, Math.min(1000, waveformDataSet.timeChain.length)));

    waveformDataSet.metadata.timeEnd = currentTimestamp + 1;
    signalValues.forEach((initialState, signalId) => {
      const postState   = 'X';
      const signalWidth = waveformDataSet.netlistElements.get(signalId)?.signalWidth || 1;
      waveformDataSet.addTransitionData(signalId, [currentTimestamp, postState.repeat(signalWidth)]);
      waveformDataSet.metadata.chunkCount = Math.ceil(waveformDataSet.metadata.timeEnd / waveformDataSet.metadata.chunkTime);
    });

    waveformDataSet.metadata.waveformsLoaded = true;
  }

export async function parseVCDDataExternal(path: string, netlistTreeDataProvider: NetlistTreeDataProvider, waveformDataSet: WaveformTop, netlistIdTable: NetlistIdTable, progress: vscode.Progress<{ message?: string; increment?: number; }>) {
  //async function parseVCDData(path: string, netlistTreeDataProvider: NetlistTreeDataProvider, waveformDataSet: WaveformTop, netlistIdTable: NetlistIdTable) {
  
    const open = promisify(fs.open);
    const read = promisify(fs.read);
    const close = promisify(fs.close);
    // Define a data structure to store the netlist items
    const netlistItems: NetlistItem[] = [];
    const moduleStack:  NetlistItem[] = [];
    const modulePath:   string[]      = [];
    let modulePathString = "";
    let currentScope:   NetlistItem | undefined;
    let currentSignal = "";
  
    // Define variables to track the current state
    let currentTimestamp  = 0;
    let initialState: number | string;
    const signalValues: Map<string, number | string> = new Map(); // Map to track signal values
  
    let currentMode: string | undefined = undefined;
  
    let fileOffset = 0;
    let leftover   = '';
    let byteOffset = 0;
    let lineNum    = 0;
    let moduleCount = 0;
    let signalCount = 0;
    let timeZeroOffset = 0;
  
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
    const buffer     = Buffer.alloc(CHUNK_SIZE);  
    const stats      = fs.statSync(path);
    const totalSize  = stats.size;
    const fd         = await open(path, 'r');
  
    fileOffset = 0;
    byteOffset = 0;
    while (fileOffset < totalSize) {
      const { bytesRead } = await read(fd, buffer, 0, CHUNK_SIZE, fileOffset);
      if (bytesRead === 0) break;
  
      fileOffset += bytesRead;
      const chunk = leftover + buffer.toString('ascii', 0, bytesRead);
      const lines = chunk.split('\n');
      leftover = lines.pop() || '';
  
    for (const line of lines) {
      lineNum++;
  
      // Remove leading and trailing whitespace
      const cleanedLine = line.trim();
  
      if (cleanedLine.startsWith('$scope')) {
        moduleCount++;
        currentMode   = 'scope';
        currentSignal = "";
        // Extract the current scope
        const scopeData = cleanedLine.split(/\s+/);
        const scopeType = scopeData[1];
        const scopeName = scopeData[2];
        let iconColor = new vscode.ThemeColor('charts.white');
        let iconType  = 'symbol-module';
        if (scopeType === 'module') {
          iconColor   = new vscode.ThemeColor('charts.purple');
          iconType    = 'chip';
        } else if (scopeType === 'function') {
          iconColor   = new vscode.ThemeColor('charts.yellow');
        }
        const netlistId   = newHashCode(modulePathString + "." + scopeName, netlistIdTable);
        const newScope    = new NetlistItem(scopeName, 'module', 0, '', netlistId, '', modulePathString, [], vscode.TreeItemCollapsibleState.Collapsed);
        newScope.iconPath = new vscode.ThemeIcon(iconType, iconColor);
        modulePath.push(scopeName);
        modulePathString = modulePath.join(".");
        if (currentScope) {
          currentScope.children.push(newScope); // Add the new scope as a child of the current scope
        } else {
          netlistItems.push(newScope); // If there's no current scope, add it to the netlistItems
        }
        // Push the new scope onto the moduleStack and set it as the current scope
        moduleStack.push(newScope);
        currentScope = newScope;
  
      } else if (cleanedLine.startsWith('$upscope')) {
        moduleStack.pop(); // Pop the current scope from the moduleStack
        modulePath.pop();
        currentScope     = moduleStack[moduleStack.length - 1]; // Update th current scope to the parent scope
        modulePathString = modulePath.join(".");
        currentSignal    = "";
      } else if (cleanedLine.startsWith('$var') && currentMode === 'scope') {
        signalCount++;
        // Extract signal information (signal type and name)
        //const varMatch = cleanedLine.match(/\$var\s+(wire|reg|integer|parameter|real)\s+(1|[\d+:]+)\s+(\w+)\s+(\w+(\[\d+)?(:\d+)?\]?)\s\$end/);
        if (currentScope) {
          const varData             = cleanedLine.split(/\s+/);
          const signalType          = varData[1];
          const signalSize          = parseInt(varData[2], 10);
          const signalID            = varData[3];
          const signalNameWithField = varData[4];
          const signalName          = signalNameWithField.split('[')[0];
          const netlistId           = newHashCode(modulePathString + "." + signalNameWithField, netlistIdTable);
          
          if (signalName !== currentSignal) {
            // Create a NetlistItem for the signal and add it to the current scope
            const signalItem = new NetlistItem(signalNameWithField, signalType, signalSize, signalID, netlistId, signalName, modulePathString, [], vscode.TreeItemCollapsibleState.None, vscode.TreeItemCheckboxState.Unchecked);
  
            // Assign an icon to the signal based on its type
            if ((signalType === 'wire') || (signalType === 'reg')) {
              if (signalSize > 1) {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-array', new vscode.ThemeColor('charts.green'));
              } else {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.pink'));
              }
            } else if (signalType === 'integer') {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-variable', new vscode.ThemeColor('charts.blue'));
            } else if (signalType === 'parameter') {
                signalItem.iconPath = new vscode.ThemeIcon('settings', new vscode.ThemeColor('charts.orange'));
            } else if (signalType === 'real') {
                signalItem.iconPath = new vscode.ThemeIcon('symbol-constant', new vscode.ThemeColor('charts.purple'));
            }
  
            currentScope.children.push(signalItem);
            netlistIdTable.set(netlistId, {netlistItem: signalItem, displayedItem: undefined, signalId: signalID});
          }
          currentSignal    = signalName;
          waveformDataSet.createSignalWaveform(signalID, signalSize);
        }
      // Parse out waveform data
      } else if (cleanedLine.startsWith('$timescale')) {
        currentMode = 'timescale';
      } else if (cleanedLine.startsWith('$end')) {
        currentMode = undefined;
      } else if (cleanedLine.startsWith('#')) {
        timeZeroOffset = byteOffset;
        fileOffset     = totalSize;
        break;
      }
      if (currentMode === 'timescale') {
        const timescaleMatch = cleanedLine.match(/(\d+)\s*(\w+)/);
        if (timescaleMatch) {
          waveformDataSet.metadata.timeScale = parseInt(timescaleMatch[1]);
          waveformDataSet.metadata.timeUnit  = timescaleMatch[2];
        }
      }
      byteOffset += line.length + 1;
    }
    }
  
    progress.report({ increment: 4, message: "Analyzing VCD File"});
  
    // Update the Netlist view with the parsed netlist data
    netlistTreeDataProvider.setTreeData(netlistItems);
  
    await read(fd, buffer, 0, 256, timeZeroOffset);
    console.log(buffer.toString('ascii', 0, 256));
  
    //console.log("Parsing VCD data. File contains " + lineCount + " lines.");
  
    // Find the real minimum time step so that we can establish an apporpriate
    // chunk size We find the optimal chunk time by finding the shortest rolling
    // time step of 128 value changes in a row.
  
    progress.report({ increment: 5, message: "Parsing VCD File"});
    progress.report({ increment: 10, message: "Parsing VCD File"});
  
  
    leftover   = '';
    fileOffset = timeZeroOffset;
    byteOffset = fileOffset;
    while (fileOffset < totalSize) {
  
      if (byteOffset + leftover.length !== fileOffset) {
        console.log("Byte offset mismatch: " + byteOffset + " + " + leftover.length + " != " + fileOffset);
      }
  
      const { bytesRead } = await read(fd, buffer, 0, CHUNK_SIZE, fileOffset);
      if (bytesRead === 0) break;
  
      fileOffset += bytesRead;
      const chunk = leftover + buffer.toString('utf8', 0, bytesRead);
      const lines = chunk.split('\n');
      leftover = lines.pop() || '';
  
    for (const line of lines) {
      lineNum++;
  
      // Remove leading and trailing whitespace
      const cleanedLine = line.trim();
  
      if (cleanedLine.startsWith('#')) {
        // Extract timestamp
        const timestampMatch = cleanedLine.match(/#(\d+)/);
        if (timestampMatch) {
          currentTimestamp = parseInt(timestampMatch[1]);
          waveformDataSet.timeChain.push(currentTimestamp);
          waveformDataSet.timeOffset.push(byteOffset);
        }
      } else if (cleanedLine.startsWith('b')) {
        // Extract signal value
        const valueMatch = cleanedLine.match(/b([01xzXZ]*)\s+(.+)/);
        if (valueMatch) {
          const signalValue = valueMatch[1];
          const signalId    = valueMatch[2];
  
          if (currentTimestamp !== 0) {
            initialState = signalValues.get(signalId) || "x";
            waveformDataSet.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            waveformDataSet.setInitialState(signalId, signalValue);
          }
          // Update the state of the signal in the map
          signalValues.set(signalId, signalValue);
        }
      } else if (cleanedLine.match(/^[01xzXZ].+$/)) {
        // Extract signal value
        const valueMatch = cleanedLine.match(/([01xzXZ])(.+)/);
        if (valueMatch) {
          const signalValue = valueMatch[1];
          const signalId    = valueMatch[2];
  
          if (currentTimestamp !== 0) {
            initialState = signalValues.get(signalId) || "x";
            waveformDataSet.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            waveformDataSet.setInitialState(signalId, signalValue);
          }
          // Update the state of the signal in the map
          signalValues.set(signalId, signalValue);
        }
      }
      byteOffset += line.length + 1;
    }
    }
  
    close(fd);
  
    // Discern Chunk size
    let minTimeStemp      = 9999999;
    const eventCount = waveformDataSet.timeChain.length;
    console.log("Event count: " + eventCount);
  
    if (eventCount <= 128) {
      minTimeStemp = waveformDataSet.timeChain[eventCount - 1];
    } else {
      for (let i = 128; i < eventCount; i++) {
        const rollingTimeStep = waveformDataSet.timeChain[i] - waveformDataSet.timeChain[i - 128];
        minTimeStemp = Math.min(rollingTimeStep, minTimeStemp);
      }
    }
  
    // Prevent weird zoom ratios causing strange floating point math errors
    minTimeStemp    = 10 ** (Math.round(Math.log10(minTimeStemp / 128)) | 0);
    const chunkTime = minTimeStemp * 128;
    waveformDataSet.metadata.chunkTime   = chunkTime;
    waveformDataSet.metadata.defaultZoom = 512 / chunkTime;
  
    let chunkIndex = 0;
    for (let i = 0; i < eventCount; i++) {
      const time = waveformDataSet.timeChain[i];
      while (time >= chunkTime * chunkIndex) {
        waveformDataSet.timeChainChunkStart.push(i);
        chunkIndex++;
      }
    }
    waveformDataSet.timeChainChunkStart.push(eventCount);
    waveformDataSet.timeOffset.push(totalSize);
  
    //console.log("File Size: " + totalSize);
    //console.log("Event count: " + eventCount);
    //console.log("Chunk time: " + chunkTime);
    //console.log("Minimum time step: " + minTimeStemp);
    //console.log(waveformDataSet.timeChainChunkStart.slice(0, Math.min(10, waveformDataSet.timeChainChunkStart.length)));
    //console.log(waveformDataSet.timeChain.slice(0, Math.min(1000, waveformDataSet.timeChain.length)));
    console.log("Module count: " + moduleCount);
    console.log("Signal count: " + signalCount);
  
    waveformDataSet.metadata.timeEnd = currentTimestamp + 1;
    signalValues.forEach((initialState, signalId) => {
      const postState   = 'X';
      const signalWidth = waveformDataSet.netlistElements.get(signalId)?.signalWidth || 1;
      waveformDataSet.addTransitionData(signalId, [currentTimestamp, postState.repeat(signalWidth)]);
      waveformDataSet.metadata.chunkCount = Math.ceil(waveformDataSet.metadata.timeEnd / waveformDataSet.metadata.chunkTime);
    });
  
  }