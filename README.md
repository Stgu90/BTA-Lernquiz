# BTA Lernquiz

Live-Quiz ohne Anmeldung (PIN + Spitzname) und Solo-Training für mehrere Kurse.

## Aufbau
- `index.html`, `style.css`, `app.js` – die Seite (statisch, kein Build nötig)
- `config.js` – Verbindung zu Supabase Realtime (Projekt `bta-lernquiz`)
- `vendor/supabase.js` – Supabase-Bibliothek (lokal mitgeliefert)
- `data/courses.json` – Liste der Kurse
- `data/<kurs>.json` – Runden und Fragen eines Kurses

Aktuelle Kurse: `hr-ops` (HR Operations) und `ld` (Strategisches Learning & Development).

## Neuen Kurs anlegen
1. Datei `data/<kurs>.json` nach dem Muster von `data/hr-ops.json` anlegen:
   - `id`, `title`, `legal` (Hinweistext, optional)
   - `rounds`: `[{ "id": "fs", "label": "Tag 1", "title": "Future Skills", "color": "#2F6FD6" }]`
   - `questions`: `[{ "id": "fs-1", "round": "fs", "q": "Frage", "o": ["A","B","C","D"], "a": 0, "h": "Hinweis", "x": "Erklärung", "s": "Quelle" }]`
     (`a` = Index der richtigen Antwort ab 0, `h` = aufdeckbarer Hinweis, optional `t` = feste Sekundenzahl; sonst wird die Zeit aus der Textlänge berechnet)
2. In `data/courses.json` ergänzen: `{ "id": "l-and-d", "title": "Strategisches L&D", "subtitle": "BTA Weiterbildung", "file": "data/l-and-d.json" }`

## Lokal testen ohne Internet
`?local=1` an die Adresse hängen: Dann läuft die Live-Verbindung über den Browser selbst (mehrere Tabs im selben Browser).

## Glossar
Jeder Kurs kann in `data/courses.json` ein Feld `glossary` haben (z. B. `data/glossar-hr-ops.json`).
Einträge: `{k, t, d, p, r}` – `k` Bereich (`beg` Begriff, `abk` Abkürzung, `fri` Frist, `wer` Wert),
`t` Begriff, `d` Bedeutung, `p` Praxistipp/Grundlage/Hinweis, `r` Liste der Runden-IDs (Kurstage).
In „Allein üben“ erscheinen dann „Nachschlagen“ (Suche + Filter) und „Karteikarten“.
