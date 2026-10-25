export const deliveries: string[] = [];
export const net = {
  async fetch(path: string) {
    deliveries.push(path);
    return new Response("from-mcode-native-office", {status:200});
  },
};
type Handler=(request:{url:string})=>Response|Promise<Response>;
export const protocol={
  handlers:new Map<string,Handler>(),
  handle(scheme:string, handler:Handler){this.handlers.set(scheme,handler);},
  registerSchemesAsPrivileged(_schemes:unknown[]){},
};
