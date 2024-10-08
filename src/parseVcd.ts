import * as vscode from 'vscode';
import * as fs from 'fs';
import * as readline from 'readline';
import { promisify, types } from 'util';
//import { byte } from '@vscode/wasm-component-model';

//import lz4js, { compress } from 'lz4js';
//import lz4 from 'lz4';
//import fastlz from 'fastlz';
import zlib from 'zlib';

// This is a hack job LZ4 decompression routine. I couldn't get lz4 to work
// with the latest version of node, so I copied the decompression routine and
// converted it to TypeScript.
function lz4BLockDecode(input: Buffer, output: Buffer, sIdx : number | undefined, eIdx: number | undefined) {
	sIdx = sIdx || 0;
	eIdx = eIdx || (input.length - sIdx);
	// Process each sequence in the incoming data
  const n = eIdx;
  let j = 0;
	for (let i = sIdx; i < n;) {
		const token = input[i++];

		// Literals
		let literals_length = (token >> 4);
		if (literals_length > 0) {
			// length of literals
			let l = literals_length + 240;
			while (l === 255) {
				l = input[i++];
				literals_length += l;
			}

			// Copy the literals
			const end = i + literals_length;
			while (i < end) {
        output[j++] = input[i++];
      }

			// End of buffer?
			if (i === n) {return j;}
		}

		// Match copy
		// 2 bytes offset (little endian)
		const offset = input[i++] | (input[i++] << 8);

		// 0 is an invalid offset value
		if (offset === 0 || offset > j) {
      console.log("Invalid offset: " + offset);
      return -(i-2);
    }

		// length of match copy
		let match_length = (token & 0xf);
		let l = match_length + 240;
		while (l === 255) {
			l = input[i++];
			match_length += l;
		}

		// Copy the match
		let   pos = j - offset; // position of the match copy in the current output
		const end = j + match_length + 4; // minmatch = 4
		while (j < end) {output[j++] = output[pos++];}
	}

	return j;
}

import {NetlistIdRef, NetlistIdTable, NetlistItem, NetlistTreeDataProvider, VaporviewDocument, TransitionData} from './extension';
import { endianness } from 'os';
import { time } from 'console';
import { buffer } from 'stream/consumers';
import { AsyncLocalStorage } from 'async_hooks';
import { sign } from 'crypto';

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

export async function parseVcdNetlist(fd: number, netlistTreeDataProvider: NetlistTreeDataProvider, netlistIdTable: NetlistIdTable, document: VaporviewDocument) {

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
  let netlistIdCount = 0;
  let timeZeroOffset = 0;
  let nextNetlistId = 1;

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const buffer     = Buffer.alloc(CHUNK_SIZE);
  const metadata   = document.metadata;
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
        netlistIdCount++;
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
            document.createSignalWaveform(signalID, signalSize);
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
          document.metadata.timeScale = parseInt(timescaleMatch[1]);
          document.metadata.timeUnit  = timescaleMatch[2];
        }
      }
      byteOffset += line.length + 1;
    }
  }

  metadata.waveformsStartOffset = timeZeroOffset;
  metadata.moduleCount          = moduleCount;
  metadata.netlistIdCount       = netlistIdCount;
  metadata.signalIdCount        = document.netlistElements.size;

  // Update the Netlist view with the parsed netlist data
  netlistTreeDataProvider.setTreeData(netlistItems);

  // debug
  console.log("Module count: " + moduleCount);
  console.log("Signal count: " + netlistIdCount);
  await read(fd, buffer, 0, 256, timeZeroOffset);
  //console.log(buffer.toString('ascii', 0, 256));
  //console.log(netlistIdTable);

}

