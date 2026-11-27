# Deploy Downloader on Cloudflare

Nuxt and Nitro run as a public Worker. The single Basic container starts when a valid media request needs extraction and sleeps after two idle minutes by default. Set the repository Actions variable `DOWNLOADER_IDLE_MINUTES` to `10` and redeploy to restore the longer timeout. The app streams bounded MP4 files without an R2 bucket.

The public app uses `downloader.angder.app`. Cloudflare creates its DNS record and certificate when the Worker domain is attached.

## Deployment prerequisites

- Workers Paid on the account that manages the `angder.app` zone.
- Workers Scripts Write and Workers Containers Write for the deployment credential, with access to the domain's zone.
- Node.js 24 and a Docker engine for local deploys. GitHub Actions provides these for the repository deployment workflow.

## GitHub Actions or local deployment

For GitHub Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository Actions secrets. Start **Deploy Downloader** from `main`. Changes to the deployment workflow, Cloudflare configuration, or media API routes on `main` also start a deploy. The deployment checks that the homepage responds without credentials and the API rejects unsupported links.

For a local deployment, run these commands from the repository root with Docker running. Authenticate with Cloudflare using the browser flow.

```powershell
npm ci
npx cf auth login
npm run build:cloudflare
npm run deploy:cloudflare
```

## Verify a download

Open `downloader.angder.app` in a fresh browser session, then download the known Reel and a regular public video from the deployed app. [Release checks](release-checks.md) records the remaining hosted checks.
