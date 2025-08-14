Deploying the web app on Netlify

Build settings:
- Base directory: apps/web
- Build command: npm run build
- Publish directory: apps/web/dist

Environment variables (recommended):
- VITE_API_URL: your API base URL (e.g., https://api.yourdomain.com)

Local development:
```bash
npm install
npm run dev -w apps/web
```