export async function parseVcdWaveforms(fd: number, document: VaporviewDocument, progress: vscode.Progress<{ message?: string; increment?: number; }>) {

  console.log("Parsing VCD Waveforms");
  const read = promisify(fs.read);
  const close = promisify(fs.close);

  // Define variables to track the current state
  let currentTimestamp  = 0;
  let initialState: number | string;
  const signalValues: Map<string, number | string> = new Map(); // Map to track signal values

  const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB
  const buffer     = Buffer.alloc(CHUNK_SIZE);
  const metadata   = document.metadata;
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
            document.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            document.setInitialState(signalId, signalValue);
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
            document.addTransitionData(signalId, [currentTimestamp, signalValue]);
          } else {
            document.setInitialState(signalId, signalValue);
          }
          // Update the state of the signal in the map
          signalValues.set(signalId, signalValue);
        }
      } else if (cleanedLine.startsWith('#')) {
        // Extract timestamp
        const timestampMatch = cleanedLine.match(/#(\d+)/);
        if (timestampMatch) {
          currentTimestamp = parseInt(timestampMatch[1]);
          document.timeChain.push(currentTimestamp);
          document.timeOffset.push(byteOffset);
        }
      }
      byteOffset += line.length + 1;
    }
  }

  close(fd);

  document.metadata.timeEnd = currentTimestamp + 1;
  let minTimeStemp = 9999999;
  const eventCount = document.timeChain.length;
  console.log("Event count: " + eventCount);
  if (eventCount <= 128) {
    minTimeStemp = document.timeChain[eventCount - 1];
  } else {
    for (let i = 128; i < eventCount; i++) {
      const rollingTimeStep = document.timeChain[i] - document.timeChain[i - 128];
      minTimeStemp = Math.min(rollingTimeStep, minTimeStemp);
    }
  }

  document.setChunkSize(minTimeStemp);
  document.createChunks(totalSize, Array.from(signalValues.keys()));

  //console.log("File Size: " + totalSize);
  //console.log("Event count: " + eventCount);
  console.log("Chunk time: " + document.metadata.chunkTime);
  //console.log("Minimum time step: " + minTimeStemp);
  //console.log(waveformDataSet.timeChainChunkStart.slice(0, Math.min(10, waveformDataSet.timeChainChunkStart.length)));
  //console.log(waveformDataSet.timeChain.slice(0, Math.min(1000, waveformDataSet.timeChain.length)));

  console.log("Waveforms parsed");
  document.metadata.waveformsLoaded = true;
  document.onDoneParsingWaveforms();
}

/* ****************************************************************************
* This is a WIP FST parser. There are still a couple of bugs. It sometimes gets
* the signal ID incorrect, and it sometimes seems to load the incorrect signal
* data.
*
* To DO:
* Blackout Block
***************************************************************************** */

