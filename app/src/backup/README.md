# Backup of the SQLite database

The whole state of an instance is one SQLite file (`/data/app.db`). This folder backs it up every
day, keeps a bounded number of backups, and restores one. Nothing else in the app may copy the
database file: a plain copy of a live WAL database is not a backup (see below).

| File                   | Role                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `create-backup.ts`     | One backup: `VACUUM INTO` a temporary file, verify, flush, publish under its final name             |
| `retention.ts`         | The retention rule as a pure function (`planRotation`)                                              |
| `rotate.ts`            | Deletes what `planRotation` names, nothing else                                                     |
| `run-backup.ts`        | The job: a backup, then the rotation; logs path and size only                                       |
| `restore.ts`           | Puts a backup back as the database                                                                  |
| `cli.ts`               | `node backup/cli.ts backup` and `restore <file>`; for Coolify, for operators, for the restore guide |
| `scheduler.ts`         | The daily timer inside the app (production only), started from `src/instrumentation.ts`             |
| `status.ts`, `http.ts` | `GET /api/backup/status` (needs a session): schedule, target, last run, newest backup               |
| `config.ts`            | `BACKUP_DIR`, `BACKUP_TIME` (and `DATABASE_PATH`, read with the database layer's default)           |

This folder opens SQLite itself (better-sqlite3 directly, `VACUUM INTO`, `PRAGMA integrity_check`),
unlike the rest of the app, which goes through `src/db/`. It has to: the command line runs without
Next.js and without the app's database layer, and a backup must not depend on the migrations.

## How a backup is made

1. The source must exist and be a SQLite file, the target directory must exist, be writable and lie
   outside the database's directory (a backup next to the data is lost with it: `BACKUP_TARGET_INSIDE_DATA`).
2. An empty file with mode `0600` is created under a temporary name in the target
   (`.code-reviewer-<random>.tmp`), so the data is never readable by others, not even briefly.
3. `VACUUM INTO` writes the database into it. It reads inside one read transaction, so the result
   is the committed state at one moment, including everything still in the `-wal` file, while the
   app keeps writing. The result is one compact file in rollback-journal mode; the app switches a
   restored file back to WAL when it opens it.
4. `PRAGMA integrity_check` must answer `ok`, else the file is discarded (`BACKUP_VERIFY_FAILED`).
5. The file is flushed to disk and gets its final name `code-reviewer-YYYYMMDDTHHMMSSZ.db` (UTC) by a
   hard link, which fails if the name exists: an earlier backup is never overwritten, a second one in
   the same second becomes `...Z-2.db`. Without hard links (some network file systems) an existence
   check and a rename do the same.

Any failure removes the temporary file; the directory holds a complete backup or none. A temporary
file left by a crashed run is removed by the next run once it is an hour old.

Do not copy `app.db` with `cp` or a volume snapshot tool while the app runs: the newest writes live in
`app.db-wal`, and a copy taken during a write can mix old and new pages. Back up the files this job
writes.

## Retention

7 daily and 4 weekly backups (decision of the project lead). Exactly, a backup is kept if it is

- the newest backup (the last way back is never deleted), or
- younger than 24 hours (a manual backup before an upgrade stays for a day), or
- the newest of its UTC day, for the 7 most recent days that have a backup, or
- the newest of its week (Monday to Sunday, UTC), for the 4 most recent weeks that have a backup.

Days and weeks are counted among those that have a backup, so a pause (the app was down for two
weeks) never deletes the history. In steady state this is about a month of history. Files whose name
does not match the backup pattern are never listed, never deleted. The rotation runs only after a
backup succeeded: a failing backup never shrinks the history.

## Settings

| Variable      | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `BACKUP_TIME` | Time of the daily backup, `HH:MM` in UTC. Default `02:30`. `off` switches the scheduler off.      |
| `BACKUP_DIR`  | Target directory. The image fixes it to `/backups` (a volume of its own); do not change it there. |

An invalid `BACKUP_TIME` stops the start with `BACKUP_CONFIG_INVALID` (a typo must not become "no
backups"). If the target cannot be written to when the app starts, an error line says so and the app
keeps running; the status route shows the same problem. `BACKUP_TIME` is read only by the scheduler:
the `backup` and `restore` commands ignore it, so a typo there never blocks a restore. An invalid `BACKUP_TIME` stops the app at the start in production, before the database is opened and before the repositories are synchronized, with one line that names the variable and the format (`HH:MM` in UTC, or `off`).

## Where the backups are, and getting them off the server

With Docker Compose the backups live in the named volume `backups` (mounted at `/backups`), next to the
volume `data`. That is separate from the app container: a redeploy, an image update or
`docker compose down` keeps both. It is not yet a backup against losing the server or its disk.

To get the backups off the machine, mount `/backups` from a directory of the host and copy that
directory somewhere else:

1. With Docker Compose (`compose.yml`): mount a directory of the host instead of the volume by replacing
   `backups:/backups` by `/var/backups/code-reviewer:/backups`. Create the host directory beforehand and
   give it to the app user: `chown 10001:10001 /var/backups/code-reviewer` and `chmod 700`. On Coolify the
   Compose file is the source of truth for the mounts of a _Docker Compose_ application (nothing is added
   under Persistent Storage there), and `compose.coolify.yml` should not be edited for this; copy the
   named volume's directory on the host instead, `/var/lib/docker/volumes/<name>_backups/_data` (see
   `docs/deployment-coolify.md`, section 8).
2. Copy that directory off the server with a tool of your choice, run on the host (for example a
   cron job with `rsync`, `rclone` or `restic` to another server or an object storage). Coolify
   also documents scheduled backups of storage volumes to an S3 destination ([Coolify: backups of
   storage mounts](https://coolify.io/docs/core/persistent-storage/storage-mounts/backups)); that
   would suit the `backups` volume (finished files), never the `data` volume (a live database file).
   Whether a Coolify version offers it for a volume that a Compose file declares is not verified,
   which is why the copy from the host above is the way this documentation relies on. Backup files contain
   sessions and stored tokens: copy them only to places that are as protected as the server, and
   encrypt them if they go further (`restic` does).

Not verified on a real Coolify instance yet (see "Restore trials").

## Scheduling on Coolify

The app runs the job itself every day at `BACKUP_TIME` (default 02:30 UTC); nothing has to be set up.
That timer lives in the app process: a run is missed when the app is down at that time and not
caught up (the status route says `stale` once the newest backup is older than a day and a half).

If you prefer Coolify to run it, or want a second trigger, create a Scheduled Task on the
application: command `node /srv/app/backup/cli.ts backup`, container `app`, frequency for example
`30 2 * * *`, and set `BACKUP_TIME=off` so the two do not both run. The command exits with 1 and prints
one line with an error code when the backup fails, which Coolify shows as a failed execution of the
task. Run the same command by hand with `docker compose exec app node backup/cli.ts backup`.

A failed scheduled run is logged as `[backup] <CODE>: <message>` (error level) and shown by
`GET /api/backup/status` (`lastRun`, `target`, `stale`; only stable error codes, never paths or error
text, which stay in the log). `stale` looks at the newest backup in the directory, whoever made it:
with `BACKUP_TIME=off` and a Coolify task that fails every night it turns true after a day and a half. A page that shows this status in the settings
UI does not exist yet. There is no external alerting in the MVP.

## Restore

The app must be stopped: a restore replaces the file the app has open. The command checks the backup
first (`PRAGMA integrity_check`) and stops before touching anything if it fails. It also refuses
(`RESTORE_FAILED`, "in use") when another process still has the database open, which is what a
running app is. Otherwise the current database is moved aside, not deleted, under a name that never
replaces an earlier one (`app.db.before-restore-<time>`, with `-2`, `-3` added when it is taken).

1. Pick the backup (newest first): `ls -t /backups`. If it is on another machine, put it into the
   backup directory of the server first, owned by uid 10001 with mode `0600`.
2. Stop the app (Coolify: Stop; Compose: `docker compose stop app runner`).
3. Run the restore in a one-off container of the same image with the same volumes:

   ```
   # Docker Compose
   docker compose run --rm --no-deps app node backup/cli.ts restore /backups/code-reviewer-20261010T023000Z.db

   # Coolify (or any Docker host): use the image of the application and the data and backup
   # storage names or paths shown under Persistent Storage (or `docker volume ls`)
   docker run --rm --user 10001:10001 -v <data volume>:/data -v <backups volume or host path>:/backups \
     <app image> node /srv/app/backup/cli.ts restore /backups/code-reviewer-20261010T023000Z.db
   ```

   It prints where the previous database was kept (`app.db.before-restore-<time>`, with its
   `-journal`, `-wal` and `-shm` files if there were any).

4. Start the app. Check `/api/health`, sign in, look at the projects. Pending migrations of a newer
   image run at the start as usual.
5. When the data is confirmed, delete the `app.db*.before-restore-*` files from the data volume.

The copy of the backup is made next to the database under a temporary name, created readable by its
owner only (mode `0600`) before the first byte is written, whatever the umask and the mode of the
backup file. It is checked again before it becomes the database.

**A leftover `app.db-wal` next to a restored `app.db`.** The restore command moves the old database
aside together with its `-journal`, `-wal` and `-shm` files, so none is left. If you put a backup in place by
hand and an old `app.db-wal` stays next to it, SQLite does not ask: it takes the log over when it
opens the database, replaying changes of the old database into the restored one (which then holds
writes that are not in the backup), or it discards the log if it does not fit. Which of the two
happens cannot be known beforehand, so never start the app with such a file there: stop the app, move
`app.db`, `app.db-wal` and `app.db-shm` aside, and only then copy the backup in as `app.db`. A backup
file itself never has a `-wal`. A leftover `-journal` (a rollback journal of an interrupted write)
is the same hazard: SQLite rolls it back into whatever file has the name.

One more thing the restore does with a leftover `-wal`: the in-use check (step before the old
database is moved aside) opens the old database to see whether another process holds it. Opening a
database with a `-wal` next to it is what makes SQLite replay that log into the old database, or
delete it when it does not fit, and a leftover `-journal` is rolled back or deleted the same way.
That happens to the old database only, before it is moved aside, so the kept copy
(`app.db.before-restore-<time>`) can already contain the replayed writes, and a leftover `-wal` or
`-journal` may be gone from the data directory by the time the command prints where the old database
went. Nothing of it reaches the restored database.

If the restore stops with `RESTORE_BACKUP_INVALID` the file is damaged (truncated copy, bad
transfer): try the next older backup. The database is unchanged in that case.

### Restore trials

| Date       | Where                                                                   | Result                                                                                                     |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 2026-10-10 | Docker Compose stack of `docker/smoke/compose.sh` (automated)           | Backup of the running stack, data volume removed, restore as in step 3, app healthy, data present. Passed. |
| open       | Coolify instance, from a backup that came back from the external target | To be done by a team member following only this guide (CR-40-T15); enter date and result here.             |

## Errors

| Code                        | Meaning                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `BACKUP_CONFIG_INVALID`     | `BACKUP_TIME` is not `HH:MM` or `off`                                                                         |
| `BACKUP_SOURCE_MISSING`     | the database file does not exist (check `DATABASE_PATH`, is the data volume mounted?)                         |
| `BACKUP_SOURCE_INVALID`     | the database file is not a SQLite database                                                                    |
| `BACKUP_SOURCE_LOCKED`      | another process kept the database locked for longer than 10 seconds                                           |
| `BACKUP_TARGET_UNAVAILABLE` | the target does not exist, is not a directory or cannot be written to                                         |
| `BACKUP_TARGET_INSIDE_DATA` | the target lies inside the database's directory                                                               |
| `BACKUP_WRITE_FAILED`       | writing failed, for example a full disk; nothing was published                                                |
| `BACKUP_VERIFY_FAILED`      | the new file failed `integrity_check`; it was discarded                                                       |
| `RESTORE_BACKUP_MISSING`    | the file to restore does not exist                                                                            |
| `RESTORE_BACKUP_INVALID`    | the file to restore failed `integrity_check`; nothing was changed                                             |
| `RESTORE_FAILED`            | the data directory is unusable, the database is in use, or the swap failed; the previous database is in place |
| `BACKUP_STATUS_UNAVAILABLE` | the status route could not read the status (served instead of an error text)                                  |

The command exits with 0, 1 (the job failed, one line on stderr) or 2 (wrong command line). Logs name
paths, sizes and error codes, never data from the database. No HTTP route serves a backup file.

## Known limits

- `VACUUM INTO` and the integrity check are synchronous: the app's event loop waits while the daily
  job runs. For the size of this database that is milliseconds to a second; revisit when the file
  grows into hundreds of megabytes (then run the command as a Coolify task instead).
- One scheduler per instance: two app processes on one database would both run it (harmless, the
  names differ, the rotation treats them alike).
- The backups are not encrypted; they are protected by file mode `0600` and by where they are stored.
