# Deploy a private beta on Cloudflare

The Cloudflare Worker in `cloudflare/` forwards requests to one Basic container built from the repository's `Dockerfile.web`. Both inspection and download go to the same container because download options are held in app memory. The container sleeps after ten minutes without activity. A container restart expires the options and users can check the link again.

## Prerequisites

- Workers Paid on the Cloudflare account.
- Cloudflare access to deploy Workers and Containers and to manage Cloudflare Access for this beta Worker.
- Docker Desktop running Linux containers, or a Docker engine on the deployment machine, plus Node.js 24. Run `docker info` to verify the engine.

## Deploy the Worker and container

Run these commands from the repository root. `cf auth login` opens Cloudflare in a browser to approve CLI access.

```powershell
cd cloudflare
npm ci
npx cf auth login
npm run deploy
```

The first deployment creates `downloader-beta` and its `workers.dev` URL. With no Access audience configured, the Worker responds with `503` before starting the container. The Cloudflare build check in GitHub Actions builds the Worker and container without publishing them.

## Allow beta testers

1. In **Workers & Pages**, open `downloader-beta` and use [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-one-worker) to protect this Worker's deployed URL. Allow only the testers' email addresses in the Access policy.
2. In Zero Trust, open that Access application and copy its [Application Audience tag](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/#get-your-aud-tag).
3. Pass the tag when you redeploy. The Worker checks the audience supplied by Cloudflare Access before starting or forwarding a request to the container.

```powershell
$env:DOWNLOADER_ACCESS_AUD = 'paste-your-application-audience-tag'
npm run deploy
```

On Bash, use `export DOWNLOADER_ACCESS_AUD='paste-your-application-audience-tag'` before deploying. Keep the value set for subsequent deployments so they retain the same Access audience. It identifies the Access app. Testers use Cloudflare Access only to enter the beta and use guest access to Facebook through Downloader.

## Verify the deployed app

Open the deployed URL in an incognito window and confirm Cloudflare presents the Access sign-in. Sign in as an allowed tester, then use the exact Reel link from the local verification and a regular public Facebook video. Save and open each MP4 on a phone. See the [remaining release checks](release-checks.md) before opening public access.
