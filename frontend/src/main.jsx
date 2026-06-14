import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import MaevingPage from './components/maeving/MaevingPage.jsx';

const root = createRoot(document.getElementById('root'));

if (window.location.pathname === '/maeving') {
  root.render(
    <StrictMode>
      <MaevingPage />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
