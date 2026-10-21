const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('__paneU1Preload', {loaded:true});