export async function parseFst(fd: number, netlistTreeDataProvider: NetlistTreeDataProvider, netlistIdTable: NetlistIdTable, document: VaporviewDocument) {

  console.log("Parsing FST Waveforms");
  const read  = promisify(fs.read);
  const close = promisify(fs.close);

  // Read the FST header
  const analyzeBuffer = Buffer.alloc(1024);
  const fileSize      = document.metadata.fileSize;
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
  document.metadata.signalIdCount = header.numVars;
  const timeUnitArray = ["fs", "ps", "ns", "us", "ms", "s", "ks", "Ms", "Gs", "Ts"];
  const unitIndex = Math.floor((header.timeScale + 15) / 3);
  if (unitIndex < 0 || unitIndex >= timeUnitArray.length) {
    document.metadata.timeUnit  = "10 ^ " + header.timeScale.toString();
    document.metadata.timeScale = 1;
  } else {
    document.metadata.timeUnit  = timeUnitArray[unitIndex];
    document.metadata.timeScale = 10 ** ((header.timeScale + 129) % 3);
  }

  // Parse all subsequent blocks. We don't go super in-depth with Value Change
  // Blocks, because we want to decode the netlist first
  while (fileOffset < fileSize) {
    await read(fd, analyzeBuffer, 0, 1024, fileOffset);
    blockType = analyzeBuffer.readUInt8(0);
    blockLength = Number(analyzeBuffer.readBigUInt64BE(1));

    // Process Value Change Block
    if (blockType === 1 || blockType === 5 || blockType === 8) {
      console.log("analyzing value change block");
      valueChangeBlocks.push(await analyzeValueChangeBlock(fd, analyzeBuffer, blockType, fileOffset, blockLength));
    } else if (blockType === 4 || blockType === 6 || blockType === 7) {
      console.log("analyzing Hierarchy block");
      heirarchy = await analyzeHierarchyBlock(fd, analyzeBuffer, blockType, fileOffset, blockLength, netlistIdTable, netlistTreeDataProvider, document);
    } else if (blockType === 3) {
      geometryMetaData = analyzeGeometryBlock(fd, analyzeBuffer, fileOffset, blockLength);
    } else if (blockType === 2) {
      blackoutBlock = analyzeBlackOutBlock(analyzeBuffer, fileOffset, blockLength);
    }

    fileOffset += blockLength + 1;
  }

  document.geometryBlock = await readGeometryBlock(fd, geometryMetaData);
  //console.log("Geometry Block:");
  //console.log(geometryBlock);

  document.metadata.timeEnd = valueChangeBlocks[valueChangeBlocks.length - 1].endTime + 1;
  let minTimeStemp = 9999999;
  let timeChainHistory: any[] = [];

  // once we decode the netlist, we can analyze the Value Change blocks
  for (let i = 0; i < valueChangeBlocks.length; i++) {

    console.log("Analyzing Value Change Block " + i);
    const vcBlock = valueChangeBlocks[i];

    // time Table
    vcBlock.timeTable  = await decodeTimeTable(fd, vcBlock);
    const timeChain = timeChainHistory.concat(vcBlock.timeTable);
    const eventCount = timeChain.length;
    if (eventCount >= 128) {
      for (let i = 127; i < eventCount; i++) {
        const rollingTimeStep = timeChain[i] - timeChain[i - 128];
        minTimeStemp = Math.min(rollingTimeStep, minTimeStemp);
      }
      timeChainHistory = timeChain.slice(eventCount - 128);
    } else if (i === valueChangeBlocks.length - 1) {
      minTimeStemp = timeChain[eventCount - 1];
    }

    // Position Table
    let posTable: any;

    if (vcBlock.aliasType === 1) {
      posTable = await decodePositionTable(fd, vcBlock, header.numVars);
    } else if (vcBlock.aliasType === 5) {
      posTable = await decodePositionTableAlias(fd, vcBlock, header.numVars);
    } else {
      posTable = await decodePositionTableAlias2(fd, vcBlock, header.numVars);
    }

    vcBlock.waveformOffsets = posTable.waveformOffsets;
    vcBlock.waveformLengths = posTable.waveformLengths;

    // Bits Array
    const bitsArrayCompressionType = (vcBlock.bitsUncompressedLength !== vcBlock.bitsCompressedLength) ? "zlib" : "none";
    let bitsArrayBuffer = Buffer.alloc(vcBlock.bitsCompressedLength);
    await read(fd, bitsArrayBuffer, 0, vcBlock.bitsCompressedLength, vcBlock.bitsBlockOffset + vcBlock.fileOffset);
    bitsArrayBuffer = await decompressBlock(bitsArrayBuffer, bitsArrayCompressionType, vcBlock.bitsUncompressedLength);
    console.log(bitsArrayBuffer.toString('ascii'));

    const waveformBuffer = Buffer.alloc(vcBlock.wavesLength);

    console.log("Waveforms compression type " + vcBlock.wavesPackType);

    await read(fd, waveformBuffer, 0, vcBlock.wavesLength, vcBlock.wavesBlockOffset + vcBlock.fileOffset);
    console.log(waveformBuffer);

    for (let v = 0; v < vcBlock.wavesCount; v++) {

      const offset = vcBlock.waveformOffsets[v];
      const length = vcBlock.waveformLengths[v];
      const signalWidth = document.geometryBlock.width[v];
      const bitsArrayOffset = document.geometryBlock.byteOffset[v];
      const varIntData = parseVarInt(waveformBuffer, offset - 1);
      let uncompressedLength = varIntData.varint;
      const sliceStart = varIntData.pointer;
      const waveformData = waveformBuffer.subarray(sliceStart, offset + length - 1);
      let waveformDataUncompressed;
      let waveforms: TransitionData[] = [];

      try {

      if (uncompressedLength === 0) {
        uncompressedLength = waveformData.length;
        waveformDataUncompressed = waveformData;
      } else {
        waveformDataUncompressed = await decompressBlock(waveformData, vcBlock.wavesPackType, uncompressedLength);
      }

      const initialState = bitsArrayBuffer.subarray(bitsArrayOffset, bitsArrayOffset + signalWidth).toString('ascii');
      document.addTransitionDataDeduped(v.toString(), [vcBlock.startTime, initialState]);
      if (signalWidth === 1) {
        waveforms = decodeWavesDataBinary(waveformDataUncompressed, uncompressedLength, vcBlock.timeTable);
      } else {
        waveforms = decodeWavesData(waveformDataUncompressed, uncompressedLength, vcBlock.timeTable, signalWidth);
      }

      document.addTransitionDataBlock(v.toString(), waveforms);
      //if (v < 10) {
      //  console.log(waveformData);
      //  console.log(waveformDataUncompressed);
      //  console.log(waveforms);
      //}
      } catch (e) {console.log(e);}
    }
  }

  close(fd);

  document.vcBlocks = valueChangeBlocks;

  const signalIdList = new Array<string>(header.numVars);
  for (let i = 0 ; i < header.numVars; i++) {signalIdList[i] = i.toString();}
  signalIdList.forEach((signalId) => {
    const postState   = 'X';
    const signalWidth = document.netlistElements.get(signalId)?.signalWidth || 1;
    document.addTransitionData(signalId, [document.metadata.timeEnd, postState.repeat(signalWidth)]);
  });

  document.setChunkSize(minTimeStemp);
  document.metadata.chunkCount      = Math.ceil(document.metadata.timeEnd / document.metadata.chunkTime);
  document.metadata.timeTableLoaded = true;
  document.metadata.waveformsLoaded = true;
  document.onDoneParsingWaveforms();

  console.log("chunkTime: " + document.metadata.chunkTime);

  //console.log(document);
  console.log(header);
  //console.log(heirarchy);
  console.log(geometryMetaData);
  //console.log(valueChangeBlocks);

}

