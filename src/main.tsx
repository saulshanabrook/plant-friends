import { createRoot } from 'react-dom/client';
import App from './App';
import { Benchmark } from './dev/Benchmark';
import './style.css';

// Both the product and benchmark routes need the same offline app shell.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  let reloadForUpdate = false;
  window.addEventListener('plant-friends-update', () => { reloadForUpdate = true; });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadForUpdate) window.location.reload();
    else window.dispatchEvent(new CustomEvent('plant-friends-shell', { detail: { ready: true, waiting: null } }));
  });
  void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).then(registration => {
    window.dispatchEvent(new CustomEvent('plant-friends-shell', { detail: { ready: Boolean(registration.active), waiting: registration.waiting } }));
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state !== 'installed') return;
        window.dispatchEvent(new CustomEvent('plant-friends-shell', {
          detail: { ready: true, waiting: navigator.serviceWorker.controller ? worker : null },
        }));
      });
    });
  }).catch(error => console.error('App shell could not be saved offline', error));
}

createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('diagnostics') === '1' ? <Benchmark /> : <App />,
);
