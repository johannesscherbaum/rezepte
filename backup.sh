#!/bin/bash
# Rezepte-Backup: Datenbank (SQL), Bilder, Code
# Einplanen im Synology Task Scheduler (als root)
# Voraussetzung: Shared Folder "Backups" muss in DSM existieren

# ── Konfiguration ─────────────────────────────────────────────
BACKUP_ROOT="/volume1/Backups/rezepte"
RETENTION_DAYS=30

DB_CONTAINER="rezepte-db"
DB_NAME="rezepte"
DB_USER="rezepte"
DB_PASS="3Whq*jBmTPWtUKGp"

IMAGES_DIR="/volume1/docker/rezepte/data/images"
APP_DIR="/volume1/docker/rezepte/app"

DOCKER=$(command -v docker || echo "/usr/local/bin/docker")
# ──────────────────────────────────────────────────────────────

TIMESTAMP=$(date +"%Y%m%d_%H%M")
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"

# Backup-Verzeichnis anlegen
if ! mkdir -p "$BACKUP_DIR"; then
    echo "FEHLER: Konnte $BACKUP_DIR nicht anlegen." >&2
    echo "Bitte den Shared Folder 'Backups' zuerst in DSM erstellen." >&2
    exit 1
fi

LOG="${BACKUP_ROOT}/backup.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Backup gestartet: $TIMESTAMP ==="

# 1. Datenbank als SQL
log "Datenbank-Dump (docker: $DOCKER)..."
SQL_FILE="${BACKUP_DIR}/rezepte_db_${TIMESTAMP}.sql"
PGPASSWORD="$DB_PASS" $DOCKER exec -i "$DB_CONTAINER" \
    pg_dump -U "$DB_USER" "$DB_NAME" > "$SQL_FILE" 2>>"$LOG"
if [ $? -eq 0 ] && [ -s "$SQL_FILE" ]; then
    gzip "$SQL_FILE"
    log "DB OK: rezepte_db_${TIMESTAMP}.sql.gz ($(du -sh "${SQL_FILE}.gz" | cut -f1))"
else
    log "FEHLER: DB-Dump fehlgeschlagen (siehe Zeilen oben)"
    rm -f "$SQL_FILE"
fi

# 2. Bilder
log "Bilder sichern..."
if tar -czf "${BACKUP_DIR}/rezepte_images_${TIMESTAMP}.tar.gz" \
    -C "$(dirname "$IMAGES_DIR")" "$(basename "$IMAGES_DIR")" 2>>"$LOG"; then
    log "Bilder OK: rezepte_images_${TIMESTAMP}.tar.gz ($(du -sh "${BACKUP_DIR}/rezepte_images_${TIMESTAMP}.tar.gz" | cut -f1))"
else
    log "FEHLER: Bilder-Backup fehlgeschlagen"
fi

# 3. Code (ohne node_modules und .git)
log "Code sichern..."
if tar -czf "${BACKUP_DIR}/rezepte_app_${TIMESTAMP}.tar.gz" \
    --exclude="$(basename "$APP_DIR")/node_modules" \
    --exclude="$(basename "$APP_DIR")/.git" \
    -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")" 2>>"$LOG"; then
    log "Code OK: rezepte_app_${TIMESTAMP}.tar.gz ($(du -sh "${BACKUP_DIR}/rezepte_app_${TIMESTAMP}.tar.gz" | cut -f1))"
else
    log "FEHLER: Code-Backup fehlgeschlagen"
fi

# 4. Alte Backups aufräumen
log "Aufräumen (älter als ${RETENTION_DAYS} Tage)..."
find "$BACKUP_ROOT" -maxdepth 1 -type d -name "20*" -mtime "+${RETENTION_DAYS}" -print | while read -r old; do
    rm -rf "$old"
    log "Gelöscht: $old"
done

TOTAL=$(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)
log "=== Backup abgeschlossen: $BACKUP_DIR (gesamt: $TOTAL) ==="
