/**
 * Transport options.
 * @public
 */
export interface SocketTransportOptions {
  /**
   * Socket server and port to connect with. For example, "localhost:5060".
   */
  server: string;

  /**
   * Seconds to wait for WebSocket to connect before giving up.
   * @defaultValue `5`
   */
  connectionTimeout?: number;

  /**
   * Keep alive - needs review.
   * @internal
   */
  keepAliveInterval?: number;

  /**
   * Keep alive - needs review.
   * @internal
   */
  keepAliveDebounce?: number;

  /**
   * If true, messages sent and received by the transport are logged.
   * @defaultValue `true`
   */
  traceSip?: boolean;
}
