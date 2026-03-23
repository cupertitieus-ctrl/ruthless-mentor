const SUPABASE_URL = 'https://kzmilbmfaauruedekfmu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bWlsYm1mYWF1cnVlZGVrZm11Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxMjY5OTMsImV4cCI6MjA4OTcwMjk5M30._SL6KJxICd_Yhi5yU8XBUccxnioMB-nog5G8U-xWlyw';

// Use window._sb to avoid naming conflict with the CDN's window.supabase
if (!window._sb) {
    window._sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
const sb = window._sb;
