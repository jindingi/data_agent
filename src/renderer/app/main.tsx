import { TooltipProvider } from '../components/ui/tooltip';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../styles/globals.css';
import { applyTheme, readTheme } from '../lib/theme';
applyTheme(readTheme());
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={400}>
      <App />
    </TooltipProvider>
  </React.StrictMode>,
);
