import {state} from "./state.js";
export const createRequire=(_url:unknown)=>({resolve:(_name:string)=>{if(state.cmapFail)throw Error("CMap resources unavailable");return "/isolated/pdfjs/package.json";}});
