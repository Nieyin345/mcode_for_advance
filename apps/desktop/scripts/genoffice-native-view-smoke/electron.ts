export const net={fetch:async()=>new Response(null,{status:404})};
export const protocol={
  registrations: [] as Array<Array<{scheme:string;privileges:{standard:boolean;secure:boolean}}>>,
  handle() {},
  registerSchemesAsPrivileged(schemes:Array<{scheme:string;privileges:{standard:boolean;secure:boolean}}>) {
    this.registrations.push(schemes);
  },
};
