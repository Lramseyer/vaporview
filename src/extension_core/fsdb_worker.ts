import type { NetlistId, SignalId } from '../common/types';
import type {
    FsdbScopeChildrenResult,
    FsdbScopeInfo,
    FsdbWaveformData,
    FsdbWorkerIpcMessage,
} from './fsdb_types';

interface FsdbAddon {
    openFsdb(fsdbPath: string): void;
    readScopes(): FsdbScopeInfo[];
    getScopeChildren(scopeOffsetIdx: number, startIndex: number): FsdbScopeChildrenResult;
    readMetadata(setMetadataFn: (scopecount: number, varcount: number, timescale: number, timeunit: string) => void, setChunkSizeFn: (chunksize: number, timeend: number) => void): void;
    readVars(
        scopePath: string,
        scopeOffsetIdx: number,
        varCallback: (...args: Parameters<typeof fsdbVarCallback>) => void,
        arrayBeginCallback: (name: string, path: string, netlistId: number) => void,
        arrayEndCallback: (size: number) => void,
        structBeginCallback: (name: string, type: string, path: string, netlistId: number) => void,
        structEndCallback: () => void,
    ): void;
    loadSignals(signalIdList: number[]): void;
    getValueChanges(signalId: number): FsdbWaveformData;
    getValuesAtTime(signalId: number, time: number): string | string[];
    unloadSignal(signalId: number): void;
    unload(): void;
}

let fsdbAddon: FsdbAddon | null = null;
try {
    // This is now a user setting
    // const addonPath = vscode.workspace.getConfiguration('vaporview').get('fsdbAddonPath');
    fsdbAddon = require('../build/Release/fsdb_reader.node');
    // fsdbAddon = require(addonPath);
} catch (error: unknown) {
    process.send!({ command: 'require-failed', error: error });
}

console.log("Start FSDB worker");

// Listen for messages from the main process.
process.on('message', (message: FsdbWorkerIpcMessage) => {
    const result = handleMessage(message);
    process.send!({ id: message.id, result: result });
});

function handleMessage(message: FsdbWorkerIpcMessage): FsdbWaveformData | string | string[] | FsdbScopeInfo[] | FsdbScopeChildrenResult | undefined {
    if (!fsdbAddon) { return undefined; }
    switch (message.command) {
        case 'openFsdb': { fsdbAddon.openFsdb(message.fsdbPath); break; }
        case 'readScopes': { return fsdbAddon.readScopes(); }
        case 'getScopeChildren': {
            return fsdbAddon.getScopeChildren(message.scopeOffsetIdx, message.startIndex);
        }
        case 'readMetadata': { fsdbAddon.readMetadata(setMetadata, setChunkSize); break; }
        case 'readVars': {
            fsdbAddon.readVars(
                message.scopePath,
                message.scopeOffsetIdx,
                fsdbVarCallback,
                fsdbArrayBeginCallback,
                fsdbArrayEndCallback,
                fsdbStructBeginCallback,
                fsdbStructEndCallback,
            );
            break;
        }
        case 'loadSignals': { fsdbAddon.loadSignals(message.signalIdList); break; }
        case 'getValueChanges': { return fsdbAddon.getValueChanges(message.signalId); }
        case 'getValuesAtTime': { return fsdbAddon.getValuesAtTime(message.signalId, message.time); }
        case 'unloadSignal': { fsdbAddon.unloadSignal(message.signalId); break; }
        case 'unload': { fsdbAddon.unload(); break; }
    }
    return undefined;
}

function setMetadata(scopecount: number, varcount: number, timescale: number, timeunit: string) {
    process.send!({
        command: 'setMetadata',
        scopecount: scopecount,
        varcount: varcount,
        timescale: timescale,
        timeunit: timeunit
    });
}

function setChunkSize(chunksize: number, timeend: number) {
    process.send!({
        command: 'setChunkSize',
        chunksize: chunksize,
        timeend: timeend
    });
}

function fsdbVarCallback(name: string, type: string, encoding: string, path: string, netlistId: NetlistId, signalId: SignalId, width: number, msb: number, lsb: number) {
    process.send!({
        command: 'fsdb-var-callback',
        name: name,
        type: type,
        encoding: encoding,
        path: path,
        netlistId: netlistId,
        signalId: signalId,
        width: width,
        msb: msb,
        lsb: lsb
    });
}

function fsdbArrayBeginCallback(name: string, path: string, netlistId: number) {
    process.send!({
        command: 'fsdb-array-begin-callback',
        name: name,
        path: path,
        netlistId: netlistId
    });
}

function fsdbArrayEndCallback(size: number) {
    process.send!({
        command: 'fsdb-array-end-callback',
        size: size,
    });
}

function fsdbStructBeginCallback(name: string, type: string, path: string, netlistId: number) {
    process.send!({
        command: 'fsdb-struct-begin-callback',
        name: name,
        type: type,
        path: path,
        netlistId: netlistId
    });
}

function fsdbStructEndCallback() {
    process.send!({
        command: 'fsdb-struct-end-callback',
    });
}
