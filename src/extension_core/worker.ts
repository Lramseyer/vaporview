// Must be imported BEFORE filehandler — installs the browser RAL before
// @vscode/wasm-component-model modules initialize.  See browser-ral-init.ts.
import './browser-ral-init';
import { filehandler } from './filehandler';

// Platform-specific handles, filled in lazily on first use
let parentPort: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any

try {
  const wt = require('worker_threads') as typeof import('worker_threads');
  parentPort = wt.parentPort;
} catch { /* browser worker – communicates via globalThis/self */ }

// Lazy-loaded Node.js fs module — null when running in the browser worker host.
// Loaded on first openFile command for a 'file' scheme URI; never at module startup.
type FsMod = typeof import('fs');
let _fsmod: FsMod | null = null;

function tryLoadFsmod(): FsMod | null {
  if (_fsmod !== null) { return _fsmod; }
  try {
    _fsmod = require('fs') as FsMod; // eslint-disable-line @typescript-eslint/no-var-requires
    return _fsmod;
  } catch {
    return null;
  }
}

function postMsg(data: Record<string, unknown>, transfer: Transferable[] = []): void {
  if (parentPort !== null) {
    parentPort.postMessage(data, transfer);
  } else {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, transfer);
  }
}

function onMsg(handler: (data: unknown) => void): void {
  if (parentPort !== null) {
    parentPort.on('message', handler);
  } else {
    (self as unknown as DedicatedWorkerGlobalScope).addEventListener(
      'message', (e: MessageEvent) => handler(e.data));
  }
}

// Reusable read buffer for the Node.js path – avoids an allocation per fsread call
let readBuf = new Uint8Array(65536);

// #region fsWrapper

interface FsWrapper {
  type: 'nodeFs' | 'workspace';
  loadStatic: boolean;
  fd: number;
  fileSize: number;
  bufferSize: number;
  fileData?: Uint8Array;
  open: (fsPath: string, fileType: string, fstMaxStaticLoadSize: number) => boolean;
  readSlice: (offset: number, length: number) => Uint8Array;
  getSize: () => bigint;
  close: () => void;
}

const nodeFsWrapper: FsWrapper = {
  type: 'nodeFs',
  loadStatic: false,
  fd: 0,
  fileSize: 0,
  bufferSize: 60 * 1024,
  open: (fsPath, fileType, fstMaxStaticLoadSize) => {
    const fsmod = tryLoadFsmod();
    if (fsmod === null) { return false; }
    try {
      nodeFsWrapper.fd       = fsmod.openSync(fsPath, 'r');
      const stats            = fsmod.fstatSync(nodeFsWrapper.fd);
      nodeFsWrapper.fileSize = stats.size;
      nodeFsWrapper.loadStatic = nodeFsWrapper.fileSize < fstMaxStaticLoadSize * 1048576;
      nodeFsWrapper.bufferSize = (fileType === 'fst' && !nodeFsWrapper.loadStatic) ? 8192 : 60 * 1024;
      return true;
    } catch {
      return false;
    }
  },
  readSlice: (offset, length) => {
    if (length > readBuf.length) { readBuf = new Uint8Array(length); }
    _fsmod!.readSync(nodeFsWrapper.fd, readBuf, 0, length, offset);
    return readBuf.subarray(0, length);
  },
  getSize: () => BigInt(_fsmod!.fstatSync(nodeFsWrapper.fd).size),
  close: () => { try { _fsmod!.closeSync(nodeFsWrapper.fd); } catch { /* ignore */ } },
};

const workspaceFsWrapper: FsWrapper = {
  type: 'workspace',
  loadStatic: true,
  fd: 0,
  fileSize: 0,
  bufferSize: 60 * 1024,
  open: () => false, // workspace files are read by the main thread via vscode.workspace.fs
  readSlice: (offset, length) => {
    const data = workspaceFsWrapper.fileData!;
    return data.subarray(offset, Math.min(offset + length, data.length));
  },
  getSize: () => BigInt(workspaceFsWrapper.fileData?.byteLength ?? 0),
  close: () => {},
};

// Adapted from the VSCode hex editor extension source
function getFsWrapper(fsPath: string, scheme: string, fileType: string, fstMaxStaticLoadSize: number): FsWrapper {
  if (scheme === 'file' && nodeFsWrapper.open(fsPath, fileType, fstMaxStaticLoadSize)) {
    return nodeFsWrapper;
  }
  return workspaceFsWrapper;
}

// #region Worker state

let wasmExports: filehandler.Exports | null = null;
let activeFs: FsWrapper | null = null;

