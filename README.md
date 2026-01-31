# GitHub Pages Frontend (Wudai Relations)

## Files to upload to your GitHub repo root
- index.html
- admin.html
- style.css
- app.js

## Configure API base (Worker URL)
After you deploy the Cloudflare Worker, set this once in the browser console:
  localStorage.setItem("WUDAI_API_BASE","https://<your-worker>.workers.dev");
Then refresh the page.

## Admin
Admin is handled by Cloudflare Access on the Worker routes:
- /api/admin/ping
- /api/admin/export
- /api/admin/import

Open admin.html and click "Sign in / Verify Access".
