import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from 'readline';
import { promisify, types } from 'util';
import { byte } from '@vscode/wasm-component-model';

import lz4js, { compress } from 'lz4js';
//import fastlz from 'fastlz';
import zlib from 'zlib';


import {NetlistIdRef, NetlistIdTable, NetlistItem, NetlistTreeDataProvider, WaveformTop, VaporviewDocument} from './extension';
import { endianness } from 'os';
import { time } from 'console';
import { buffer } from 'stream/consumers';
import { AsyncLocalStorage } from 'async_hooks';

// Define icons for the different module types
const moduleIcon  = new vscode.ThemeIcon('chip',          new vscode.ThemeColor('charts.purple'));
const funcIcon    = new vscode.ThemeIcon('symbol-module', new vscode.ThemeColor('charts.yellow'));
const defaultIcon = new vscode.ThemeIcon('symbol-module', new vscode.ThemeColor('charts.white'));

// Define icons for the different signal types
const regIcon   = new vscode.ThemeIcon('symbol-array',     new vscode.ThemeColor('charts.green'));
const wireIcon  = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.pink'));
const intIcon   = new vscode.ThemeIcon('symbol-variable',  new vscode.ThemeColor('charts.blue'));
const paramIcon = new vscode.ThemeIcon('settings',         new vscode.ThemeColor('charts.orange'));
const realIcon  = new vscode.ThemeIcon('symbol-constant',  new vscode.ThemeColor('charts.purple'));

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
  let nextNetlistId = 1;

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

      if (cleanedLine.startsWith('$var') && currentMode === 'scope') {
        signalCount++;
        // Extract signal information (signal type and name)
        //const varMatch = cleanedLine.match(/\$var\s+(wire|reg|integer|parameter|real)\s+(1|[\d+:]+)\s+(\w+)\s+(\w+(\[\d+)?(:\d+)?\]?)\s\$end/);
        if (currentScope) {
          const varData             = cleanedLine.split(/\s+/);
          const signalNameWithField = varData[4];
          const signalName          = signalNameWithField.split('[')[0];
          if (signalName !== currentSignal) {
            const signalType          = varData[1];
            const signalSize          = parseInt(varData[2], 10);
            const signalID            = varData[3];
            const netlistId           = nextNetlistId++;

            // Create a NetlistItem for the signal and add it to the current scope
            const signalItem = new NetlistItem(signalNameWithField, signalType, signalSize, signalID, netlistId, signalName, modulePathString, [], vscode.TreeItemCollapsibleState.None, vscode.TreeItemCheckboxState.Unchecked);

            // Assign an icon to the signal based on its type
            if ((signalType === 'wire') || (signalType === 'reg')) {
              if (signalSize > 1) {signalItem.iconPath = regIcon;}
              else                {signalItem.iconPath = wireIcon;}
            }
            else if (signalType === 'integer')   {signalItem.iconPath = intIcon;}
            else if (signalType === 'parameter') {signalItem.iconPath = paramIcon;}
            else if (signalType === 'real')      {signalItem.iconPath = realIcon;}

            currentScope.children.push(signalItem);
            netlistIdTable[netlistId] = {netlistItem: signalItem, displayedItem: undefined, signalId: signalID};
            waveformDataSet.createSignalWaveform(signalID, signalSize);
            currentSignal = signalName;
          }
        }
      } else if (cleanedLine.startsWith('$scope')) {
        moduleCount++;
        currentMode   = 'scope';
        currentSignal = "";
        // Extract the current scope
        const scopeData = cleanedLine.split(/\s+/);
        const scopeType = scopeData[1];
        const scopeName = scopeData[2];
        let icon        = defaultIcon;
        if      (scopeType === 'module') {icon = moduleIcon;} 
        else if (scopeType === 'function') {icon = funcIcon;}
        const netlistId   = 0;
        const newScope    = new NetlistItem(scopeName, 'module', 0, '', netlistId, '', modulePathString, [], vscode.TreeItemCollapsibleState.Collapsed);
        newScope.iconPath = icon;
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
  console.log(netlistIdTable);

}

