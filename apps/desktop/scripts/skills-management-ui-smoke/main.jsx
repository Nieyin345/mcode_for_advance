import React from 'react';
import { createRoot } from 'react-dom/client';
import { SkillsPanel } from '../../src/renderer/components/settings/SkillsPanel.tsx';
const root = createRoot(document.getElementById('root'));
let revision = 0;
window.labRemount = () => root.render(<main className="h-screen bg-surface p-6 text-content"><SkillsPanel key={++revision} /></main>);
window.labRemount();
window.__ready = true;
