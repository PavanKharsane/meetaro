# meetaro
Meetaro dating app with real-time chat, notifications, and video call signaling

## Run locally

```sh
npm ci
npm start
```

Open `http://localhost:3000`. For production, set `JWT_SECRET` to a unique random value of at least 32 characters.

## GitHub Actions

The CI workflow runs for pushes and pull requests targeting `main`, and can also be started manually from the Actions tab. It checks the server and browser JavaScript on Node.js 22 and 24, smoke-tests the HTTP app and protected API, and audits production dependencies.

Automatic deployment is not configured yet; choose a hosting provider before adding deployment steps and credentials.
