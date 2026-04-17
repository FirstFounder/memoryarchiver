# Memory Archiver

Personal home-server monorepo with a Fastify backend and React frontend for archive workflows, device dashboards, and Tesla connectivity tooling.

## Development

1. Copy [.env.example](/Users/jrennert/code/memoryarchiver/.env.example) to `.env` and adjust paths/flags for your machine.
2. Start the backend with `npm run dev:backend`.
3. Start the frontend with `npm run dev:frontend`.

## Tesla Environment Variables

Set these in `.env` when enabling the Tesla Phase 0 infrastructure:

```bash
TESLA_ENABLED=true
TESLA_CLIENT_ID=
TESLA_CLIENT_SECRET=
TESLA_REDIRECT_URI=
TESLA_FLEET_API_BASE=https://fleet-api.prd.na.vn.cloud.tesla.com
TESLA_AUTH_BASE=https://fleet-auth.prd.vn.cloud.tesla.com
TESLA_PRIVATE_KEY_PATH=/var/services/homes/philander/infra/secrets/tesla_private_key.pem
WEATHER_LAT=41.8827
WEATHER_LON=-87.7538
```

`TESLA_ENABLED=true` gates both the backend routes and the frontend Garage/Tesla UI.
`WEATHER_LAT` and `WEATHER_LON` default to Cicero, IL if omitted.
