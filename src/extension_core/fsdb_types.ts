// Shared types between fsdb_handler.ts (main process) and fsdb_worker.ts (child process)
// Keep this file free of vscode imports so the worker can use it.

export type FsdbWaveformData = {
  valueChanges: [number, string][];
  min: number;
  max: number;
};

// Commands sent from handler → worker
export type FsdbWorkerCommand =
  | { command: 'openFsdb'; fsdbPath: string }
  | { command: 'readScopes' }
  | { command: 'readMetadata' }
  | { command: 'readVars'; scopePath: string; scopeOffsetIdx: number }
  | { command: 'loadSignals'; signalIdList: number[] }
  | { command: 'getValueChanges'; signalId: number }
  | { command: 'getValuesAtTime'; signalId: number; time: number }
  | { command: 'unloadSignal'; signalId: number }
  | { command: 'unload' };

// Wire format: command + id
export type FsdbWorkerIpcMessage = FsdbWorkerCommand & { id: string };