// Synchronous service – called directly by WASM in the same thread, zero cross-thread overhead
const service: filehandler.Imports = {
  log:     (msg) => postMsg({ type: 'log', msg }),
  outputlog: (msg) => postMsg({ type: 'outputlog', msg }),

  fsread: (_fd, offset, length) => {
    if (activeFs === null) { return new Uint8Array(0); }
    return activeFs.readSlice(Number(offset), length);
  },

  getsize: (_fd) => activeFs?.getSize() ?? BigInt(0),

  setscopetop: (name, id, tpe) =>
    postMsg({ type: 'setscopetop', name, id, tpe }),

  setvartop: (name, id, signalid, tpe, encoding, width, msb, lsb, enumtype) =>
    postMsg({ type: 'setvartop', name, id, signalid, tpe, encoding, width, msb, lsb, enumtype }),

  setmetadata: (scopecount, varcount, timescale, timeunit) =>
    postMsg({ type: 'setmetadata', scopecount, varcount, timescale, timeunit }),

  setchunksize: (chunksize, timeend, timetablelength) =>
    postMsg({ type: 'setchunksize',
      chunksize:     Number(chunksize),
      timeend:     Number(timeend),
      timetablelength: Number(timetablelength),
    }),

  sendtransitiondatachunk: (signalid, totalchunks, chunknum, min, max, data) =>
    postMsg({ type: 'sendtransitiondatachunk', signalid, totalchunks, chunknum, min, max, data }),

  sendenumdata: (name, totalchunks, chunknum, data) =>
    postMsg({ type: 'sendenumdata', name, totalchunks, chunknum, data }),

  sendcompressedtransitiondata: (signalid, signalwidth, totalchunks, chunknum, min, max, compresseddata, originalsize) => {
    const copy = compresseddata.slice();
    postMsg(
      { type: 'sendcompressedtransitiondata', signalid, signalwidth, totalchunks, chunknum, min, max, compresseddata: copy, originalsize },
      [copy.buffer],
    );
  },
};

async function handleMessage(raw: unknown): Promise<void> {
  const msg = raw as Record<string, unknown>;
  const requestId = msg.requestId as number;
  try {
    switch (msg.type) {
      case 'init': {
        wasmExports = await filehandler._.bind(service, msg.wasmModule as WebAssembly.Module);
        postMsg({ type: 'init-done', requestId });
        break;
      }
      case 'openFile': {
        activeFs = getFsWrapper(
          msg.fsPath as string,
          msg.scheme as string,
          msg.fileType as string,
          msg.fstMaxStaticLoadSize as number,
        );
        postMsg({ type: 'openFile-done', requestId,
          fsType:     activeFs.type,
          loadStatic: activeFs.loadStatic,
        });
        break;
      }
      case 'setFileBuffer': {
        workspaceFsWrapper.fileData = msg.fileBuffer as Uint8Array;
        workspaceFsWrapper.fileSize = workspaceFsWrapper.fileData.byteLength;
        activeFs = workspaceFsWrapper;
        postMsg({ type: 'setFileBuffer-done', requestId });
        break;
      }
      case 'clearFile': {
        activeFs?.close();
        activeFs = null;
        workspaceFsWrapper.fileData = undefined;
        workspaceFsWrapper.fileSize = 0;
        postMsg({ type: 'clearFile-done', requestId });
        break;
      }
      case 'loadfile': {
        wasmExports!.loadfile(
          BigInt(activeFs!.fileSize),
          activeFs!.fd,
          activeFs!.loadStatic,
          activeFs!.bufferSize,
        );
        postMsg({ type: 'loadfile-done', requestId });
        break;
      }
      case 'readbody': {
        wasmExports!.readbody();
        postMsg({ type: 'readbody-done', requestId });
        break;
      }
      case 'unload': {
        wasmExports!.unload();
        postMsg({ type: 'unload-done', requestId });
        break;
      }
      case 'getparametervalues': {
        const result = wasmExports!.getparametervalues(
          new Uint32Array(msg.signalIdList as number[]));
        postMsg({ type: 'getparametervalues-done', requestId, result });
        break;
      }
      case 'getchildren': {
        const result = wasmExports!.getchildren(
          msg.netlistId as number, msg.startIndex as number);
        postMsg({ type: 'getchildren-done', requestId, result });
        break;
      }
      case 'getsignaldata': {
        wasmExports!.getsignaldata(new Uint32Array(msg.signalIdList as number[]));
        postMsg({ type: 'getsignaldata-done', requestId });
        break;
      }
      case 'getenumdata': {
        wasmExports!.getenumdata(new Uint32Array(msg.netlistIdList as number[]));
        postMsg({ type: 'getenumdata-done', requestId });
        break;
      }
      case 'getvaluesattime': {
        const result = wasmExports!.getvaluesattime(
          BigInt(msg.time as number), msg.paths as string);
        postMsg({ type: 'getvaluesattime-done', requestId, result });
        break;
      }
      case 'searchnetlist': {
        const result = wasmExports!.searchnetlist(
          msg.searchQuery as string, msg.scopeId as number);
        postMsg({ type: 'searchnetlist-done', requestId, result });
        break;
      }
      case 'loadremotestatus': {
        const result = wasmExports!.loadremotestatus(msg.status as Uint8Array);
        postMsg({ type: 'loadremotestatus-done', requestId, result });
        break;
      }
      case 'loadremotechunk': {
        wasmExports!.loadremotechunk(
          msg.chunkType as number,
          msg.chunkData as Uint8Array,
          msg.chunkIndex as number,
          msg.totalChunks as number,
        );
        postMsg({ type: 'loadremotechunk-done', requestId });
        break;
      }
    }
  } catch (e) {
    postMsg({ type: 'error', requestId, error: String(e) });
  }
}

onMsg(handleMessage);
