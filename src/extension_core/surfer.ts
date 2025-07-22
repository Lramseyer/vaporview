// wit-bindgen doesn't like to compile async to wasm so do the http calls here
import { filehandler } from './filehandler';

export async function getStatus(server: string): Promise<any> {
    const response = await fetch(`${server}/get_status`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

export async function getHierarchy(server: string): Promise<any> {
    const response = await fetch(`${server}/get_hierarchy`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

export async function getTimeTable(server: string): Promise<any> {
    const response = await fetch(`${server}/get_time_table`);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

export async function getSignals(server: string, signalIds?: number[]): Promise<any> {
    let url = `${server}/get_signals`;
    if (signalIds && signalIds.length > 0) {
        url += '/' + signalIds.join('/');
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response;
}

export async function loadRemoteStatus(server: string, wasmApi: filehandler.Exports): Promise<any> {
    const status = await getStatus(server);
    const statusText = await status.text();
    return wasmApi.loadremotestatus(statusText);
}

export async function loadRemoteHierarchy(server: string, wasmApi: filehandler.Exports): Promise<any> {
    const hierarchy = await getHierarchy(server);
    const hierarchyBytes = await hierarchy.arrayBuffer();
    // Convert binary data to base64 for passing to Rust
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(hierarchyBytes)));
    wasmApi.loadremotehierarchy(base64Data);
}

export async function loadRemoteTimeTable(server: string, wasmApi: filehandler.Exports): Promise<any> {
    const timeTable = await getTimeTable(server);
    const timeTableBytes = await timeTable.arrayBuffer();
    // Convert binary data to base64 for passing to Rust
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(timeTableBytes)));
    wasmApi.loadremotetimetable(base64Data);
}

export async function loadRemoteSignals(server: string, wasmApi: filehandler.Exports, signalIds?: number[]): Promise<any> {
    const signals = await getSignals(server, signalIds);
    const signalsBytes = await signals.arrayBuffer();
    // Convert binary data to base64 for passing to Rust
    const base64Data = btoa(String.fromCharCode(...new Uint8Array(signalsBytes)));
    wasmApi.loadremotesignals(base64Data);
}

export async function connectToSurferServer(server: string, wasmApi: filehandler.Exports): Promise<any> {
    try {
        // Load status first to verify connection
        const status = await loadRemoteStatus(server, wasmApi);
        console.log(status);
        
        // Load hierarchy
        await loadRemoteHierarchy(server, wasmApi);
        
        // Load time table
        await loadRemoteTimeTable(server, wasmApi);
        
        console.log(`Successfully connected to Surfer server: ${server}`);
    } catch (error) {
        console.error(`Failed to connect to Surfer server: ${error}`);
        throw error;
    }
}