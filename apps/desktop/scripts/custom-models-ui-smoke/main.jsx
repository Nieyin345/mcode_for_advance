import React from 'react';
import { createRoot } from 'react-dom/client';
import { CustomModelsPanel } from '../../src/renderer/components/settings/CustomModelsPanel.tsx';
const root = createRoot(document.getElementById('root'));
root.render(<main className="h-screen bg-surface p-6 text-content"><CustomModelsPanel /></main>);
window.__ready = true;
