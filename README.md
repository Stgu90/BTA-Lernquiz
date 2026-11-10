# BTA Lernquiz

Live-Quiz ohne Anmeldung (PIN + Spitzname) und Solo-Training für mehrere Kurse.

## Aufbau
- `index.html`, `style.css`, `app.js` – die Seite (statisch, kein Build nötig)
- `config.js` – Verbindung zu Supabase Realtime (Projekt `bta-lernquiz`)
- `vendor/supabase.js` – Supabase-Bibliothek (lokal mitgeliefert)
- `data/courses.json` – Liste der Kurse
- `data/<kurs>.json` – Runden und Fragen eines Kurses

## Neuen Kurs anlegen (z. B. L&D)
1. Datei `data/l-and-d.json` nach dem Muster von `data/hr-ops.json` anlegen:
   - `id`, `title`, `legal` (Hinweistext, optional)
   - `rounds`: `[{ "id": "fs", "label": "Tag 1", "title": "Future Skills", "color": "#2F6FD6" }]`
   - `questions`: `[{ "id": "fs-1", "round": "fs", "q": "Frage", "o": ["A","B","C","D"], "a": 0, "h": "Hinweis", "x": "Erklärung", "s": "Quelle" }]`
     (`a` = Index der richtigen Antwort ab 0, `h` = aufdeckbarer Hinweis, optional `t` = feste Sekundenzahl; sonst wird die Zeit aus der Textlänge berechnet)
2. In `data/courses.json` ergänzen: `{ "id": "l-and-d", "title": "Strategisches L&D", "subtitle": "BTA Weiterbildung", "file": "data/l-and-d.json" }`

## Lokal testen ohne Internet
`?local=1` an die Adresse hängen: Dann läuft die Live-Verbindung über den Browser selbst (mehrere Tabs im selben Browser).
