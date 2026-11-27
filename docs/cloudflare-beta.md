# Deploy a private beta on Cloudflare

Nuxt and Nitro run as a Worker. The single Basic container starts when an authenticated request needs media tools and sleeps after ten idle minutes. The app streams bounded MP4 files without an R2 bucket.

## Deployment prerequisites

- Workers Paid on the destination account.
- Workers Scripts Write and Workers Containers Write for the deployment credential. Setting up beta visitors also needs Cloudflare Access management rights.
- Node.js 24 and a Docker engine for local deploys. GitHub Actions provides these for the repository deployment workflow.

## GitHub Actions or local deployment

For GitHub Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository Actions secrets. Start **Deploy Cloudflare beta** from `main`. The build runs before the deploy step receives the token. Without Access settings the Worker denies requests and leaves the container idle.

For a local deployment, run these commands from the repository root with Docker running. Authenticate with Cloudflare using the browser flow.

```powershell
npm ci
npx cf auth login
npm run build:cloudflare
npm run deploy:cloudflare
```

## Enable beta access

Protect the `downloader-beta` Worker URL with a Cloudflare Access application and allow the intended testers. Record its [Application Audience tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag) and the team's hostname, such as `example.cloudflareaccess.com`.

Set `DOWNLOADER_ACCESS_AUD` and `DOWNLOADER_ACCESS_TEAM` as repository Actions **variables**, then run the deployment workflow again. For a local deploy, export the same environment variables before both build and deployment. Access supplies the browser's identity. The Worker also verifies signed assertions for requests routed through the Static Assets router.

Open the Worker URL as an invited tester. Check that an unauthenticated browser is challenged, then download the known Reel and a regular public video from the deployed app. [Release checks](release-checks.md) records the remaining hosted checks.
