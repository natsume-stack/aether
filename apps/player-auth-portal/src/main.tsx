import React from 'react';
import { createRoot } from 'react-dom/client';

import { PortalApp } from './app';
createRoot(document.querySelector('#root')!).render(<PortalApp />);
