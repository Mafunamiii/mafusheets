# MafuSheets

MafuSheets is a personal music sheet library and viewer for PDFs, images, and chord charts.

## What it does

- Upload and organize music sheets
- Tag entries with fully custom labels
- Store page-based annotations
- Search by title, artist, tags, notes, filename, and extracted text
- Preview PDFs, images, and text-based chord charts in the browser
- Use a built-in visual metronome for rehearsal or mass
- Sign in as an admin to access the entire library, reader, uploads, downloads, and maintenance tools

## Run locally

```bash
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000`.

The server loads `.env` automatically if it exists. Use `.env.example` as the template for local runs and deployments.

## Run with Docker Compose

```bash
docker compose up --build
```

Compose also reads the same `.env` file, so the same values work in both local and container runs.

The admin panel also includes a "Refresh thumbnails" action for older entries that were created before thumbnails were generated automatically.


## Deployment

The repository includes a portable `deploy.sh` that defaults to:

- values from `.env`

Examples:

```bash
./deploy.sh
./deploy.sh --skip-install
./deploy.sh --pull
```

If you want to override any setting, export it before running the script or pass a different `ENV_FILE`:

```bash
REMOTE_HOST=deploy@159.223.66.236 APP_NAME=mafusheets ./deploy.sh
ENV_FILE=.env.production ./deploy.sh
```

## Storage

The app stores files in:

- `uploads/documents`
- `uploads/photos`
- `uploads/slides`
- `data/resources.json`

Back up `uploads/` and `data/resources.json` together.

## Notes

- Annotations are page-based, not coordinate-based.
- The metronome is visual only, so it works in quiet settings.
- The whole app is behind login now; unauthenticated visitors only see the login screen.
- Chord-providing website content is best saved as text, PDF, or a user-managed export that you upload here.
- On tablets and smaller screens, use the separate Add sheet tab instead of keeping the upload form visible beside the library.
