# Rezepte-App

Vollständiges Rezept-Management-System mit Login, 2FA, Rollenverwaltung,
URL-Import via Claude AI, Evernote-Import, Tag-Clouds und Kategorien.

## Verzeichnisstruktur auf der Synology

```
/volume1/docker/rezepte/
├── app/                    ← Quellcode (diese Dateien)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── backend/
│   │   ├── package.json
│   │   ├── server.js
│   │   ├── db.js
│   │   ├── middleware/
│   │   │   └── auth.js
│   │   ├── routes/
│   │   │   ├── auth.js
│   │   │   ├── users.js
│   │   │   ├── recipes.js
│   │   │   └── misc.js
│   │   └── services/
│   │       └── crawler.js
│   └── frontend/
│       └── public/
│           └── index.html
├── db/                     ← PostgreSQL-Daten (auto-erstellt)
└── data/                   ← Bilder & Uploads (auto-erstellt)
    └── images/
```

## Setup

### 1. Ordner anlegen (SSH oder File Manager)
```bash
mkdir -p /volume1/docker/rezepte/{app,db,data/images}
```

### 2. Dateien kopieren
Den `rezepte`-Ordner nach `/volume1/docker/rezepte/app/` kopieren.

### 3. docker-compose.yml anpassen
Unbedingt vor dem ersten Start ändern:
- `POSTGRES_PASSWORD` und `DB_PASSWORD` (beide gleich)
- `JWT_SECRET` → langer Zufallsstring (z.B. `openssl rand -hex 32`)
- `ANTHROPIC_API_KEY` → deinen API-Key
- `ADMIN_PASSWORD` → initiales Admin-Passwort (wird nur beim allerersten Start gesetzt)

### 4. In Portainer deployen

**Option A: Stack via Web Editor**
1. Portainer → Stacks → Add Stack
2. Name: `rezepte`
3. Web Editor: Inhalt der `docker-compose.yml` einfügen
4. Deploy

**Option B: Stack via Repository**
Falls du Git nutzt.

### 5. App aufrufen
```
http://<synology-ip>:3020
```
Login: `admin` / (dein `ADMIN_PASSWORD`)

## Erste Schritte nach dem Login

1. **Passwort ändern**: Profil → Passwort ändern
2. **2FA einrichten**: Profil → 2FA einrichten
3. **Weitere Benutzer anlegen**: Admin → Benutzerverwaltung

## Benutzerrollen

| Rolle | Rezepte lesen | Rezepte anlegen/bearbeiten | Admin-Bereich |
|-------|:---:|:---:|:---:|
| readonly | ✅ | ✗ | ✗ |
| readwrite | ✅ | ✅ | ✗ |
| admin | ✅ | ✅ | ✅ |

## Externe Freigabe

Für externen Zugriff empfehle ich einen Reverse Proxy:
- **Synology Reverse Proxy**: Systemsteuerung → Anmeldungsportal → Reverse Proxy
  - Quell-URL: `https://rezepte.deine-domain.de`
  - Ziel: `http://localhost:3020`
- **Nginx Proxy Manager** (als Docker-Container)
- **Traefik**

Rezepte können einzeln als "Öffentlich" markiert werden – diese sind dann
ohne Login sichtbar (sinnvoll wenn du die App extern freigibst).

## URL-Import (Claude AI)

Im Editor auf "+ Rezept" → URL in das Feld oben eingeben → "Holen".
Claude analysiert die Seite und füllt alle Felder automatisch aus (Zutaten,
Schritte, Kategorie, Tags, Bild). Bitte kurz prüfen und dann speichern.

Benötigt einen gültigen `ANTHROPIC_API_KEY`.

## Evernote-Import

ENEX-Dateien pro Notizbuch exportieren und über den Evernote-Tab importieren.
Die Notizbuchstruktur bleibt erhalten.

## Ports

| Port | Dienst |
|------|--------|
| 3020 | Web-App (extern) |
| 5432 | PostgreSQL (intern, nicht exponiert) |

Port 3020 in der `docker-compose.yml` anpassbar.

## Daten sichern

```bash
# PostgreSQL-Backup
docker exec rezepte-db pg_dump -U rezepte rezepte > /volume1/docker/rezepte/backup_$(date +%Y%m%d).sql

# Bilder sichern
rsync -av /volume1/docker/rezepte/data/ /volume1/backup/rezepte-data/
```