export async function parseVcdWaveforms(fd: number, waveformDataSet: WaveformTop, document: VaporviewDocument, progress: vscode.Progress<{ message?: string; increment?: number; }>) {

  console.log("Parsing VCD Waveforms");
  const read = promisify(fs.read);
  const close = promisify(fs.close);

  // Define variables to track the current state
  let currentTimestamp  = 0;
  let initialState: number | string;
  const signalValues: Map<string, number | string> = new Map(); // Map to track signal values

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const buffer     = Buffer.alloc(CHUNK_SIZE);
  const metadata   = waveformDataSet.metadata;
  const totalSize  = metadata.fileSize;
  const timeZeroOffset = metadata.waveformsStartOffset;
  const waveformsSize  = totalSize - timeZeroOffset;
  const waveformsSizeStr = Math.round(waveformsSize / 1048576).toString() + " MB";

  let fileOffset  = timeZeroOffset;
  let fileOffsetStr = "";
  let byteOffset  = fileOffset;
  let leftover    = '';
  let lineNum     = 0;
  let netProgress = 0;

  //console.log("Parsing VCD data. File contains " + lineCount + " lines.");

  // Find the real minimum time step so that we can establish an apporpriate
  // chunk size We find the optimal chunk time by finding the shortest rolling
  // time step of 128 value changes in a row.

  while (fileOffset < totalSize) {

    // make sure we are counting the byte offset correctly
    if (byteOffset + leftover.length !== fileOffset) {
      console.log("Byte offset mismatch: " + byteOffset + " + " + leftover.length + " != " + fileOffset);
    }

    // Update progress bar
    const fileProgress = ((fileOffset - timeZeroOffset) / waveformsSize) * 100;
    while (fileProgress > netProgress) {
      fileOffsetStr = Math.round((fileOffset - timeZeroOffset) /1048576).toString();
      netProgress+=10;
      progress.report({ increment: 10, message: `${fileOffsetStr} / ${waveformsSizeStr}`});
    }
    
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

      if (cleanedLine.startsWith('b')) {
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
      } else if (cleanedLine.startsWith('#')) {
        // Extract timestamp
        const timestampMatch = cleanedLine.match(/#(\d+)/);
        if (timestampMatch) {
          currentTimestamp = parseInt(timestampMatch[1]);
          waveformDataSet.timeChain.push(currentTimestamp);
          waveformDataSet.timeOffset.push(byteOffset);
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

  waveformDataSet.metadata.timeEnd = currentTimestamp + 1;
  signalValues.forEach((initialState, signalId) => {
    const postState   = 'X';
    const signalWidth = waveformDataSet.netlistElements.get(signalId)?.signalWidth || 1;
    waveformDataSet.addTransitionData(signalId, [currentTimestamp, postState.repeat(signalWidth)]);
    waveformDataSet.metadata.chunkCount = Math.ceil(waveformDataSet.metadata.timeEnd / waveformDataSet.metadata.chunkTime);
  });

  console.log("Waveforms parsed");
  waveformDataSet.metadata.waveformsLoaded = true;
  document.onDoneParsingWaveforms();
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
        const netlistId   = 0;
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
          const netlistId           = 0;
          
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
            netlistIdTable[netlistId] = {netlistItem: signalItem, displayedItem: undefined, signalId: signalID};
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
      const chunk = leftover + buffer.toString('ascii', 0, bytesRead);
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

/* ****************************************************************************
* This is a WIP FST parser. It can currently identify and analyze all block
* types, it can't parse all of the blocks yet. It can discern and populate the
* netlist for certain compression techniques
* 
* To DO:
* Header Block
*   lz4 compression
* Blackout Block
* Value Change Block
*   Bits Array
*   Waves Blocks
***************************************************************************** */

export async function parseFst(fd: number, netlistTreeDataProvider: NetlistTreeDataProvider, waveformDataSet: WaveformTop, netlistIdTable: NetlistIdTable, document: VaporviewDocument) {

  console.log("Parsing FST Waveforms");
  const read = promisify(fs.read);
  const close = promisify(fs.close);

  // Read the FST header
  const analyzeBuffer = Buffer.alloc(1024);
  const fileSize      = waveformDataSet.metadata.fileSize;
  let fileOffset      = 0;
  let blockType       = 0;
  let blockLength     = 0;

  let heirarchy;
  let geometryMetaData;
  const valueChangeBlocks = [];
  let blackoutBlock;

  // Parse header block
  await read(fd, analyzeBuffer, 0, 1024, fileOffset);
  const header = parseFstHeader(analyzeBuffer);

  // Parse all subsequent blocks. We don't go super in-depth with Value Change
  // Blocks, because we want to decode the netlist first
  while (fileOffset < fileSize) {
    await read(fd, analyzeBuffer, 0, 1024, fileOffset);
    blockType = analyzeBuffer.readUInt8(0);
    blockLength = Number(analyzeBuffer.readBigUInt64BE(1));

    console.log("Block type: " + blockType);
    console.log("Block length: " + blockLength);

    // Process Value Change Block
    if (blockType === 1 || blockType === 5 || blockType === 8) {
      console.log("analyzing value change block");
      valueChangeBlocks.push(await analyzeValueChangeBlock(fd, analyzeBuffer, blockType, fileOffset, blockLength));
    } else if (blockType === 4 || blockType === 6 || blockType === 7) {
      console.log("analyzing Hierarchy block");
      heirarchy = await analyzeHierarchyBlock(fd, analyzeBuffer, blockType, fileOffset, blockLength, netlistIdTable, netlistTreeDataProvider, waveformDataSet);
    } else if (blockType === 3) {
      geometryMetaData = analyzeGeometryBlock(analyzeBuffer, fileOffset, blockLength);
    } else if (blockType === 2) {
      blackoutBlock = analyzeBlackOutBlock(analyzeBuffer, fileOffset, blockLength);
    }

    fileOffset += blockLength + 1;
  }

  // once we decode the netlist, we can analyze the Value Change blocks
  for (let i = 0; i < valueChangeBlocks.length; i++) {
    const vcBlock = valueChangeBlocks[i];

    // time Table
    vcBlock.timeTable = decodeTimeTable(fd, vcBlock);

    // Position Table
    let posTable: any;
    if (vcBlock.aliasType === 1) {
      posTable = decodePositionTable(fd, vcBlock, header.numVars);
    } else if (vcBlock.aliasType === 5) {
      posTable = decodePositionTableAlias(fd, vcBlock, header.numVars);
    } else {
      posTable = decodePositionTableAlias2(fd, vcBlock, header.numVars);
    }

    vcBlock.waveformOffsets = posTable.waveformOffsets;
    vcBlock.waveformLengths = posTable.waveformLengths;

  }

  close(fd);

  console.log(header);
  console.log(heirarchy);
  console.log(geometryMetaData);
  console.log(valueChangeBlocks);

}

function parseFstHeader(bufferData: Buffer) {
  return {
    type:                 bufferData.readUInt8(0),
    length:               Number(bufferData.readBigUInt64BE(1)),
    startTime:            Number(bufferData.readBigUInt64BE(9)),
    endTime:              Number(bufferData.readBigUInt64BE(17)),
    endianness:           bufferData.readDoubleLE(25) === Math.E ? 'little' : 'big',
    writerMemUse:         Number(bufferData.readBigUInt64BE(33)),
    numScopes:            Number(bufferData.readBigUInt64BE(41)),
    numHierarchyVars:     Number(bufferData.readBigUInt64BE(49)),
    numVars:              Number(bufferData.readBigUInt64BE(57)),
    numValueChangeBlocks: Number(bufferData.readBigUInt64BE(65)),
    timeScale:            bufferData.readInt8(73),
    writer:               bufferData.subarray(74, 202).toString('utf8').replace(/\0/g, ''), // Remove null characters
    date:                 bufferData.subarray(202, 228).toString('utf8').replace(/\0/g, ''), // Remove null characters
    fileType:             bufferData.readUInt8(321),
    timeZero:             Number(bufferData.readBigInt64BE(322))
  };
}

function analyzeBlackOutBlock(bufferData: Buffer, fileOffset: number, blockLength: number) {
  return {};
}

function analyzeGeometryBlock(bufferData: Buffer, fileOffset: number, blockLength: number) {
  const result = {
    fileOffset: fileOffset,
    length: blockLength,
    uncompressedLength: Number(bufferData.readBigUInt64BE(9)),
    entryCount: Number(bufferData.readBigUInt64BE(17)),
    compression: "zlib"
  };
  if (result.uncompressedLength === result.length - 24) {
    result.compression = "none";
  }
  return result;
}

function parseStringNullTerminate(bufferData: Buffer, offset: number) {
  let str: string = "";
  let pointer: number = offset;
  while (bufferData[pointer] !== 0) {
    str += String.fromCharCode(bufferData[pointer]);
    pointer++;
  }
  return {string: str, pointer: pointer + 1};
}

function parseVarInt(bufferData: Buffer, offset: number) {
  let varint  = 0;
  let bitshift = 0;
  let pointer = offset;
  while (bufferData[pointer] >= 128) {
    varint |= (bufferData[pointer] & 0x7F) << bitshift;
    bitshift += 7;
    pointer++;
  }
  varint |= bufferData[pointer] << bitshift;
  return {varint: varint, pointer: pointer + 1};
}

async function analyzeHierarchyBlock(fd: number, bufferData: Buffer, blockType: number, fileOffset: number, blockLength: number,  netlistIdTable: NetlistIdTable, netlistTreeDataProvider: NetlistTreeDataProvider, waveformDataSet: WaveformTop) {

  const netlistItems: NetlistItem[] = [];
  const moduleStack:  NetlistItem[] = [];
  const modulePath:   string[]      = [];
  let modulePathString = "";
  let currentScope:   NetlistItem | undefined;
  let nextNetlistId = 1;
  let signalId      = 0;
  let signalCount   = 0;
  let moduleCount   = 0;
  const metadata    = waveformDataSet.metadata;

  const read = promisify(fs.read);
  const result = {
    fileOffset: fileOffset,
    length: blockLength,
    compression: "gzip",
    compressedLength: 0,
    uncompressedLength: Number(bufferData.readBigUInt64BE(9)),
    uncompressedOnceLength: 0,
    dataOffset: 17,
  };

  if (blockType === 6) {
    result.compression = "lz4";
  } else if (blockType === 7) {
    result.compression = "lz4duo";
    result.uncompressedOnceLength = Number(bufferData.readBigUInt64BE(17));
    result.dataOffset = 25;
  }

  result.compressedLength = blockLength - result.dataOffset;
  const heirarchyDataCompressed = Buffer.alloc(result.compressedLength);
  await read(fd, heirarchyDataCompressed, 0, result.compressedLength, fileOffset + result.dataOffset);
  let dataUnit8Array;
  let dataBuffer = Buffer.alloc(result.uncompressedLength);

  console.log("Uncompressed length : " + result.uncompressedLength);
  console.log("Compressed length : " + result.compressedLength);
  console.log("compression type: " + result.compression);
  console.log(bufferData);
  console.log(heirarchyDataCompressed);

  if (result.compression === "gzip") {

    dataBuffer = zlib.gunzipSync(heirarchyDataCompressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } else if (result.compression === "lz4") {
    console.log('Compressed Data Magic Number (4, 34, 77, 18):', heirarchyDataCompressed.slice(0, 4));
    dataUnit8Array = lz4js.decompress(Uint8Array.from(heirarchyDataCompressed), result.uncompressedLength);
    console.log(dataUnit8Array);
    dataBuffer = Buffer.from(dataUnit8Array);
  } else if (result.compression === "lz4duo") {
    dataUnit8Array = lz4js.decompress(Uint8Array.from(heirarchyDataCompressed), result.uncompressedOnceLength);
    dataBuffer = Buffer.from(dataUnit8Array);
  }

  const scopeTypeLow = ["VCD_MODULE", "VCD_TASK", "VCD_FUNCTION", "VCD_BEGIN",
    "VCD_FORK", "VCD_GENERATE", "VCD_STRUCT", "VCD_UNION", "VCD_CLASS",
    "VCD_INTERFACE", "VCD_PACKAGE", "VCD_PROGRAM", "VHDL_ARCHITECTURE", 
    "VHDL_PROCEDURE", "VHDL_FUNCTION", "VHDL_RECORD", "VHDL_PROCESS", 
    "VHDL_BLOCK", "VHDL_FOR_GENERATE", "VHDL_IF_GENERATE", "VHDL_GENERATE",
    "VHDL_PACKAGE "];
  // 252 "GEN_ATTRBEGIN", 253 "GEN_ATTREND", 254 "VCD_SCOPE", 255 "VCD_UPSCOPE"
  const scopeTypeHigh = ["GEN_ATTRBEGIN", " GEN_ATTREND", "VCD_SCOPE", "VCD_UPSCOPE "];
  const variableType = ["VCD_EVENT", "VCD_INTEGER", "VCD_PARAMETER", "VCD_REAL",
    "VCD_REAL_PARAMETER", "VCD_REG", "VCD_SUPPLY", "VCD_SUPPLY", "VCD_TIM",
    "VCD_TR", "VCD_TRIAND", "VCD_TRIOR", "VCD_TRIREG", "VCD_TRI0", "VCD_TRI1",
    "VCD_WAND", "VCD_WIRE", "VCD_WOR", "VCD_PORT", "VCD_SPARRAY",
    "VCD_REALTIME", "GEN_STRING", "SV_BIT", "SV_LOGIC", "SV_INT",
    "SV_SHORTINT", "SV_LONGINT", "SV_BYTE", "SV_ENUM", "SV_SHORTREAL"];
    const miscType = ["COMMENT", "ENVVAR", "SUPVAR", "PATHNAME", "SOURCESTEM",
      "SOURCEISTEM", "VALUELIST", "ENUMTABLE", "UNKNOWN"];
    const arrayType = ["NONE", "UNPACKED", "PACKED", "SPARSE"];
    const enumType = ["SV_INTEGER", "SV_BIT", "SV_LOGIC", "SV_INT", "SV_SHORTINT", "SV_LONGINT", "SV_BYTE", "SV_UNSIGNED_INTEGER", "SV_UNSIGNED_BIT", "SV_UNSIGNED_LOGIC", "SV_UNSIGNED_INT", "SV_UNSIGNED_SHORTINT", "SV_UNSIGNED_LONGINT", "SV_UNSIGNED_BYTE", "REG", "TIME"];
    const packType = ["NONE", "UNPACKED", "PACKED", "SPARSE"];
    const attributeType = ["MISC", "ARRAY", "ENUM", "PACK"];
    const attributeSubtype = [miscType, arrayType, enumType, packType];
  const varDir = ["IMPLICIT", "INPUT", "OUTPUT", "INOUT", "BUFFER", "LINKAGE"];


  let pointer: number = 0;
  let parseString: {string: string, pointer: number};
  let varInt: {varint: number, pointer: number};
  const netlist = [];
  while (pointer < dataBuffer.length) {

    if (dataBuffer[pointer] === 252) { // GEN_ATTRBEGIN
      // Attribute
      pointer++;
      const attribute   = {class: "attribute", type: "", name: "", value: 0};
      const typeIndex   = dataBuffer[pointer++];
      attribute.type    = attributeType[typeIndex] + ":" + attributeSubtype[typeIndex][dataBuffer[pointer++]];
      parseString       = parseStringNullTerminate(dataBuffer, pointer);
      attribute.name    = parseString.string;
      pointer           = parseString.pointer;
      varInt            = parseVarInt(dataBuffer, pointer);
      attribute.value   = varInt.varint;
      pointer           = varInt.pointer;
      netlist.push(attribute);
      if (dataBuffer[pointer] === 253) { pointer++; } // GEN_ATTREND
    } else if (dataBuffer[pointer] === 254) { // VCD_SCOPE
      // Scope
      pointer++;
      const scope     = {class: "scope", type: "", name: "", component: ""};
      scope.type      = scopeTypeLow[dataBuffer[pointer++]];
      parseString     = parseStringNullTerminate(dataBuffer, pointer);
      scope.name      = parseString.string;
      pointer         = parseString.pointer;
      parseString     = parseStringNullTerminate(dataBuffer, pointer);
      scope.component = parseString.string;
      pointer         = parseString.pointer;
      netlist.push(scope);

      moduleCount++;
      let icon        = defaultIcon;
      if      (scope.type === 'VCD_MODULE') {icon = moduleIcon;} 
      else if (scope.type === 'VCD_FUNCTION') {icon = funcIcon;}
      const newScope    = new NetlistItem(scope.name, 'module', 0, '', 0, '', modulePathString, [], vscode.TreeItemCollapsibleState.Collapsed);
      newScope.iconPath = icon;
      modulePath.push(scope.name);
      modulePathString = modulePath.join(".");
      if (currentScope) {
        currentScope.children.push(newScope); // Add the new scope as a child of the current scope
      } else {
        netlistItems.push(newScope); // If there's no current scope, add it to the netlistItems
      }
      // Push the new scope onto the moduleStack and set it as the current scope
      moduleStack.push(newScope);
      currentScope = newScope;
    } else if (dataBuffer[pointer] <= 29) {
      // Variable
      const variable       = {class: "variable", type: "", direction: "", name: "", length: 0, structAlias: 0};
      variable.type        = variableType[dataBuffer[pointer++]];
      variable.direction   = varDir[dataBuffer[pointer++]];
      parseString          = parseStringNullTerminate(dataBuffer, pointer);
      variable.name        = parseString.string;
      pointer              = parseString.pointer;
      varInt               = parseVarInt(dataBuffer, pointer);
      variable.length      = varInt.varint;
      pointer              = varInt.pointer;
      varInt               = parseVarInt(dataBuffer, pointer);
      variable.structAlias = varInt.varint;
      pointer              = varInt.pointer;
      netlist.push(variable);

      // Extract signal information (signal type and name)
      //const varMatch = cleanedLine.match(/\$var\s+(wire|reg|integer|parameter|real)\s+(1|[\d+:]+)\s+(\w+)\s+(\w+(\[\d+)?(:\d+)?\]?)\s\$end/);
      if (currentScope) {
        signalCount++;
        const signalName = variable.name;
        const signalType = variable.type;
        const signalSize = variable.length;
        const netlistId  = nextNetlistId++;
        // Yes, this is a terrible hack, but converting signalId to struct pointers
        // is not something we do many times over, so I'm allowing it for now
        const signalID   = (variable.structAlias === 0 ? variable.structAlias - 1 : signalId++).toString();

        // Create a NetlistItem for the signal and add it to the current scope
        const signalItem = new NetlistItem(signalName, signalType, signalSize, signalID, netlistId, signalName, modulePathString, [], vscode.TreeItemCollapsibleState.None, vscode.TreeItemCheckboxState.Unchecked);

        // Assign an icon to the signal based on its type
        if ((signalType === 'VCD_WIRE') || (signalType === 'VCD_REG')) {
          if (signalSize > 1) {signalItem.iconPath = regIcon;}
          else                {signalItem.iconPath = wireIcon;}
        }
        else if (signalType === 'VCD_INTEGER')   {signalItem.iconPath = intIcon;}
        else if (signalType === 'VCD_PARAMETER') {signalItem.iconPath = paramIcon;}
        else if (signalType === 'VCD_REAL')      {signalItem.iconPath = realIcon;}
        else {signalItem.iconPath = realIcon;}

        currentScope.children.push(signalItem);
        netlistIdTable[netlistId] = {netlistItem: signalItem, displayedItem: undefined, signalId: signalID};
        waveformDataSet.createSignalWaveform(signalID, signalSize);
      }
    } else if (dataBuffer[pointer] === 255) {
      // Upscope
      netlist.push("VCD_UPSCOPE");
      pointer++;

      moduleStack.pop(); // Pop the current scope from the moduleStack
      modulePath.pop();
      currentScope     = moduleStack[moduleStack.length - 1]; // Update th current scope to the parent scope
      modulePathString = modulePath.join(".");
    } else {
      console.log("Unknown block type: " + dataBuffer[pointer] + " at pointer " + pointer);
      break;
    }
  }

  metadata.moduleCount = moduleCount;
  metadata.signalCount = signalCount;

  // Update the Netlist view with the parsed netlist data
  netlistTreeDataProvider.setTreeData(netlistItems);

  //console.log(netlist.slice(0, 1000));
  //console.log(netlist.length);

  return result;
}

async function analyzeValueChangeBlock(fd: number, bufferData: Buffer, blockType: number, fileOffset: number, blockLength: number) {
  const read = promisify(fs.read);
  const buffer = Buffer.alloc(1024);
  let blockOffset = 0;
  let varInt = {varint: 0, pointer: 0};

  // I should probably fix the typing on this later
  const vcBlock: any = {
    fileOffset: fileOffset,
    length: blockLength,
    startTime: Number(bufferData.readBigUInt64BE(9)),
    endTime: Number(bufferData.readBigUInt64BE(17)),
    memRequired: Number(bufferData.readBigUInt64BE(25)),
    bitsUncompressedLength: 0,
    bitsCompressedLength: 0,
    bitsCount: 0,
    bitsBlockOffset: 33,
    aliasType: blockType,
    wavesCount: 0,
    wavesPackType: "none",
    wavesBlockOffset: 0,
    positionLength: 0,
    positionBlockOffset: 0,
    timeUncompressedLength: 0,
    timeCompressedLength: 0,
    timeCount: 0,
    timeBlockOffset: 0,
    timeTable: [],
    waveformOffsets: [],
    waveformLengths: []
  };

  let pointer = 33;
  varInt                         = parseVarInt(bufferData, pointer);
  vcBlock.bitsUncompressedLength = varInt.varint;
  pointer                        = varInt.pointer;
  varInt                         = parseVarInt(bufferData, pointer);
  vcBlock.bitsCompressedLength   = varInt.varint;
  pointer                        = varInt.pointer;
  varInt                         = parseVarInt(bufferData, pointer);
  vcBlock.bitsCount              = varInt.varint;
  vcBlock.bitsBlockOffset        = varInt.pointer;

  // Jump to after the Bits Array
  blockOffset = vcBlock.bitsBlockOffset + vcBlock.bitsCompressedLength;
  await read(fd, buffer, 0, 1024, fileOffset + blockOffset);
  pointer                  = 0;
  varInt                   = parseVarInt(buffer, pointer);
  vcBlock.wavesCount       = varInt.varint;
  pointer                  = varInt.pointer;
  const packType           = String.fromCharCode(buffer[pointer++]);
  vcBlock.wavesBlockOffset = pointer + blockOffset;
  if (packType === "!" || packType === "Z") {
    vcBlock.wavesPackType = "zlib";
  } else if (packType === "F") {
    vcBlock.wavesPackType = "fastlz";
  } else if (packType === "4") {
    vcBlock.wavesPackType = "lz4";
  }

  // Jump to the end
  blockOffset = blockLength - 23;
  await read(fd, buffer, 0, 28, fileOffset + blockOffset);
  vcBlock.timeUncompressedLength = Number(buffer.readBigUInt64BE(0));
  vcBlock.timeCompressedLength   = Number(buffer.readBigUInt64BE(8));
  vcBlock.timeCount              = Number(buffer.readBigUInt64BE(16));
  vcBlock.timeBlockOffset        = blockOffset - vcBlock.timeCompressedLength;

  // jump to position data
  blockOffset = vcBlock.timeBlockOffset - 8;
  await read(fd, buffer, 0, 24, fileOffset + blockOffset);
  vcBlock.positionLength      = Number(buffer.readBigUInt64BE(0));
  vcBlock.positionBlockOffset = blockOffset - vcBlock.positionLength;

  return vcBlock;
}

async function decodePositionTable(fd: number, vcBlock: any, numVars: number) {

  console.log("unsupported Alias Type");
  return {waveformOffsets: [], waveformLengths: []};
}

// FST_BL_VCDATA_DYN_ALIAS
async function decodePositionTableAlias(fd: number, vcBlock: any, numVars: number) {

  const read = promisify(fs.read);
  const bufferData = Buffer.alloc(vcBlock.positionLength);
  const chainTable: number[] = [];
  const chainTableLengths: number[] = new Array(numVars).fill(0);
  let previousIndex = 0;
  let value = 0;
  let pointer = 0;
  let varInt;
  let varIntValue;
  let zeros = 0;
  await read(fd, bufferData, 0, vcBlock.positionLength, vcBlock.fileOffset + vcBlock.positionBlockOffset);

  console.log("position table Raw data:");
  console.log(bufferData);
  while (pointer < vcBlock.positionLength) {
    varInt = parseVarInt(bufferData, pointer);
    varIntValue = varInt.varint;
    pointer = varInt.pointer;
    const index = chainTable.length;
    if (varIntValue === 0) {
      chainTable.push(0);
      varInt = parseVarInt(bufferData, pointer);
      varIntValue = varInt.varint;
      pointer = varInt.pointer;
      chainTableLengths[index] = -1 * varIntValue;
    } else if ((varIntValue & 1) === 1) {
      value += varIntValue >> 1;
      if (index > 0) {
        const length = value - chainTable[previousIndex];
        chainTableLengths[previousIndex] = length;
      }
      chainTable.push(value);
      previousIndex = index;
    } else {
      zeros  = varIntValue >> 1;
      for (let i = 0; i < zeros; i++) {chainTable.push(0);}
    }
  }

  for (let i = 0; i < numVars; i++) {
    const length = chainTableLengths[i];
    if (length < 0 && chainTable[i] === 0) {
      const index = (-1 * length) - 1;
      if (index < i) {
        chainTable[i] = chainTable[index];
        chainTableLengths[i] = chainTableLengths[index];
      }
    }
  }

  return {waveformOffsets: chainTable, waveformLengths: chainTableLengths};
}

async function decodePositionTableAlias2(fd: number, vcBlock: any, numVars: number) {

  console.log("unsupported Alias Type");
  return {waveformOffsets: [], waveformLengths: []};
}

async function decodeTimeTable(fd: number, vcBlock: any) {

  const read = promisify(fs.read);
  const timeTable  = [];
  const bufferData = Buffer.alloc(vcBlock.timeCompressedLength);
  let timeDataBuffer: Buffer;
  await read(fd, bufferData, 0, vcBlock.timeCompressedLength, vcBlock.fileOffset + vcBlock.timeBlockOffset);

  if (vcBlock.timeCompressedLength !== vcBlock.timeUncompressedLength) {
    timeDataBuffer = zlib.unzipSync(bufferData, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } else {
    timeDataBuffer = bufferData;
  }

  let pointer = 0;
  let time = vcBlock.startTime;
  let varInt;
  while (pointer < vcBlock.timeUncompressedLength) {
    varInt  = parseVarInt(timeDataBuffer, pointer);
    time   += varInt.varint;
    pointer = varInt.pointer;
    timeTable.push(time);
  }

  return timeTable;
}