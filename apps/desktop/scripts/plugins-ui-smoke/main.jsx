import React from 'react';
import { createRoot } from 'react-dom/client';
import { PluginsPanel } from '../../src/renderer/components/settings/PluginsPanel.tsx';
const root = createRoot(document.getElementById('root'));
root.render(<main className="h-screen bg-surface p-6 text-content"><PluginsPanel /></main>);
window.__ready = true;
