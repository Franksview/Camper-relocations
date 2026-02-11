# 🚐 Camper Relocations

Find dirt-cheap campervan relocation deals across Europe (€1/day!). Live search across Imoova, Roadsurfer, Indie Campers, Movacar, Bunk Campers, and Spaceships.

## How It Works

1. User enters a route (e.g., Berlin → Barcelona)
2. The serverless API calls Claude with web search to scan provider websites
3. Real deals are returned with prices, dates, vehicle info, and booking links
4. Results are cached for 1 hour to save API costs

## Project Structure

```
camper-app/
├── api/
│   └── search.js        ← Serverless function (the backend)
├── public/
│   └── index.html        ← The frontend (single file, no build needed)
├── package.json
├── vercel.json           ← Vercel routing config
└── README.md
```

## Deploy to Vercel (5 minutes)

### Step 1: Get an Anthropic API Key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign in (same account as claude.ai)
3. Go to **API Keys** → **Create Key**
4. Copy the key (starts with `sk-ant-...`)

### Step 2: Push to GitHub
1. Create a new repository on [github.com](https://github.com/new)
2. Upload these files (drag & drop works) keeping the folder structure

Or use terminal:
```bash
cd camper-app
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/camper-relocations.git
git push -u origin main
```

### Step 3: Deploy on Vercel
1. Go to [vercel.com](https://vercel.com) and sign up with GitHub
2. Click **"Add New Project"**
3. Import your `camper-relocations` repository
4. In **Environment Variables**, add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your `sk-ant-...` key
5. Click **Deploy**

Your app will be live at `https://camper-relocations.vercel.app` (or similar).

## Costs

- **Vercel hosting**: Free (Hobby plan)
- **Anthropic API**: ~€0.01-0.03 per search (pay-as-you-go)
- **Free credits**: New API accounts get $5 free credit (~150-500 searches)

## Future Improvements

- [ ] Multi-leg trip chaining
- [ ] Email alerts for new deals on saved routes
- [ ] Price history tracking
- [ ] Direct provider API integrations (where available)
