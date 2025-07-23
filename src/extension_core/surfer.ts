// wit-bindgen doesn't like to compile async to wasm so do the http calls here
import { filehandler } from './filehandler';

// Chunk size for data transfer
const CHUNK_SIZE = 1024 * 32;

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

export async function getStatus(server: string, bearerToken?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    
    const response = await fetch(`${server}/get_status`, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log("getStatus");
    return response;
}

export async function getHierarchy(server: string, bearerToken?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    
    const response = await fetch(`${server}/get_hierarchy`, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log("getHierarchy");
    return response;
}

export async function getTimeTable(server: string, bearerToken?: string): Promise<any> {
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    
    const response = await fetch(`${server}/get_time_table`, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log("getTimeTable");
    return response;
}

export async function getSignals(server: string, bearerToken?: string, signalIds?: number[]): Promise<any> {
    let url = `${server}/get_signals`;
    if (signalIds && signalIds.length > 0) {
        url += '/' + signalIds.join('/');
    }
    
    const headers: Record<string, string> = {};
    if (bearerToken) {
        headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    
    const response = await fetch(url, { headers });
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    console.log("getSignals");
    return response;
}

export async function loadRemoteStatus(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    console.log("getStatus start")
    const status = await getStatus(server, bearerToken);
    console.log("getStatus done");
    const statusText = await status.text();
    console.log("statusText", statusText);
    const statusBytes = new TextEncoder().encode(statusText);
    const ret = wasmApi.loadremotestatus(statusBytes);
    console.log("status ret", ret);
    return ret;
}

export async function loadRemoteHierarchy(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    console.log("getHierarchy start")
    const hierarchy = await getHierarchy(server, bearerToken);
    console.log("getHierarchy done");
    const hierarchyBytes = await hierarchy.arrayBuffer();
    console.log("getHierarchy arrayBuffer done");
    // Pass binary data in chunks
    const hierarchyUint8Array = new Uint8Array(hierarchyBytes);
    console.log("loadRemoteHierarchy", "total size:", hierarchyUint8Array.length);
    
    await sendDataInChunks(hierarchyUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotehierarchychunk(chunk, chunkIndex, totalChunks);
    });
    
    console.log("loadRemoteHierarchy done");
}

export async function loadRemoteTimeTable(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    console.log("getTimeTable start")
    const timeTable = await getTimeTable(server, bearerToken);
    console.log("getTimeTable done");
    const timeTableBytes = await timeTable.arrayBuffer();
    console.log("getTimeTable arrayBuffer done");
    // Pass binary data in chunks
    const timeTableUint8Array = new Uint8Array(timeTableBytes);
    console.log("loadRemoteTimeTable", "total size:", timeTableUint8Array.length);
    
    await sendDataInChunks(timeTableUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotetimetablechunk(chunk, chunkIndex, totalChunks);
    });
    
    console.log("loadRemoteTimeTable wasm done");
}

export async function loadRemoteSignals(server: string, wasmApi: filehandler.Exports, bearerToken?: string, signalIds?: number[]): Promise<any> {
    console.log("getSignals start")
    const signals = await getSignals(server, bearerToken, signalIds);
    console.log("getSignals done");
    const signalsBytes = await signals.arrayBuffer();
    console.log("getSignals arrayBuffer done");
    // Pass binary data in chunks
    const signalsUint8Array = new Uint8Array(signalsBytes);
    console.log("loadRemoteSignals", "total size:", signalsUint8Array.length);
    
    await sendDataInChunks(signalsUint8Array, (chunk, chunkIndex, totalChunks) => {
        wasmApi.loadremotesignalschunk(chunk, chunkIndex, totalChunks);
    });
    
    console.log("loadRemoteSignals wasm done");
}

export async function connectToSurferServer(server: string, wasmApi: filehandler.Exports, bearerToken?: string): Promise<any> {
    try {
        // Load status first to verify connection
        const status = await loadRemoteStatus(server, wasmApi, bearerToken);
        console.log(status);
        
        // Load hierarchy
        await loadRemoteHierarchy(server, wasmApi, bearerToken);
        
        // Load time table
        await loadRemoteTimeTable(server, wasmApi, bearerToken);
        
        console.log(`Successfully connected to Surfer server: ${server}`);
    } catch (error) {
        console.error(`Failed to connect to Surfer server: ${error}`);
        throw error;
    }
}