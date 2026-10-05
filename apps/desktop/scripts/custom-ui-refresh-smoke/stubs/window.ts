let sink:null|((channel:string,payload:unknown)=>void)=null;
export const setSink=(next:typeof sink)=>{sink=next;};
export const sendToRenderer=(channel:string,payload:unknown)=>{sink?.(channel,payload);};
export const getMainWindow=()=>null;
