import { filehandler } from './filehandler';

// Platform-specific handles, filled in lazily on first use
let _parentPort: any = null;
let _fsReadSync:  ((fd: number, buf: Uint8Array, offset: number, length: number, position: number) => number) | null = null;
let _fsFstatSync: ((fd: number) => { size: number }) | null = null;

try {
    const wt = require('worker_threads') as typeof import('worker_threads');
    _parentPort = wt.parentPort;
} catch { /* browser worker – communicates via globalThis/self */ }

try {
    const fsmod = require('fs') as typeof import('fs');
    _fsReadSync  = (fd, buf, offset, length, position) => fsmod.readSync(fd, buf, offset, length, position);
    _fsFstatSync = (fd) => fsmod.fstatSync(fd);
} catch { /* browser worker – no fs module, uses in-memory buffer */ }

function postMsg(data: Record<string, unknown>, transfer: Transferable[] = []): void {
    if (_parentPort !== null) {
        _parentPort.postMessage(data, transfer);
    } else {
        (self as unknown as DedicatedWorkerGlobalScope).postMessage(data, transfer);
    }
}

function onMsg(handler: (data: unknown) => void): void {
    if (_parentPort !== null) {
        _parentPort.on('message', handler);
    } else {
        (self as unknown as DedicatedWorkerGlobalScope).addEventListener(
            'message', (e: MessageEvent) => handler(e.data));
    }
}

// Mutable worker state
let wasmExports: filehandler.Exports | null = null;
let activeNodeFd: number | null = null;     // Node.js OS file descriptor
let activeBuffer: Uint8Array | null = null; // In-memory buffer (browser / static-load)
let readBuf = new Uint8Array(65536);        // Reusable read buffer (Node.js path)

// Synchronous service – called directly by WASM in the same thread, zero cross-thread overhead
const service: filehandler.Imports = {
    log:       (msg) => postMsg({ type: 'log', msg }),
    outputlog: (msg) => postMsg({ type: 'outputlog', msg }),

    fsread: (_fd, offset, length) => {
        if (_fsReadSync !== null && activeNodeFd !== null) {
            if (length > readBuf.length) { readBuf = new Uint8Array(length); }
            _fsReadSync(activeNodeFd, readBuf, 0, length, Number(offset));
            return readBuf.subarray(0, length);
        }
        if (activeBuffer !== null) {
            const off = Number(offset);
            return activeBuffer.subarray(off, Math.min(off + length, activeBuffer.length));
        }
        return new Uint8Array(0);
    },

    getsize: (_fd) => {
        if (_fsFstatSync !== null && activeNodeFd !== null) {
            return BigInt(_fsFstatSync(activeNodeFd).size);
        }
        return activeBuffer !== null ? BigInt(activeBuffer.byteLength) : BigInt(0);
    },

    setscopetop: (name, id, tpe) =>
        postMsg({ type: 'setscopetop', name, id, tpe }),

    setvartop: (name, id, signalid, tpe, encoding, width, msb, lsb, enumtype) =>
        postMsg({ type: 'setvartop', name, id, signalid, tpe, encoding, width, msb, lsb, enumtype }),

    setmetadata: (scopecount, varcount, timescale, timeunit) =>
        postMsg({ type: 'setmetadata', scopecount, varcount, timescale, timeunit }),

    setchunksize: (chunksize, timeend, timetablelength) =>
        postMsg({ type: 'setchunksize',
            chunksize:       Number(chunksize),
            timeend:         Number(timeend),
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
            case 'setNodeFd': {
                activeNodeFd = msg.fd as number;
                activeBuffer = null;
                postMsg({ type: 'setNodeFd-done', requestId });
                break;
            }
            case 'setFileBuffer': {
                activeBuffer = msg.fileBuffer as Uint8Array;
                activeNodeFd = null;
                postMsg({ type: 'setFileBuffer-done', requestId });
                break;
            }
            case 'clearFile': {
                activeNodeFd = null;
                activeBuffer = null;
                postMsg({ type: 'clearFile-done', requestId });
                break;
            }
            case 'loadfile': {
                wasmExports!.loadfile(
                    BigInt(msg.size as number),
                    msg.fd as number,
                    msg.loadStatic as boolean,
                    msg.bufferSize as number,
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
                activeNodeFd = null;
                activeBuffer = null;
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
