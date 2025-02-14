import { Emitter, EmitterImpl } from "../../../api/emitter.js";
import { StateTransitionError } from "../../../api/exceptions/state-transition.js";
import { Transport as TransportDefinition } from "../../../api/transport.js";
import { TransportState } from "../../../api/transport-state.js";
import { Grammar } from "../../../grammar/grammar.js";
import { Logger } from "../../../core/log/logger.js";
import { SocketTransportOptions } from "./socket-transport-options.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EventCallback = (data?: any) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyWindow = window as any;

export class UDPSocket {
  private socketId: number | null = null;
  private destinationHost: string | null = null;
  private destinationPort: number | null = null;
  public onClose: EventCallback | null = null;
  public onError: EventCallback | null = null;
  public onData: EventCallback | null = null;

  constructor() {
    if (!anyWindow.chrome.sockets || !anyWindow.chrome.sockets.udp) {
      throw new Error("chrome.sockets.udp is not available. Ensure the plugin is installed and properly initialized.");
    }
  }

  async open(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anyWindow.chrome.sockets.udp.create({}, (createInfo: any) => {
        this.socketId = createInfo.socketId;
        this.destinationHost = host;
        this.destinationPort = port;

        anyWindow.chrome.sockets.udp.bind(this.socketId, "0.0.0.0", 0, (result: number) => {
          if (result < 0) {
            reject(new Error(`Failed to bind socket: ${anyWindow.chrome.runtime.lastError?.message}`));
            return;
          }
          anyWindow.chrome.sockets.udp.onReceive.addListener(this.handleReceive);
          anyWindow.chrome.sockets.udp.onReceiveError.addListener(this.handleError);

          resolve();
        });
      });
    });
  }

  async write(data: Uint8Array): Promise<void> {
    if (this.socketId === null || this.destinationHost === null || this.destinationPort === null) {
      throw new Error("Socket is not initialized or destination not set. Call open() first.");
    }

    return new Promise((resolve, reject) => {
      anyWindow.chrome.sockets.udp.send(
        this.socketId,
        data.buffer,
        this.destinationHost,
        this.destinationPort,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (sendInfo: any) => {
          if (sendInfo.resultCode < 0) {
            reject(new Error(`Failed to send data: ${anyWindow.chrome.runtime.lastError?.message}`));
          } else {
            resolve();
          }
        }
      );
    });
  }

  close(): void {
    if (this.socketId !== null) {
      anyWindow.chrome.sockets.udp.close(this.socketId, () => {
        this.socketId = null;
        if (this.onClose) {
          this.onClose();
        }
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleReceive = (info: any): void => {
    if (this.socketId !== null && info.socketId === this.socketId && this.onData) {
      const data = new Uint8Array(info.data);
      this.onData(data);
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleError = (info: any): void => {
    if (this.socketId !== null && info.socketId === this.socketId && this.onError) {
      this.onError(new Error(`Socket error: ${info.resultCode}`));
    }
  };

  // Equality comparison based on socketId
  static equals(socketA: UDPSocket, socketB: UDPSocket): boolean {
    return socketA.socketId !== null && socketB.socketId !== null && socketA.socketId === socketB.socketId;
  }
}

/**
 * Transport for SIP over secure Socket (TCP/UDP).
 * @public
 */
export class SocketTransport implements TransportDefinition {
  private static defaultOptions: Required<SocketTransportOptions> = {
    server: "",
    connectionTimeout: 5,
    keepAliveInterval: 0,
    keepAliveDebounce: 10,
    traceSip: true
  };

  public onConnect: (() => void) | undefined;
  public onDisconnect: ((error?: Error) => void) | undefined;
  public onMessage: ((message: string) => void) | undefined;

  private _protocol: string;
  private _state: TransportState = TransportState.Disconnected;
  private _stateEventEmitter: EmitterImpl<TransportState>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _socket: any | undefined;

  private configuration: Required<SocketTransportOptions>;

  private connectPromise: Promise<void> | undefined;
  private connectResolve: (() => void) | undefined;
  private connectReject: ((error: Error) => void) | undefined;
  private connectTimeout: number | undefined;

  private disconnectPromise: Promise<void> | undefined;
  private disconnectResolve: (() => void) | undefined;
  private disconnectReject: ((error?: Error) => void) | undefined;

  private keepAliveInterval: number | undefined;
  private keepAliveDebounceTimeout: number | undefined;

  private logger: Logger;
  private transitioningState = false;

  constructor(logger: Logger, options?: SocketTransportOptions) {
    // state emitter
    this._stateEventEmitter = new EmitterImpl<TransportState>();

    // logger
    this.logger = logger;

    // initialize configuration
    this.configuration = {
      // start with the default option values
      ...SocketTransport.defaultOptions,
      // apply any options passed in via the constructor
      ...options
    };

    const url = this.configuration.server;
    const parsed: { scheme: string } | -1 = Grammar.parse(url, "absoluteURI");
    if (parsed === -1) {
      this.logger.error(`Invalid Socket Server URL "${url}"`);
      throw new Error("Invalid Socket Server URL");
    }
    if (["wss", "ws"].includes(parsed.scheme)) {
      this.logger.error(`Invalid scheme in Socket Server URL "${url}"`);
      throw new Error("Invalid scheme in Socket Server URL");
    }
    this._protocol = (parsed.scheme || "TCP").toUpperCase();

    if (this._protocol === "UDP") {
      if (!anyWindow.Socket) {
        throw new Error("Please install cordova Socket plugin first (cz.blocshop.socketsforcordova)");
      }
    } else {
      if (!anyWindow.chrome.sockets.udp) {
        throw new Error("Please install cordova Socket plugin first (cordova-plugin-datagram4)");
      }
    }
  }

  public dispose(): Promise<void> {
    return this.disconnect();
  }

  /**
   * The protocol.
   *
   * @remarks
   * Formatted as defined for the Via header sent-protocol transport.
   * https://tools.ietf.org/html/rfc3261#section-20.42
   */
  public get protocol(): string {
    return this._protocol;
  }

  /**
   * The URL of the Socket Server.
   */
  public get server(): string {
    return this.configuration.server;
  }

  /**
   * Transport state.
   */
  public get state(): TransportState {
    return this._state;
  }

  /**
   * Transport state change emitter.
   */
  public get stateChange(): Emitter<TransportState> {
    return this._stateEventEmitter;
  }

  /**
   * The Socket.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public get socket(): any | undefined {
    return this._socket;
  }

  /**
   * Connect to network.
   * Resolves once connected. Otherwise rejects with an Error.
   */
  public connect(): Promise<void> {
    return this._connect();
  }

  /**
   * Disconnect from network.
   * Resolves once disconnected. Otherwise rejects with an Error.
   */
  public disconnect(): Promise<void> {
    return this._disconnect();
  }

  /**
   * Returns true if the `state` equals "Connected".
   * @remarks
   * This is equivalent to `state === TransportState.Connected`.
   */
  public isConnected(): boolean {
    return this.state === TransportState.Connected;
  }

  /**
   * Sends a message.
   * Resolves once message is sent. Otherwise rejects with an Error.
   * @param message - Message to send.
   */
  public send(message: string): Promise<void> {
    // Error handling is independent of whether the message was a request or
    // response.
    //
    // If the transport user asks for a message to be sent over an
    // unreliable transport, and the result is an ICMP error, the behavior
    // depends on the type of ICMP error.  Host, network, port or protocol
    // unreachable errors, or parameter problem errors SHOULD cause the
    // transport layer to inform the transport user of a failure in sending.
    // Source quench and TTL exceeded ICMP errors SHOULD be ignored.
    //
    // If the transport user asks for a request to be sent over a reliable
    // transport, and the result is a connection failure, the transport
    // layer SHOULD inform the transport user of a failure in sending.
    // https://tools.ietf.org/html/rfc3261#section-18.4
    return this._send(message);
  }

  private async _connect(): Promise<void> {
    this.logger.log(`Connecting ${this.server}`);

    switch (this.state) {
      case TransportState.Connecting:
        // If `state` is "Connecting", `state` MUST NOT transition before returning.
        if (this.transitioningState) {
          return Promise.reject(this.transitionLoopDetectedError(TransportState.Connecting));
        }
        if (!this.connectPromise) {
          throw new Error("Connect promise must be defined.");
        }
        return this.connectPromise; // Already connecting
      case TransportState.Connected:
        // If `state` is "Connected", `state` MUST NOT transition before returning.
        if (this.transitioningState) {
          return Promise.reject(this.transitionLoopDetectedError(TransportState.Connecting));
        }
        if (this.connectPromise) {
          throw new Error("Connect promise must not be defined.");
        }
        return Promise.resolve(); // Already connected
      case TransportState.Disconnecting:
        // If `state` is "Disconnecting", `state` MUST transition to "Connecting" before returning
        if (this.connectPromise) {
          throw new Error("Connect promise must not be defined.");
        }
        try {
          this.transitionState(TransportState.Connecting);
        } catch (e) {
          if (e instanceof StateTransitionError) {
            return Promise.reject(e); // Loop detected
          }
          throw e;
        }
        break;
      case TransportState.Disconnected:
        // If `state` is "Disconnected" `state` MUST transition to "Connecting" before returning
        if (this.connectPromise) {
          throw new Error("Connect promise must not be defined.");
        }
        try {
          this.transitionState(TransportState.Connecting);
        } catch (e) {
          if (e instanceof StateTransitionError) {
            return Promise.reject(e); // Loop detected
          }
          throw e;
        }
        break;
      default:
        throw new Error("Unknown state");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let socket: any;
    try {
      const hostParts = this.server.split(":");
      let partStart = 0;
      if (hostParts.length >= 3) {
        partStart = 1; //Skip Protocol
      } else if (hostParts.length > 1) {
        if (parseInt(hostParts[hostParts.length - 1]) > 0) {
          partStart = 1; //Skip Protocol
        } else {
          partStart = 0; //No Protocol
        }
      }

      const host = hostParts[partStart];
      partStart++;
      const port = hostParts.length > partStart ? hostParts[partStart] : 5060;

      if (this._protocol === "UDP") {
        socket = new UDPSocket();
        socket.onClose = () => this.onSocketClose(socket);
        socket.onError = (err: Error) => this.onSocketError(err, socket);
        socket.onData = (data: Uint8Array) => this.onSocketData(data, socket);
        this._socket = socket;

        await socket.open(host, port);
        this.connectPromise = new Promise((resolve, reject) => {
          this.connectResolve = resolve;
          this.connectReject = reject;

          this.connectTimeout = setTimeout(() => {
            this.logger.warn(
              "Connect timed out. " +
                "Exceeded time set in configuration.connectionTimeout: " +
                this.configuration.connectionTimeout +
                "s."
            );
            socket.close(); // careful here to use a local reference instead of this._socket
          }, this.configuration.connectionTimeout * 1000);
        });

        this.onSocketOpen(socket);
        this._socket = socket;
      } else {
        socket = new anyWindow.Socket();
        socket.onClose = () => this.onSocketClose(socket);
        socket.onError = (err: Error) => this.onSocketError(err, socket);
        socket.onData = (data: Uint8Array) => this.onSocketData(data, socket);
        this._socket = socket;

        await new Promise((resolve, reject) => {
          socket.open(
            host,
            port,
            () => {
              this.connectPromise = new Promise((resolve, reject) => {
                this.connectResolve = resolve;
                this.connectReject = reject;

                this.connectTimeout = setTimeout(() => {
                  this.logger.warn(
                    "Connect timed out. " +
                      "Exceeded time set in configuration.connectionTimeout: " +
                      this.configuration.connectionTimeout +
                      "s."
                  );
                  socket.close(1000); // careful here to use a local reference instead of this._socket
                }, this.configuration.connectionTimeout * 1000);
              });

              this.onSocketOpen(socket);
              resolve(socket);
            },
            reject
          );
        });
      }
    } catch (error) {
      this._socket = undefined;
      this.logger.error("Socket construction failed.");
      this.logger.error((error as Error).toString());
      return new Promise((resolve, reject) => {
        this.connectResolve = resolve;
        this.connectReject = reject;
        // The `state` MUST transition to "Disconnecting" or "Disconnected" before rejecting
        this.transitionState(TransportState.Disconnected, error as Error);
      });
    }

    return this.connectPromise;
  }

  private _disconnect(): Promise<void> {
    this.logger.log(`Disconnecting ${this.server}`);

    switch (this.state) {
      case TransportState.Connecting:
        // If `state` is "Connecting", `state` MUST transition to "Disconnecting" before returning.
        if (this.disconnectPromise) {
          throw new Error("Disconnect promise must not be defined.");
        }
        try {
          this.transitionState(TransportState.Disconnecting);
        } catch (e) {
          if (e instanceof StateTransitionError) {
            return Promise.reject(e); // Loop detected
          }
          throw e;
        }
        break;
      case TransportState.Connected:
        // If `state` is "Connected", `state` MUST transition to "Disconnecting" before returning.
        if (this.disconnectPromise) {
          throw new Error("Disconnect promise must not be defined.");
        }
        try {
          this.transitionState(TransportState.Disconnecting);
        } catch (e) {
          if (e instanceof StateTransitionError) {
            return Promise.reject(e); // Loop detected
          }
          throw e;
        }
        break;
      case TransportState.Disconnecting:
        // If `state` is "Disconnecting", `state` MUST NOT transition before returning.
        if (this.transitioningState) {
          return Promise.reject(this.transitionLoopDetectedError(TransportState.Disconnecting));
        }
        if (!this.disconnectPromise) {
          throw new Error("Disconnect promise must be defined.");
        }
        return this.disconnectPromise; // Already disconnecting
      case TransportState.Disconnected:
        // If `state` is "Disconnected", `state` MUST NOT transition before returning.
        if (this.transitioningState) {
          return Promise.reject(this.transitionLoopDetectedError(TransportState.Disconnecting));
        }
        if (this.disconnectPromise) {
          throw new Error("Disconnect promise must not be defined.");
        }
        return Promise.resolve(); // Already disconnected
      default:
        throw new Error("Unknown state");
    }

    if (!this._socket) {
      throw new Error("Socket must be defined.");
    }

    const socket = this._socket;
    this.disconnectPromise = new Promise((resolve, reject) => {
      this.disconnectResolve = resolve;
      this.disconnectReject = reject;

      try {
        if (socket.shutdownWrite) {
          //TCP
          socket.shutdownWrite(); //Graceful
        }
        socket.close();
      } catch (error) {
        // Treating this as a coding error as it apparently can only happen
        // if you pass close() invalid parameters (so it should never happen)
        this.logger.error("Socket close failed.");
        this.logger.error((error as Error).toString());
        throw error;
      }
    });

    return this.disconnectPromise;
  }

  private _send(message: string): Promise<void> {
    if (this.configuration.traceSip === true) {
      this.logger.log("Sending Socket message:\n\n" + message + "\n");
    }

    if (this._state !== TransportState.Connected) {
      return Promise.reject(new Error("Not connected."));
    }

    if (!this._socket) {
      throw new Error("Socket undefined.");
    }

    try {
      const data = new Uint8Array(message.length);
      for (let i = 0; i < data.length; i++) {
        data[i] = message.charCodeAt(i);
      }
      this._socket.write(data);
    } catch (error) {
      if (error instanceof Error) {
        return Promise.reject(error);
      }
      return Promise.reject(new Error("Socket send failed."));
    }
    return Promise.resolve();
  }

  /**
   * Socket "onclose" event handler.
   * @param ev - Event.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSocketClose(socket: any): void {
    if (socket !== this._socket) {
      return;
    }

    const message = `Socket closed ${this.server}`;
    const error = !this.disconnectPromise ? new Error(message) : undefined;
    if (error) {
      this.logger.warn("Socket closed unexpectedly");
    }
    this.logger.log(message);

    // The `state` MUST transition to "Disconnected" before resolving (assuming `state` is not already "Disconnected").
    this.transitionState(TransportState.Disconnected, error);
  }

  /**
   * Socket "onerror" event handler.
   * @param ev - Event.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSocketError(err: Error, socket: any): void {
    if (socket !== this._socket) {
      return;
    }
    this.logger.error("Socket error occurred.");
    this.logger.error(err.message);
  }

  /**
   * Socket "onmessage" event handler.
   * @param ev - Event.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSocketData(binData: Uint8Array, socket: any): void {
    if (socket !== this._socket) {
      return;
    }

    let str = "";
    for (let i = 0; i < binData.length; i++) {
      str += String.fromCharCode(binData[i]);
    }

    const data = str;
    let finishedData: string;

    // CRLF Keep Alive response from server. Clear our keep alive timeout.
    if (/^(\r\n)+$/.test(data)) {
      this.clearKeepAliveTimeout();
      if (this.configuration.traceSip === true) {
        this.logger.log("Received Socket message with CRLF Keep Alive response");
      }
      return;
    }

    if (!data) {
      this.logger.warn("Received empty message, discarding...");
      return;
    }

    if (typeof data !== "string") {
      // Socket binary message.
      try {
        finishedData = new TextDecoder().decode(new Uint8Array(data));
        // TextDecoder (above) is not supported by old browsers, but it correctly decodes UTF-8.
        // The line below is an ISO 8859-1 (Latin 1) decoder, so just UTF-8 code points that are 1 byte.
        // It's old code and works in old browsers (IE), so leaving it here in a comment in case someone needs it.
        // finishedData = String.fromCharCode.apply(null, (new Uint8Array(data) as unknown as Array<number>));
      } catch (err) {
        this.logger.error((err as Error).toString());
        this.logger.error("Received Socket binary message failed to be converted into string, message discarded");
        return;
      }
      if (this.configuration.traceSip === true) {
        this.logger.log("Received Socket binary message:\n\n" + finishedData + "\n");
      }
    } else {
      // Socket text message.
      finishedData = data;
      if (this.configuration.traceSip === true) {
        this.logger.log("Received Socket text message:\n\n" + finishedData + "\n");
      }
    }

    if (this.state !== TransportState.Connected) {
      this.logger.warn("Received message while not connected, discarding...");
      return;
    }

    if (this.onMessage) {
      try {
        this.onMessage(finishedData);
      } catch (e) {
        this.logger.error((e as Error).toString());
        this.logger.error("Exception thrown by onMessage callback");
        throw e; // rethrow unhandled exception
      }
    }
  }

  /**
   * Socket "onopen" event handler.
   * @param ev - Event.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onSocketOpen(socket: any): void {
    if (socket !== this._socket) {
      return;
    }
    if (this._state === TransportState.Connecting) {
      this.logger.log(`Socket opened ${this.server}`);
      this.transitionState(TransportState.Connected);
    }
  }

  /**
   * Helper function to generate an Error.
   * @param state - State transitioning to.
   */
  private transitionLoopDetectedError(state: string): StateTransitionError {
    let message = `A state transition loop has been detected.`;
    message += ` An attempt to transition from ${this._state} to ${state} before the prior transition completed.`;
    message += ` Perhaps you are synchronously calling connect() or disconnect() from a callback or state change handler?`;
    this.logger.error(message);
    return new StateTransitionError("Loop detected.");
  }

  /**
   * Transition transport state.
   * @internal
   */
  private transitionState(newState: TransportState, error?: Error): void {
    const invalidTransition = (): Error => {
      throw new Error(`Invalid state transition from ${this._state} to ${newState}`);
    };

    if (this.transitioningState) {
      throw this.transitionLoopDetectedError(newState);
    }
    this.transitioningState = true;

    // Validate state transition
    switch (this._state) {
      case TransportState.Connecting:
        if (
          newState !== TransportState.Connected &&
          newState !== TransportState.Disconnecting &&
          newState !== TransportState.Disconnected
        ) {
          invalidTransition();
        }
        break;
      case TransportState.Connected:
        if (newState !== TransportState.Disconnecting && newState !== TransportState.Disconnected) {
          invalidTransition();
        }
        break;
      case TransportState.Disconnecting:
        if (newState !== TransportState.Connecting && newState !== TransportState.Disconnected) {
          invalidTransition();
        }
        break;
      case TransportState.Disconnected:
        if (newState !== TransportState.Connecting) {
          invalidTransition();
        }
        break;
      default:
        throw new Error("Unknown state.");
    }

    // Update state
    const oldState = this._state;
    this._state = newState;

    // Local copies of connect promises (guarding against callbacks changing them indirectly)
    // const connectPromise = this.connectPromise;
    const connectResolve = this.connectResolve;
    const connectReject = this.connectReject;

    // Reset connect promises if no longer connecting
    if (oldState === TransportState.Connecting) {
      this.connectPromise = undefined;
      this.connectResolve = undefined;
      this.connectReject = undefined;
    }

    // Local copies of disconnect promises (guarding against callbacks changing them indirectly)
    // const disconnectPromise = this.disconnectPromise;
    const disconnectResolve = this.disconnectResolve;
    const disconnectReject = this.disconnectReject;

    // Reset disconnect promises if no longer disconnecting
    if (oldState === TransportState.Disconnecting) {
      this.disconnectPromise = undefined;
      this.disconnectResolve = undefined;
      this.disconnectReject = undefined;
    }

    // Clear any outstanding connect timeout
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = undefined;
    }

    this.logger.log(`Transitioned from ${oldState} to ${this._state}`);
    this._stateEventEmitter.emit(this._state);

    //  Transition to Connected
    if (newState === TransportState.Connected) {
      this.startSendingKeepAlives();
      if (this.onConnect) {
        try {
          this.onConnect();
        } catch (e) {
          this.logger.error((e as Error).toString());
          this.logger.error("Exception thrown by onConnect callback");
          throw e; // rethrow unhandled exception
        }
      }
    }

    //  Transition from Connected
    if (oldState === TransportState.Connected) {
      this.stopSendingKeepAlives();
      if (this.onDisconnect) {
        try {
          if (error) {
            this.onDisconnect(error);
          } else {
            this.onDisconnect();
          }
        } catch (e) {
          this.logger.error((e as Error).toString());
          this.logger.error("Exception thrown by onDisconnect callback");
          throw e; // rethrow unhandled exception
        }
      }
    }

    // Complete connect promise
    if (oldState === TransportState.Connecting) {
      if (!connectResolve) {
        throw new Error("Connect resolve undefined.");
      }
      if (!connectReject) {
        throw new Error("Connect reject undefined.");
      }
      newState === TransportState.Connected ? connectResolve() : connectReject(error || new Error("Connect aborted."));
    }

    // Complete disconnect promise
    if (oldState === TransportState.Disconnecting) {
      if (!disconnectResolve) {
        throw new Error("Disconnect resolve undefined.");
      }
      if (!disconnectReject) {
        throw new Error("Disconnect reject undefined.");
      }
      newState === TransportState.Disconnected
        ? disconnectResolve()
        : disconnectReject(error || new Error("Disconnect aborted."));
    }

    this.transitioningState = false;
  }

  // TODO: Review "KeepAlive Stuff".
  // It is not clear if it works and there are no tests for it.
  // It was blindly lifted the keep alive code unchanged from earlier transport code.
  //
  // From the RFC...
  //
  // SIP Socket Clients and Servers may keep their Socket
  // connections open by sending periodic Socket "Ping" frames as
  // described in [RFC6455], Section 5.5.2.
  // ...
  // The indication and use of the CRLF NAT keep-alive mechanism defined
  // for SIP connection-oriented transports in [RFC5626], Section 3.5.1 or
  // [RFC6223] are, of course, usable over the transport defined in this
  // specification.
  // https://tools.ietf.org/html/rfc7118#section-6
  //
  // and...
  //
  // The Ping frame contains an opcode of 0x9.
  // https://tools.ietf.org/html/rfc6455#section-5.5.2
  //
  // ==============================
  // KeepAlive Stuff
  // ==============================

  private clearKeepAliveTimeout(): void {
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveDebounceTimeout = undefined;
  }

  /**
   * Send a keep-alive (a double-CRLF sequence).
   */
  private sendKeepAlive(): Promise<void> {
    if (this.keepAliveDebounceTimeout) {
      // We already have an outstanding keep alive, do not send another.
      return Promise.resolve();
    }

    this.keepAliveDebounceTimeout = setTimeout(() => {
      this.clearKeepAliveTimeout();
    }, this.configuration.keepAliveDebounce * 1000);

    return this.send("\r\n\r\n");
  }

  /**
   * Start sending keep-alives.
   */
  private startSendingKeepAlives(): void {
    // Compute an amount of time in seconds to wait before sending another keep-alive.
    const computeKeepAliveTimeout = (upperBound: number): number => {
      const lowerBound = upperBound * 0.8;
      return 1000 * (Math.random() * (upperBound - lowerBound) + lowerBound);
    };

    if (this.configuration.keepAliveInterval && !this.keepAliveInterval) {
      this.keepAliveInterval = setInterval(() => {
        this.sendKeepAlive();
        this.startSendingKeepAlives();
      }, computeKeepAliveTimeout(this.configuration.keepAliveInterval));
    }
  }

  /**
   * Stop sending keep-alives.
   */
  private stopSendingKeepAlives(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval);
    }
    if (this.keepAliveDebounceTimeout) {
      clearTimeout(this.keepAliveDebounceTimeout);
    }
    this.keepAliveInterval = undefined;
    this.keepAliveDebounceTimeout = undefined;
  }
}
