// Can't get wit-bindgen to compile async to wasm so do the http calls here
import { filehandler } from './filehandler';

// Chunk size for data transfer
// Can't be too big or the wasm will crash
const CHUNK_SIZE = 1024 * 32;

enum ChunkType {
    Hierarchy = 0,
    TimeTable = 1,
    Signals = 2,
}

async function sendDataInChunks(
    data: Uint8Array,
    sendChunkFn: (chunk: Uint8Array, chunkIndex: number, totalChunks: number) => void
): Promise<void> {
    const totalChunks = Math.ceil(data.length / CHUNK_SIZE);
    console.log(`Sending data in ${totalChunks} chunks of max ${CHUNK_SIZE} bytes`);
    
    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, data.length);
        const chunk = data.slice(start, end);
        
        console.log(`Sending chunk ${i + 1}/${totalChunks} (${chunk.length} bytes)`);
        sendChunkFn(chunk, i, totalChunks);
    }
}

async function httpFetch(server: string, path: string, bearerToken?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    const response = await fetch(`${server}/${path}`, { headers });
    console.log("http path", `${server}/${path}`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

// get_status does have real use in the extension but is here for completeness
export async function loadRemoteStatus(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const status = await httpFetch(server, 'get_status', bearerToken);
    const statusText = await status.text();
    const statusBytes = new TextEncoder().encode(statusText);
    const ret = wasmApi.loadremotestatus(statusBytes);
    return ret;
}

export async function loadRemoteHierarchy(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const hierarchy = await httpFetch(server, 'get_hierarchy', bearerToken);
    const hierarchyBytes = await hierarchy.arrayBuffer();
    const hierarchyUint8Array = new Uint8Array(hierarchyBytes);
    
    await sendDataInChunks(hierarchyUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.Hierarchy, chunk, chunkIndex, totalChunks);
    });
    
}

export async function loadRemoteTimeTable(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    const timeTable = await httpFetch(server, 'get_time_table', bearerToken);
    const timeTableBytes = await timeTable.arrayBuffer();
    const timeTableUint8Array = new Uint8Array(timeTableBytes);
    
    await sendDataInChunks(timeTableUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.TimeTable, chunk, chunkIndex, totalChunks);
    });
}

export async function loadRemoteSignals(server: string, wasmApi: filehandler.Exports, bearerToken?: string, signalIds?: number[]): Promise<any> {
    let path = 'get_signals';
    if (signalIds && signalIds.length > 0) {
        path += '/' + signalIds.join('/');
    }
    const signals = await httpFetch(server, path, bearerToken);
    const signalsBytes = await signals.arrayBuffer();
    const signalsUint8Array = new Uint8Array(signalsBytes);
    
    await sendDataInChunks(signalsUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotechunk(ChunkType.Signals, chunk, chunkIndex, totalChunks);
    });
}