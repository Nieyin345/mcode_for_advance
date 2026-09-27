import React from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryExplorerPanel} from '@renderer/components/memory/MemoryExplorerPanel.js';
function App(){return <div className="h-screen overflow-auto"><header>M17 · 隔离组件 / Mock RPC</header><main style={{height:'calc(100vh - 40px)'}}><MemoryExplorerPanel/></main></div>;}
createRoot(document.getElementById('root')).render(<App/>);
window.__ready=true;
