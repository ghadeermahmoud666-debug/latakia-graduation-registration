import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('Application rendering failed:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="fatal-screen" dir="rtl" lang="ar">
          <div className="fatal-card">
            <div className="fatal-symbol">!</div>
            <h1>تعذّر تشغيل المنصة</h1>
            <p>لم يتم تحميل واجهة الموقع بشكل صحيح. تحقّق من إعدادات الاتصال بـ Supabase، ثم افتح أدوات المطوّر في المتصفح لمعرفة الخطأ.</p>
            <button type="button" onClick={() => window.location.reload()}>إعادة المحاولة</button>
          </div>
        </main>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById('root');
if (window.__latakiaBootTimer) window.clearTimeout(window.__latakiaBootTimer);
createRoot(rootElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
