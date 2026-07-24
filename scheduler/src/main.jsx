import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ensureStorage } from './storage.js';
import './index.css';

// Install the localStorage-backed window.storage shim before the app mounts,
// so the scheduler's persistence calls work when running outside a Claude
// artifact. Inside an artifact (where window.storage already exists) this is
// a no-op. See src/storage.js for details.
ensureStorage();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