export async function loadTransitionData(signalId: number, document: VaporviewDocument) {

  const open = promisify(fs.open);
  const read = promisify(fs.read);
  const close = promisify(fs.close);
  const fd = await open(document.metadata.fileName, 'r');
  const transitionData = [];
  const vcBlocks = document.vcBlocks;
  const numVars = document.metadata.signalIdCount;

  for (let i = 0; i < vcBlocks.length; i++) {

    if (i > 1) {break;}

    console.log("Analyzing Value Change Block " + i);
    const vcBlock = vcBlocks[i];

    // Position Table
    let posTable: any;

    if (vcBlock.aliasType === 1) {
      posTable = await decodePositionTable(fd, vcBlock, numVars);
    } else if (vcBlock.aliasType === 5) {
      posTable = await decodePositionTableAlias(fd, vcBlock, numVars);
    } else {
      posTable = await decodePositionTableAlias2(fd, vcBlock, numVars);
    }

    // Bits Array
    const bitsArrayCompressionType = (vcBlock.bitsUncompressedLength !== vcBlock.bitsCompressedLength) ? "zlib" : "none";
    let bitsArrayBuffer = Buffer.alloc(vcBlock.bitsCompressedLength);
    await read(fd, bitsArrayBuffer, 0, vcBlock.bitsCompressedLength, vcBlock.bitsBlockOffset + vcBlock.fileOffset);
    bitsArrayBuffer = await decompressBlock(bitsArrayBuffer, bitsArrayCompressionType, vcBlock.bitsUncompressedLength);

    const waveformBuffer = Buffer.alloc(vcBlock.wavesLength);

    console.log("Waveforms compression type " + vcBlock.wavesPackType);
    await read(fd, waveformBuffer, 0, vcBlock.wavesLength, vcBlock.wavesBlockOffset + vcBlock.fileOffset);
    console.log(waveformBuffer);

    const offset = posTable.waveformOffsets[signalId];
    const length = posTable.waveformLengths[signalId];
    const signalWidth = document.geometryBlock.width[signalId];
    const bitsArrayOffset = document.geometryBlock.byteOffset[signalId];
    const varIntData = parseVarInt(waveformBuffer, offset - 1);
    let uncompressedLength = varIntData.varint;
    const sliceStart = varIntData.pointer;
    const waveformData = waveformBuffer.subarray(sliceStart, offset + length - 1);
    let waveformDataUncompressed;
    let waveforms: TransitionData[] = [];


    console.log("Offset: " + offset);
    console.log("Length: " + length);

    try {

    if (uncompressedLength === 0) {
      uncompressedLength = waveformData.length;
      waveformDataUncompressed = waveformData;
    } else {
      waveformDataUncompressed = await decompressBlock(waveformData, vcBlock.wavesPackType, uncompressedLength);
    }

    const initialState = bitsArrayBuffer.subarray(bitsArrayOffset, bitsArrayOffset + signalWidth).toString('ascii');
    document.addTransitionDataDeduped(signalId.toString(), [vcBlock.startTime, initialState]);
    if (signalWidth === 1) {
      waveforms = decodeWavesDataBinary(waveformDataUncompressed, uncompressedLength, vcBlock.timeTable);
    } else {
      waveforms = decodeWavesData(waveformDataUncompressed, uncompressedLength, vcBlock.timeTable, signalWidth);
    }

    console.log(waveforms);

    const postState   = 'X';
    document.addTransitionDataBlock(signalId.toString(), waveforms);
    document.addTransitionData(signalId.toString(), [document.metadata.timeEnd, postState.repeat(signalWidth)]);

    } catch (e) {console.log(e);}

  }

  close(fd);
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

function analyzeGeometryBlock(fd: number, bufferData: Buffer, fileOffset: number, blockLength: number) {
  const read = promisify(fs.read);
  const result = {
    fileOffset: fileOffset,
    length: blockLength,
    uncompressedLength: Number(bufferData.readBigUInt64BE(9)),
    entryCount: Number(bufferData.readBigUInt64BE(17)),
    compression: "zlib",
    byteOffsets: [],
  };
  if (result.uncompressedLength === result.length - 24) {
    result.compression = "none";
  }

  return result;
}

async function readGeometryBlock(fd: number, geometryBlock: any) {
  const read = promisify(fs.read);

  let uncompressedBlock = Buffer.alloc(geometryBlock.uncompressedLength);
  if (geometryBlock.compression === "zlib") {
    const compressedBlock = Buffer.alloc(geometryBlock.length);
    await read(fd, compressedBlock, 0, geometryBlock.length, geometryBlock.fileOffset + 25);
    uncompressedBlock = zlib.unzipSync(compressedBlock);
  } else {
    await read(fd, uncompressedBlock, 0, geometryBlock.uncompressedLength, geometryBlock.fileOffset + 25);
  }

  let pointer  = 0;
  let byteOffset = 0;
  const width = [];
  const byteOffsetArray = [];
  let length;
  while (pointer < geometryBlock.uncompressedLength) {
    const varIntData = parseVarIntgeometry(uncompressedBlock, pointer);
    pointer = varIntData.pointer;
    length = varIntData.varint;
    if (length === 0xFFFFFFFF) {
      byteOffsetArray.push(byteOffset);
      width.push(0);
    } else if (length === 0) {
      byteOffsetArray.push(byteOffset);
      width.push(8);
      byteOffset += 8;
    } else {
      byteOffsetArray.push(byteOffset);
      width.push(varIntData.varint);
      byteOffset += length;
    }
  }

  return {width: width, byteOffset: byteOffsetArray};
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

function parseSvarInt(bufferData: Buffer, offset: number) {
  let varint  = 0;
  let bitshift = 0;
  let pointer = offset;
  while (bufferData[pointer] >= 128) {
    varint |= (bufferData[pointer] & 0x7F) << bitshift;
    bitshift += 7;
    pointer++;
  }
  if ((bufferData[pointer] & 0x40) !== 0) {
    varint |= -1 * (1 << bitshift);
  } else {
    varint |= bufferData[pointer] << bitshift;
  }
  return {varint: varint, pointer: pointer + 1};
}

function parseVarIntgeometry(bufferData: Buffer, offset: number) {
  let varint  = 0;
  let bitshift = 0;
  let pointer = offset;
  while (bufferData[pointer] >= 128) {
    varint |= (bufferData[pointer] & 0x7F) << bitshift;
    bitshift += 7;
    pointer++;
    if (varint === 0xFFFFFFF) {
      return {varint: 0xFFFFFFFF, pointer: pointer};
    }
  }
  varint |= bufferData[pointer] << bitshift;
  return {varint: varint, pointer: pointer + 1};
}

async function decompressBlock(bufferData: Buffer, compressionType: string, decompressedLength: number ): Promise<Buffer> {
  if (compressionType === "zlib") {
    return await zlib.unzipSync(bufferData);
  } else if (compressionType === "fastlz") {
    console.log("Decompressing fastlz");
    //return await fastlz.decompress(bufferData);
  } else if (compressionType === "lz4") {
    const decompressed = Buffer.alloc(decompressedLength);
    lz4BLockDecode(bufferData, decompressed, undefined, undefined);
    return decompressed;
  } else if (compressionType === "lz4duo") {
    const intermediateBuffer = Buffer.alloc(decompressedLength);
    lz4BLockDecode(bufferData, intermediateBuffer, undefined, undefined);
    const decompressed = Buffer.alloc(decompressedLength);
    lz4BLockDecode(intermediateBuffer, decompressed, undefined, undefined);
    return decompressed;
  } else if (compressionType === "gzip") {
    return await zlib.gunzipSync(bufferData);
  }
  return bufferData;
}

async function analyzeHierarchyBlock(fd: number, bufferData: Buffer, blockType: number, fileOffset: number, blockLength: number,  netlistIdTable: NetlistIdTable, netlistTreeDataProvider: NetlistTreeDataProvider, document: VaporviewDocument) {

  const netlistItems: NetlistItem[] = [];
  const moduleStack:  NetlistItem[] = [];
  const modulePath:   string[]      = [];
  let currentScope:   NetlistItem | undefined;
  let modulePathString = "";
  let nextNetlistId = 1;
  let signalIdCount      = 0;
  let netlistIdCount   = 0;
  let moduleCount   = 0;
  let varIntData: {varint: number, pointer: number};
  const metadata    = document.metadata;

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
    //result.uncompressedOnceLength = Number(bufferData.readBigUInt64BE(17));
    //result.dataOffset = 25;
    varIntData = parseVarInt(bufferData, result.dataOffset);
    result.uncompressedOnceLength = varIntData.varint;
    result.dataOffset = varIntData.pointer;
  }

  result.compressedLength = blockLength - result.dataOffset;
  const heirarchyDataCompressed = Buffer.alloc(result.compressedLength + 0);
  await read(fd, heirarchyDataCompressed, 0, result.compressedLength, fileOffset + result.dataOffset);

  let dataBuffer = Buffer.alloc(result.uncompressedLength);

  console.log(bufferData);
  console.log("Uncompressed length : " + result.uncompressedLength);
  console.log("Compressed Once length : " + result.uncompressedOnceLength);
  console.log("Compressed length : " + result.compressedLength);
  console.log("compression type: " + result.compression);
  //console.log(heirarchyDataCompressed);

  if (result.compression === "gzip") {

    dataBuffer = zlib.gunzipSync(heirarchyDataCompressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } else if (result.compression === "lz4") {
    lz4BLockDecode(heirarchyDataCompressed, dataBuffer, undefined, undefined);
    dataBuffer[result.uncompressedLength - 1] = 255;
  } else if (result.compression === "lz4duo") {
    const intermediateBuffer = Buffer.alloc(result.uncompressedOnceLength);
    lz4BLockDecode(heirarchyDataCompressed, intermediateBuffer, undefined, undefined);
    lz4BLockDecode(intermediateBuffer, dataBuffer, undefined, undefined);
    dataBuffer[result.uncompressedLength - 1] = 255;
  }

  console.log(dataBuffer.length);

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
      const scopeType      = scopeTypeLow[dataBuffer[pointer++]];
      parseString          = parseStringNullTerminate(dataBuffer, pointer);
      const scopeName      = parseString.string;
      pointer              = parseString.pointer;
      parseString          = parseStringNullTerminate(dataBuffer, pointer);
      const scopeComponent = parseString.string;
      pointer              = parseString.pointer;
      netlist.push("scope " + scopeType + " " + scopeName + " " + scopeComponent);
      moduleCount++;
      let icon        = defaultIcon;
      if      (scopeType === 'VCD_MODULE') {icon = moduleIcon;} 
      else if (scopeType === 'VCD_FUNCTION') {icon = funcIcon;}
      if (scopeType === 'vcd_REAL') {console.log("REAL SCOPE");}
      const newScope    = new NetlistItem(scopeName, 'module', 0, '', 0, '', modulePathString, [], vscode.TreeItemCollapsibleState.Collapsed);
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
    } else if (dataBuffer[pointer] <= 29) {
      // Variable
      const signalType  = variableType[dataBuffer[pointer++]];
      const direction   = varDir[dataBuffer[pointer++]];
      parseString       = parseStringNullTerminate(dataBuffer, pointer);
      const signalName  = parseString.string;
      pointer           = parseString.pointer;
      varInt            = parseVarInt(dataBuffer, pointer);
      const signalSize  = varInt.varint;
      pointer           = varInt.pointer;
      varInt            = parseVarInt(dataBuffer, pointer);
      const structAlias = varInt.varint;
      pointer           = varInt.pointer;
      netlist.push("variable " + signalType + " " + direction + " " + signalName + " " + signalSize + " " + structAlias);

      // Extract signal information (signal type and name)
      if (currentScope) {
        netlistIdCount++;
        const netlistId  = nextNetlistId++;
        // Yes, this is a terrible hack, but converting signalId to struct pointers
        // is not something we do many times over, so I'm allowing it for now
        const signalID   = (structAlias === 0 ? signalIdCount++ : structAlias - 1).toString();

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
        document.createSignalWaveform(signalID, signalSize);
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

  console.log("Done Parsing Hierarchy Block");

  //console.log(netlist);

  metadata.moduleCount = moduleCount;
  metadata.netlistIdCount = netlistIdCount;

  // Update the Netlist view with the parsed netlist data
  netlistTreeDataProvider.setTreeData(netlistItems);
  netlistTreeDataProvider.refresh();

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
    wavesLength: 0,
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
  vcBlock.wavesLength = vcBlock.positionBlockOffset - vcBlock.wavesBlockOffset;

  return vcBlock;
}

async function decodePositionTable(fd: number, vcBlock: any, numVars: number) {
  console.log("Unsupported Alias type");
}

// FST_BL_VCDATA_DYN_ALIAS
async function decodePositionTableAlias(fd: number, vcBlock: any, numVars: number) {

  console.log("position Table Alias Type 1");

  const read = promisify(fs.read);
  const bufferData = Buffer.alloc(vcBlock.positionLength);
  const chainTable: number[] = [];
  const chainTableLengths: number[] = new Array(numVars + 1).fill(0);
  let previousIndex = 0;
  let value = 0;
  let pointer = 0;
  let varInt;
  let varIntValue;
  let zeros = 0;
  await read(fd, bufferData, 0, vcBlock.positionLength, vcBlock.fileOffset + vcBlock.positionBlockOffset);

  console.log("position table Raw data:");
  //console.log(bufferData);
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

  // Need to add in the final chain table entry
  chainTable.push(vcBlock.wavesLength + 1);
  chainTableLengths[previousIndex] = vcBlock.wavesLength - chainTable[previousIndex] + 1;

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

  //console.log(chainTable);
  //console.log(chainTableLengths);

  return {waveformOffsets: chainTable, waveformLengths: chainTableLengths};
}

async function decodePositionTableAlias2(fd: number, vcBlock: any, numVars: number) {

  console.log("position Table Alias Type 2");

  const read = promisify(fs.read);
  const bufferData = Buffer.alloc(vcBlock.positionLength);
  const chainTable: number[] = [];
  const chainTableLengths: number[] = new Array(numVars + 1).fill(0);
  let previousIndex = 0;
  let previousAlias = 0;
  let value = 0;
  let pointer = 0;
  let varInt;
  let varIntValue;
  await read(fd, bufferData, 0, vcBlock.positionLength, vcBlock.fileOffset + vcBlock.positionBlockOffset);

  console.log("position table Raw data:");
  //console.log(bufferData);
  while (pointer < vcBlock.positionLength) {
    if ((bufferData[pointer] & 1) === 1) {
      const index = chainTable.length;
      varInt = parseSvarInt(bufferData, pointer);
      varIntValue = varInt.varint >> 1;
      pointer = varInt.pointer;
      if (varIntValue > 0) {
        value += varIntValue;
        if (chainTable.length > 0) {
          const length = value - chainTable[previousIndex];
          chainTableLengths[previousIndex] = length;
        }
        previousIndex = index;
        chainTable.push(value);
      } else if (varIntValue < 0) {
        chainTable.push(0);
        previousAlias = varIntValue;
        chainTableLengths[index] = previousAlias;
      } else {
        chainTable.push(0);
        chainTableLengths[index] = previousAlias;
      }
    } else {
      varInt = parseVarInt(bufferData, pointer);
      varIntValue = varInt.varint;
      pointer = varInt.pointer;
      const zeros = varIntValue >> 1;
      for (let i = 0; i < zeros; i++) {chainTable.push(0);}
    }
  }

  console.log("Chain Table:");
  //console.log(chainTable);
  //console.log(vcBlock.positionLength);

  // Need to add in the final chain table entry
  chainTable.push(vcBlock.wavesLength + 1);
  chainTableLengths[previousIndex] = vcBlock.wavesLength - chainTable[previousIndex] + 1;

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

  //console.log(chainTable);
  //console.log(chainTableLengths);
  return {waveformOffsets: chainTable, waveformLengths: chainTableLengths};
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

function decodeWavesDataBinary(bufferData: Buffer, length: number, timeTable: number[]) {
  const result: TransitionData[] = [];
  let timeTableIndex = 0;
  let pointer = 0;
  let varIntData;
  let varIntValue = 0;
  let index = 0;
  let previousTime = -Infinity;
  let value = "";
  let previousValue = "";
  const altStateTable = ["X", "Z", "H", "U", "W", "L", "-", "?"];

  while (pointer < length) {

    varIntData = parseVarInt(bufferData, pointer);
    varIntValue = varIntData.varint;
    pointer = varIntData.pointer;
    const is4State = (varIntValue & 1) === 1;
    if (is4State) {
      value = altStateTable[(varIntValue >> 1) & 0x7];
      timeTableIndex += (varIntValue >> 4);
    } else {
      value = ((varIntValue >> 1) & 1).toString();
      timeTableIndex += (varIntValue >> 2);
    }
    const time = timeTable[timeTableIndex];
    if (previousTime === time) {
      result[index - 1][1] = value;
    } else if (value !== previousValue) {
      result.push([time, value]);
      index++;
    }
    previousValue = value;
    previousTime = time;
  }

  return result;
}

function decodeWavesData(bufferData: Buffer, length: number, timeTable: number[], signalWidth: number) {
  const result: TransitionData[] = [];
  let timeTableIndex = 0;
  let pointer = 0;
  let varIntData;
  let varIntValue = 0;
  let index = 0;
  let previousTime = -Infinity;
  let value = "";
  let previousValue = "";
  let bitsLeft = 0;
  if (signalWidth === 0xFFFFFFFF) {signalWidth = 64;}

  while (pointer < length) {
    varIntData = parseVarInt(bufferData, pointer);
    varIntValue = varIntData.varint;
    const is4State = (varIntValue & 1) === 1;
    timeTableIndex += (varIntValue >> 1);
    const time = timeTable[timeTableIndex];
    pointer    = varIntData.pointer;

    if (!is4State) {
      bitsLeft = signalWidth;
      value = "";
      while (bitsLeft > 8) {
        value += bufferData[pointer++].toString(2).padStart(8, '0');
        bitsLeft -= 8;
      }
      value += bufferData[pointer++].toString(2).padStart(bitsLeft, '0');
    } else {
      value = String(bufferData.subarray(pointer, pointer + signalWidth));
      pointer += signalWidth;
    }

    if (previousTime === time) {
      result[index - 1][1] = value;
    } else if (value !== previousValue) {
      result.push([time, value]);
      index++;
    }
    previousValue = value;
    previousTime  = time;
  }

  return result;
}