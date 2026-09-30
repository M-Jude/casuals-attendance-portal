import { createRoot } from 'react-dom/client';
import App from './App';
import { initPwa } from './pwa';
import './portal.css';

initPwa();
createRoot(document.getElementById('root')).render(<App />);
