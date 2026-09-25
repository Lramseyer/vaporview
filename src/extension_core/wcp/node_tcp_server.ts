import { createServer, type Server, type Socket } from "node:net";

import {
  dispatchWcpCommand,
  WcpServer,
} from "./generated/wcp_server";
import {
  type WcpCommand,
  type WcpEvent,
  type WcpGreeting,
  type WcpMessage,
} from "./generated/wcp_types";

export class WcpProtocolError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WcpProtocolError";
  }
}

export interface NodeTcpWcpServerOptions {
  port: number;
  host?: string;
  version?: string;
  greetingTimeoutMs?: number;
  maxFrameBytes?: number;
  onError?: (error: Error) => void;
}

interface WcpConnection {
  socket: Socket;
  buffer: Buffer;
  greeting?: WcpGreeting;
  greetingTimer?: ReturnType<typeof setTimeout>;
  commandQueue: Promise<void>;
}

export class NodeTcpWcpServer {
  private readonly connections = new Set<WcpConnection>();
  private readonly supportedCommands: Array<WcpCommand["command"]>;
  private closePromise: Promise<void> | undefined;

  private constructor(
    private readonly server: Server,
    private readonly handlers: WcpServer,
    private readonly version: string,
    private readonly greetingTimeoutMs: number,
    private readonly maxFrameBytes: number,
    private readonly errorHandler: ((error: Error) => void) | undefined,
  ) {
    this.supportedCommands = handlers.supportedCommands;
  }

  public static async listen(
    options: NodeTcpWcpServerOptions,
    handlers: WcpServer,
  ): Promise<NodeTcpWcpServer> {
    const netServer = createServer();
    const wcpServer = new NodeTcpWcpServer(
      netServer,
      handlers,
      options.version ?? "0",
      options.greetingTimeoutMs ?? 2_000,
      options.maxFrameBytes ?? 16 * 1024 * 1024,
      options.onError,
    );
    netServer.on("connection", (socket) => wcpServer.accept(socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        netServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        netServer.off("error", onError);
        resolve();
      };
      netServer.once("error", onError);
      netServer.once("listening", onListening);
      netServer.listen(options.port, options.host ?? "127.0.0.1");
    });

