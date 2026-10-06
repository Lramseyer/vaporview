/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Connection, RAL, WasmContext, Memory, $imports, $exports } from '@vscode/wasm-component-model';
import { filehandler } from '../wellen_parser/filehandler';
import * as fs from 'fs';
import { parentPort } from 'worker_threads';

// Populated once WASM is instantiated; accessed lazily by fsreadptrLocal.
let wasmMemory: WebAssembly.Memory | undefined;

// File state — set by the 'setup-file' message before loadfile() is called.
// Exactly one of these will be non-zero/defined per load:
let localFd: number = 0;
let localFileData: Uint8Array | undefined;

// The single fs shim the Rust WasmFileReader calls. Runs entirely in this thread.
function fsreadptrLocal(fd: number, offset: bigint, ptr: number, length: number): number {
	const byteOffset = Number(offset);
	const memView   = new Uint8Array(wasmMemory!.buffer);

	if (localFileData !== undefined) {
		// Workspace path: serve from the in-memory buffer that was fetched on demand.
		const available = Math.min(length, localFileData.byteLength - byteOffset);
		if (available <= 0) { return 0; }
		memView.set(localFileData.subarray(byteOffset, byteOffset + available), ptr);
		return available;
	}

	// Local file path: write directly from disk into WASM linear memory.
	return fs.readSync(localFd || fd, memView, ptr, length, byteOffset);
}

async function main(): Promise<void> {
	const connection = await Connection.createWorker(filehandler._);

	parentPort!.on('message', async (message: any) => {

		if (message.type === 'setup-file') {
			localFd       = message.fd ?? 0;
			// For workspace/virtual-FS files the main thread transfers the ArrayBuffer
			// directly (zero-copy ownership transfer).  For local files, fd > 0 and
			// data is undefined — reads go via fs.readSync using the fd param.
			localFileData = message.data !== undefined ? new Uint8Array(message.data) : undefined;
			return;
		}

		if (message.method === 'initializeWorker') {
			const ctx     = new (WasmContext as any).Default(message.options);
			const imports = ($imports as any).worker.create(connection, filehandler._, ctx);

			imports['$root']['fsreadptr'] = fsreadptrLocal;

			try {
				const instance = await RAL().WebAssembly.instantiate(message.module, imports);
				wasmMemory     = (instance.exports as any).memory as WebAssembly.Memory;
				ctx.initialize(new (Memory as any).Default(instance.exports));
				($exports as any).worker.bind(connection, filehandler._, instance.exports, ctx);
				(connection as any).postMessage({ method: 'reportResult', name: '$initializeWorker', result: 'success' });
			} catch (error) {
				(connection as any).postMessage({ method: 'reportResult', name: '$initializeWorker', error: String(error) });
			}
			return;
		}

		(connection as any).handleMessage(message);
	});
}

main().catch(RAL().console.error);
