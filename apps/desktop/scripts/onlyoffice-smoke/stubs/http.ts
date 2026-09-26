// Use real HTTP, but even the production bridge is confined to loopback in tests.
import * as http from "http";
export * from "http";
export const servers: http.Server[] = [];
export const createServer: typeof http.createServer = new Proxy(http.createServer, {
  apply(target, receiver: unknown, args: unknown[]) {
    const server = Reflect.apply(target, receiver, args) as http.Server;
    servers.push(server);
    server.listen = new Proxy(server.listen, {
      apply(listen, owner: unknown, values: unknown[]) {
        return Reflect.apply(listen, owner, values.map((value, index) =>
          index === 1 && value === "0.0.0.0" ? "127.0.0.1" : value));
      },
    });
    return server;
  },
});
