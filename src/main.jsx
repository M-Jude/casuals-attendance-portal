import { createRoot } from 'react-dom/client';
import App from './App';
import { initPwa } from './pwa';
import { ToastProvider } from './toast';
import { ConfirmProvider } from './confirm';
import './portal.css';

initPwa();
createRoot(document.getElementById('root')).render(<ToastProvider><ConfirmProvider><App /></ConfirmProvider></ToastProvider>);
