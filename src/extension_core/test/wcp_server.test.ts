import { strict as assert } from 'node:assert';
import { Socket } from 'node:net';
import { test } from 'node:test';

import { WcpServer } from '../wcp/generated/wcp_server';
import type { GetItemInfoParams, GetItemInfoResponse, GetItemListResponse } from '../wcp/generated/wcp_types';
import { NodeTcpWcpServer } from '../wcp/node_tcp_server';

class OrderedTestServer extends WcpServer {
  public override async getItemList(): Promise<GetItemListResponse> {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { type: 'response', command: 'get_item_list', ids: [7] };
  }

  public override getItemInfo({ ids }: GetItemInfoParams): GetItemInfoResponse {
    return {
      type: 'response',
      command: 'get_item_info',
      results: ids.map((id) => ({ name: `item-${id}`, type: 'signal', id })),
    };
  }
}

class FrameReader {
  private buffer = Buffer.alloc(0);
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<{
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  public constructor(socket: Socket) {
    socket.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      let delimiter = this.buffer.indexOf(0);
      while (delimiter >= 0) {
        const message = JSON.parse(this.buffer.subarray(0, delimiter).toString('utf8'));
        this.buffer = this.buffer.subarray(delimiter + 1);
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter.resolve(message);
        } else {
          this.frames.push(message);
        }
        delimiter = this.buffer.indexOf(0);
      }
    });
    socket.on('error', (error) => {
      for (const waiter of this.waiters.splice(0)) {
        waiter.reject(error);
      }
    });
  }

  public next(): Promise<unknown> {
    if (this.frames.length > 0) {
      return Promise.resolve(this.frames.shift());
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

async function connect(port: number): Promise<Socket> {
  const socket = new Socket();
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.connect(port, '127.0.0.1');
  });
  return socket;
}

test('handles split frames and ordered pipelined commands', async (context) => {
  const server = await NodeTcpWcpServer.listen(
    { port: 0 },
    new OrderedTestServer(),
  );
  context.after(() => server.close());

  const socket = await connect(server.port);
  context.after(() => socket.destroy());
  const reader = new FrameReader(socket);

  socket.write('{"type":"greet');
  socket.write('ing","version":"0","commands":[]}\0');
  assert.deepEqual(await reader.next(), {
    type: 'greeting',
    version: '0',
    commands: ['get_item_list', 'get_item_info'],
  });

  socket.write(
    '{"type":"command","command":"get_item_list"}\0' +
      '{"type":"command","command":"get_item_info","ids":[7]}\0',
  );
  assert.deepEqual(await reader.next(), {
    type: 'response',
    command: 'get_item_list',
    ids: [7],
  });
  assert.deepEqual(await reader.next(), {
    type: 'response',
    command: 'get_item_info',
    results: [{ name: 'item-7', type: 'signal', id: 7 }],
  });

  socket.write('{"type":"command","command":"reload"}\0');
  assert.deepEqual(await reader.next(), {
    type: 'error',
    message: 'Unsupported WCP command: reload',
  });
});

test('broadcasts only events advertised by greeted clients', async (context) => {
  const server = await NodeTcpWcpServer.listen({ port: 0 }, new WcpServer());
  context.after(() => server.close());

  const socket = await connect(server.port);
  context.after(() => socket.destroy());
  const reader = new FrameReader(socket);
  socket.write('{"type":"greeting","version":"0","commands":["waveforms_loaded"]}\0');
  await reader.next();

  assert.equal(
    server.broadcast({ type: 'event', event: 'cursor_set', timestamp: 10 }),
    0,
  );
  assert.equal(
    server.broadcast({
      type: 'event',
      event: 'waveforms_loaded',
      source: 'waveform.vcd',
    }),
    1,
  );
  assert.deepEqual(await reader.next(), {
    type: 'event',
    event: 'waveforms_loaded',
    source: 'waveform.vcd',
  });
});

test('rejects unsupported protocol versions', async (context) => {
  const server = await NodeTcpWcpServer.listen({ port: 0 }, new WcpServer());
  context.after(() => server.close());

  const socket = await connect(server.port);
  context.after(() => socket.destroy());
  const reader = new FrameReader(socket);
  socket.write('{"type":"greeting","version":"1","commands":[]}\0');
  assert.deepEqual(await reader.next(), {
    type: 'error',
    message: 'Unsupported WCP version 1; expected 0',
  });
});