    netServer.on("error", (error) => wcpServer.reportError(error));
    return wcpServer;
  }

  public get port(): number {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("WCP server is not listening on a TCP port");
    }
    return address.port;
  }

  public get connectionCount(): number {
    return this.connections.size;
  }

  public broadcast(event: WcpEvent): number {
    let recipients = 0;
    for (const connection of this.connections) {
      if (
        connection.greeting?.commands.includes(event.event) &&
        !connection.socket.destroyed
      ) {
        try {
          this.writeMessage(connection.socket, event);
          recipients += 1;
        } catch (error) {
          this.abort(connection, this.asError(error));
        }
      }
    }
    return recipients;
  }

  public close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    for (const connection of this.connections) {
      connection.socket.destroy();
    }
    this.closePromise = new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    return this.closePromise;
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const connection: WcpConnection = {
      socket,
      buffer: Buffer.alloc(0),
      commandQueue: Promise.resolve(),
    };
    connection.greetingTimer = setTimeout(() => {
      this.abort(
        connection,
        new WcpProtocolError("Timed out waiting for WCP client greeting"),
      );
    }, this.greetingTimeoutMs);
    this.connections.add(connection);

    socket.on("data", (data: Buffer) => this.handleData(connection, data));
    socket.on("error", (error) => {
      this.reportError(error);
      socket.destroy();
    });
    socket.once("close", () => {
      if (connection.greetingTimer) {
        clearTimeout(connection.greetingTimer);
      }
      this.connections.delete(connection);
    });
  }

  private handleData(connection: WcpConnection, data: Buffer): void {
    connection.buffer = Buffer.concat([connection.buffer, data]);
    let delimiter = connection.buffer.indexOf(0);
    while (delimiter >= 0) {
      if (delimiter > this.maxFrameBytes) {
        this.abort(
          connection,
          new WcpProtocolError(
            `WCP message exceeds ${this.maxFrameBytes} byte frame limit`,
          ),
        );
        return;
      }

      const frame = connection.buffer.subarray(0, delimiter);
      connection.buffer = connection.buffer.subarray(delimiter + 1);
      if (frame.length !== 0) {
        try {
          this.handleFrame(connection, frame);
        } catch (error) {
          this.abort(connection, this.asError(error));
        }
      }
      if (connection.socket.destroyed) {
        return;
      }
      delimiter = connection.buffer.indexOf(0);
    }

    if (connection.buffer.length > this.maxFrameBytes) {
      this.abort(
        connection,
        new WcpProtocolError(
          `WCP message exceeds ${this.maxFrameBytes} byte frame limit`,
        ),
      );
    }
  }

  private handleFrame(connection: WcpConnection, frame: Buffer): void {
    let message: unknown;
    try {
      message = JSON.parse(frame.toString("utf8"));
    } catch (error) {
      this.rejectMessage(connection, `Invalid WCP JSON: ${this.asError(error).message}`);
      return;
    }

    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      typeof message.type !== "string"
    ) {
      this.rejectMessage(connection, "Received malformed WCP message");
      return;
    }

    if (!connection.greeting) {
      this.handleGreeting(connection, message);
      return;
    }

    if (
      message.type !== "command" ||
      !("command" in message) ||
      typeof message.command !== "string"
    ) {
      this.enqueueError(connection, "Expected a WCP command");
      return;
    }
    this.enqueueCommand(connection, message as WcpCommand);
  }

  private handleGreeting(
    connection: WcpConnection,
    message: { type: unknown } & object,
  ): void {
    if (
      message.type !== "greeting" ||
      !("version" in message) ||
      typeof message.version !== "string" ||
      !("commands" in message) ||
      !Array.isArray(message.commands) ||
      !message.commands.every((command) => typeof command === "string")
    ) {
      this.rejectMessage(connection, "Expected a valid WCP greeting");
      return;
    }
    if (message.version !== this.version) {
      this.rejectMessage(
        connection,
        `Unsupported WCP version ${message.version}; expected ${this.version}`,
      );
      return;
    }

    if (connection.greetingTimer) {
      clearTimeout(connection.greetingTimer);
      connection.greetingTimer = undefined;
    }
    connection.greeting = message as WcpGreeting;
    this.writeMessage(connection.socket, {
      type: "greeting",
      version: this.version,
      commands: [...this.supportedCommands],
    });
  }

  private rejectMessage(connection: WcpConnection, message: string): void {
    if (connection.greeting) {
      this.enqueueError(connection, message);
      return;
    }
    try {
      this.writeMessage(connection.socket, { type: "error", message });
      connection.socket.end();
    } catch (error) {
      this.abort(connection, this.asError(error));
    }
  }

  private enqueueError(connection: WcpConnection, message: string): void {
    this.enqueueResponse(connection, async () => ({ type: "error", message }));
  }

  private enqueueCommand(connection: WcpConnection, command: WcpCommand): void {
    this.enqueueResponse(connection, async () => {
      try {
        return await dispatchWcpCommand(this.handlers, command);
      } catch (error) {
        return { type: "error", message: this.asError(error).message };
      }
    });
  }

  private enqueueResponse(
    connection: WcpConnection,
    response: () => Promise<WcpMessage>,
  ): void {
    connection.commandQueue = connection.commandQueue
      .then(async () => {
        const message = await response();
        if (!connection.socket.destroyed) {
          this.writeMessage(connection.socket, message);
        }
      })
      .catch((error) => this.abort(connection, this.asError(error)));
  }

  private writeMessage(socket: Socket, message: WcpMessage): void {
    const frame = Buffer.from(`${JSON.stringify(message)}\0`, "utf8");
    if (frame.length - 1 > this.maxFrameBytes) {
      throw new WcpProtocolError(
        `WCP message exceeds ${this.maxFrameBytes} byte frame limit`,
      );
    }
    socket.write(frame);
  }

  private abort(connection: WcpConnection, error: Error): void {
    connection.socket.destroy(error);
  }

  private reportError(error: Error): void {
    this.errorHandler?.(error);
  }

  private asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }
}
