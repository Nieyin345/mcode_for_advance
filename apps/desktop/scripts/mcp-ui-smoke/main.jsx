import React from 'react';
import { createRoot } from 'react-dom/client';
import { McpPanel } from '../../src/renderer/components/settings/McpPanel.tsx';
const root = createRoot(document.getElementById('root'));
root.render(<main className="h-screen bg-surface p-6 text-content"><McpPanel /></main>);
window.__ready = true;
